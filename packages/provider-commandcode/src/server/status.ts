import {
  type ProviderOptionDescriptor,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { CommandcodeSettings } from "../settings.ts";
import * as NodeOS from "node:os";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  COMMANDCODE_DRIVER_KIND,
  COMMANDCODE_SUPPORTED_RUNTIME_MODES,
  commandcodeBinaryPath,
} from "./acpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const COMMANDCODE_PRESENTATION = {
  displayName: "Command Code",
  showInteractionModeToggle: true,
  supportedRuntimeModes: COMMANDCODE_SUPPORTED_RUNTIME_MODES,
} as const;
const COMMANDCODE_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

/** The ACP config option id and label Command Code uses for reasoning effort (as fx does). */
const COMMANDCODE_EFFORT_CONFIG_ID = "effort";

const commandcodeEffortDescriptor = (efforts: ReadonlyArray<string>): ProviderOptionDescriptor => ({
  id: COMMANDCODE_EFFORT_CONFIG_ID,
  label: "Effort",
  type: "select",
  // The session always offers a synthetic `default` first (the model's own level).
  options: [...new Set(["default", ...efforts])].map((value) => ({
    id: value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
  })),
});

const commandcodeCapabilitiesForEfforts = (
  efforts: ReadonlyArray<string> | null | undefined,
): ServerProviderModel["capabilities"] => {
  const levels = efforts?.filter((value) => nonEmptyTrimmed(value) !== undefined) ?? [];
  return levels.length > 0
    ? createModelCapabilities({ optionDescriptors: [commandcodeEffortDescriptor(levels)] })
    : COMMANDCODE_MODEL_CAPABILITIES;
};

/** One row of Command Code's own catalog cache; see commandcodeCatalogModels. */
const CatalogModelEntry = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  display: Schema.optional(Schema.Struct({ label: Schema.optional(Schema.String) })),
  aliases: Schema.optional(Schema.Array(Schema.String)),
  reasoningEfforts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
type CatalogModelEntry = typeof CatalogModelEntry.Type;

/**
 * The cache envelope: `{ body: { data: [...] } }` from cacheVersion 3, tolerated
 * also as a top-level `data` or `{ catalog: { models } }`.
 */
const CatalogCacheEnvelope = Schema.Struct({
  body: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.Array(CatalogModelEntry)) })),
  data: Schema.optional(Schema.Array(CatalogModelEntry)),
  catalog: Schema.optional(
    Schema.Struct({ models: Schema.optional(Schema.Array(CatalogModelEntry)) }),
  ),
});
const decodeCatalogEntryArray = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(CatalogModelEntry)),
);
const decodeCatalogEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(CatalogCacheEnvelope),
);

const decodeCatalogCacheFile = (raw: string): Option.Option<ReadonlyArray<CatalogModelEntry>> => {
  // A bare array is only reachable when the cache stored the list unwrapped.
  if (raw.trimStart().startsWith("[")) {
    return decodeCatalogEntryArray(raw);
  }
  return Option.map(
    decodeCatalogEnvelope(raw),
    (envelope) => envelope.body?.data ?? envelope.data ?? envelope.catalog?.models ?? [],
  );
};

/** Where the Command Code CLI keeps the catalog behind `/model`, per user home. */
const commandcodeModelCatalogDir = (environment: NodeJS.ProcessEnv): string =>
  `${
    environment.HOME ?? environment.USERPROFILE ?? NodeOS.homedir()
  }/.commandcode/cache/model-catalog/v1`;

const CATALOG_FILE_PATTERN = /^catalog-.*\.json$/u;

/**
 * Reads the newest local catalog cache so the model picker lists what `/model`
 * lists without opening an ACP session; a missing or unreadable cache yields
 * nothing and the probe keeps today's Default-only behavior.
 */
const commandcodeCatalogModels = Effect.fn("commandcodeCatalogModels")(function* (
  cacheDir: string,
): Effect.fn.Return<ReadonlyArray<CatalogModelEntry>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs
    .readDirectory(cacheDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const files = names.filter((name) => CATALOG_FILE_PATTERN.test(name));
  if (files.length === 0) return [];
  const mtimes = yield* Effect.forEach(files, (name) =>
    fs.stat(`${cacheDir}/${name}`).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? 0),
      Effect.orElseSucceed(() => 0),
    ),
  );
  let newest: { readonly name: string; readonly mtime: number } | undefined;
  for (const [index, mtime] of mtimes.entries()) {
    const name = files[index];
    if (name !== undefined && (newest === undefined || mtime > newest.mtime)) {
      newest = { name, mtime };
    }
  }
  if (newest === undefined) return [];
  const raw = yield* fs
    .readFileString(`${cacheDir}/${newest.name}`)
    .pipe(Effect.orElseSucceed(() => null));
  if (raw === null) return [];
  const decoded = decodeCatalogCacheFile(raw);
  return Option.getOrUndefined(decoded) ?? [];
});

const commandcodeCatalogModel = (entry: CatalogModelEntry): ServerProviderModel | undefined => {
  const id = nonEmptyTrimmed(entry.id);
  if (id === undefined || id === "default") return undefined;
  const label = nonEmptyTrimmed(entry.display?.label) ?? nonEmptyTrimmed(entry.name) ?? id;
  const aliases = (entry.aliases ?? []).flatMap((alias) => nonEmptyTrimmed(alias) ?? []);
  return {
    slug: id,
    name: label,
    ...(aliases.length > 0 ? { aliases } : {}),
    isCustom: false,
    capabilities: commandcodeCapabilitiesForEfforts(entry.reasoningEfforts),
  };
};

/**
 * "Default" keeps the session's current model (`cmd acp` reports it live); every
 * other row comes from the local catalog cache, each carrying its own effort
 * options exactly as `/effort` offers them in the terminal.
 */
const commandcodeModels = (
  settings: CommandcodeSettings,
  defaultModel: string | undefined,
  catalog: ReadonlyArray<CatalogModelEntry>,
): ReadonlyArray<ServerProviderModel> => {
  const currentEfforts = catalog.find((entry) => entry.id === defaultModel)?.reasoningEfforts;
  const seen = new Set(["default"]);
  const catalogModels = catalog.flatMap((entry) => {
    const model = commandcodeCatalogModel(entry);
    if (model === undefined || seen.has(model.slug)) return [];
    seen.add(model.slug);
    return [model];
  });
  return providerModelsFromSettings(
    [
      {
        slug: "default",
        name: defaultModel === undefined ? "Default" : `Default (${defaultModel})`,
        isCustom: false,
        isDefault: true,
        capabilities:
          currentEfforts === undefined
            ? COMMANDCODE_MODEL_CAPABILITIES
            : commandcodeCapabilitiesForEfforts(currentEfforts),
      },
      ...catalogModels,
    ],
    settings.customModels,
    COMMANDCODE_MODEL_CAPABILITIES,
  );
};

const snapshot = (
  settings: CommandcodeSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  defaultModel?: string,
  catalog: ReadonlyArray<CatalogModelEntry> = [],
): ServerProviderDraft => ({
  ...buildServerProvider({
    driver: COMMANDCODE_DRIVER_KIND,
    presentation: COMMANDCODE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: commandcodeModels(settings, defaultModel, catalog),
    probe,
    // Live `available_commands_update` payloads (the only channel; the
    // initialize response carries none) merge per cwd in `snapshotForCwd`.
    // Until the first session reports, the `/` menu offers compact only.
    slashCommands: [COMPACT_SLASH_COMMAND],
  }),
  // Text generation runs `cmd -p --no-session`, which persists nothing on disk.
  supportsTextGeneration: true,
});

export const buildInitialCommandcodeProviderSnapshot = (
  settings: CommandcodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Command Code CLI availability..."
        : "Command Code is disabled in T3 Code settings.",
    }),
  );

const runCommandcodeCli = Effect.fn("runCommandcodeCli")(function* (
  settings: CommandcodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const command = commandcodeBinaryPath(settings.binaryPath, platform);
  const startedAt = yield* DateTime.now;
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  const result = yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
  const finishedAt = yield* DateTime.now;
  return {
    result,
    resolved: spawnCommand.resolved,
    elapsedMs: DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(startedAt),
  };
});

/** `cmdc status --json`: `authenticated` plus the signed-in user and running version. */
const CommandcodeStatusSchema = Schema.fromJsonString(
  Schema.Struct({
    authenticated: Schema.Boolean,
    version: Schema.optional(Schema.String),
    user: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
  }),
);
type CommandcodeStatus = typeof CommandcodeStatusSchema.Type;
const decodeCommandcodeStatus = Schema.decodeUnknownOption(CommandcodeStatusSchema);

const VERSION_PROBE_TIMEOUT_MS = 10_000;

const probeFailureDetail = (
  failure: unknown,
  stderrTail: string | undefined,
): string | undefined => {
  const description =
    typeof failure === "string" && failure.trim().length > 0
      ? failure.trim().replace(/\s+/gu, " ")
      : failure != null &&
          typeof failure === "object" &&
          "message" in failure &&
          typeof (failure as { readonly message: unknown }).message === "string" &&
          (failure as { readonly message: string }).message.trim().length > 0
        ? (failure as { readonly message: string }).message.trim().replace(/\s+/gu, " ")
        : "spawn failed";
  const tail = stderrTail !== undefined && stderrTail.length > 0 ? ` - ${stderrTail}` : "";
  return `${description}${tail}`;
};

const truncateTail = (output: string, maxLength = 200): string => {
  const trimmed = output.trim().replace(/\s+/gu, " ");
  return trimmed.length > maxLength ? `…${trimmed.slice(-maxLength)}` : trimmed;
};

function commandcodeAuth(
  authenticated: boolean | undefined,
  user: string | undefined,
): ServerProviderAuth {
  if (authenticated === undefined) return { status: "unknown" };
  if (!authenticated) return { status: "unauthenticated" };
  const label = nonEmptyTrimmed(user);
  return label === undefined ? { status: "authenticated" } : { status: "authenticated", label };
}

/**
 * Reads `cmdc --version` and `cmdc status --json` (login state and current
 * model). Neither opens an ACP session, which Command Code would save.
 */
export const checkCommandcodeProviderStatus = Effect.fn("checkCommandcodeProviderStatus")(
  function* (
    settings: CommandcodeSettings,
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return snapshot(settings, checkedAt, {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Command Code is disabled in T3 Code settings.",
      });
    }
    const binary = commandcodeBinaryPath(settings.binaryPath, platform);

    const versionResult = yield* runCommandcodeCli(
      settings,
      ["--version"],
      environment,
      platform,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(versionResult)) {
      if (isCommandMissingCause(versionResult.failure)) {
        return snapshot(settings, checkedAt, {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            "Command Code is not installed or not on PATH. Install it with `npm i -g command-code`.",
        });
      }
      const diagnosis = probeFailureDetail(versionResult.failure, undefined);
      return snapshot(settings, checkedAt, {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Failed to run \`${binary} --version\`${diagnosis ? `: ${diagnosis}` : "."}`,
      });
    }
    if (Option.isNone(versionResult.success)) {
      return snapshot(settings, checkedAt, {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Timed out running \`${binary} --version\` after 10 s (cold start or AV scan?). Use Refresh provider status to retry.`,
      });
    }
    const versionOutput = versionResult.success.value.result;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      const detail = truncateTail(`${versionOutput.stdout}\n${versionOutput.stderr}`);
      return snapshot(settings, checkedAt, {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          detail.length > 0
            ? `Command Code is installed but failed to run: ${detail}`
            : "Command Code is installed but failed to run.",
      });
    }

    const statusOutput = yield* runCommandcodeCli(
      settings,
      ["status", "--json"],
      environment,
      platform,
    ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
    const versionProbe = Result.isFailure(statusOutput)
      ? undefined
      : Option.getOrUndefined(statusOutput.success)?.result;
    const status =
      versionProbe === undefined
        ? Option.none<CommandcodeStatus>()
        : versionProbe.code === 0
          ? decodeCommandcodeStatus(versionProbe.stdout)
          : Option.none();
    const decoded = Option.getOrUndefined(status);
    const auth = commandcodeAuth(decoded?.authenticated, decoded?.user);
    const probe =
      auth.status === "unauthenticated"
        ? { status: "error" as const, message: `Run \`${binary} login\` to sign in.` }
        : auth.status === "unknown"
          ? {
              status: "warning" as const,
              message: `Command Code is installed but login state could not be determined. Run \`${binary} status\` to check.`,
            }
          : { status: "ready" as const };
    const defaultModel = nonEmptyTrimmed(decoded?.model ?? undefined);
    const catalog = yield* commandcodeCatalogModels(commandcodeModelCatalogDir(environment));
    return snapshot(
      settings,
      checkedAt,
      { installed: true, version: decoded?.version ?? version, auth, ...probe },
      defaultModel,
      catalog,
    );
  },
);
