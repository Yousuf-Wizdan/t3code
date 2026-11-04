import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import type { CommandcodeSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

export const COMMANDCODE_DRIVER_KIND = ProviderDriverKind.make("commandcode");

/**
 * The npm package installs `cmd`, `cmdc`, and `commandcode`; `cmd` is cmd.exe
 * on Windows, so the default resolves per platform unless a path is configured.
 */
export function commandcodeBinaryPath(
  configured: string | null | undefined,
  platform: NodeJS.Platform,
): string {
  const explicit = configured?.trim() ?? "";
  return explicit.length > 0 ? explicit : platform === "win32" ? "cmdc" : "cmd";
}

const TasteSettingsFile = Schema.fromJsonString(
  Schema.Struct({ tasteLearning: Schema.optional(Schema.Boolean) }),
);
const decodeTasteSettings = Schema.decodeUnknownOption(TasteSettingsFile);

/** The user-level command behind the Taste learning switch (`-u` = every project). */
export function commandcodeTasteArgs(taste: "disabled" | "enabled"): ReadonlyArray<string> {
  return ["taste", taste === "enabled" ? "enable" : "disable", "-u"];
}

/**
 * Reconciles Command Code's persisted `tasteLearning` state with the instance
 * setting before an ACP session starts: the file holds this user's level state
 * (`cmdc taste enable|disable -u`), an unset switch never touches it, and a
 * failed reconcile never blocks the session.
 */
export const ensureCommandcodeTasteState = Effect.fn("ensureCommandcodeTasteState")(function* (
  taste: CommandcodeSettings["taste"],
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> {
  if (taste !== "disabled" && taste !== "enabled") return;
  const fs = yield* FileSystem.FileSystem;
  const home = environment.HOME ?? environment.USERPROFILE ?? NodeOS.homedir();
  const raw = yield* fs
    .readFileString(`${home}/.commandcode/settings.json`)
    .pipe(Effect.orElseSucceed(() => null));
  const observed =
    raw === null ? undefined : Option.getOrUndefined(decodeTasteSettings(raw))?.tasteLearning;
  if (observed === (taste === "enabled")) return;
  const command = commandcodeBinaryPath(binaryPath, platform);
  const spawnCommand = yield* resolveSpawnCommand(command, commandcodeTasteArgs(taste), {
    env: environment,
  });
  yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  ).pipe(Effect.ignore);
});

const COMMANDCODE_FILE_TOOL_KINDS = new Set(["edit", "delete", "move"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Command Code's file tools carry their diff once on `tool_call`, then replace
 * it with success text on completion; the ACP merge keeps the later content, so
 * the card would render the success text as its diff. Rebuild it from the raw
 * input the merge preserves; a content that already holds a diff is left alone.
 */
export function normalizeCommandcodeToolCall(toolCall: AcpToolCallState): AcpToolCallState {
  if (toolCall.kind === undefined || !COMMANDCODE_FILE_TOOL_KINDS.has(toolCall.kind)) {
    return toolCall;
  }
  const content = toolCall.data.content;
  if (Array.isArray(content) && content.some((entry) => asRecord(entry)?.type === "diff")) {
    return toolCall;
  }
  const rawInput = asRecord(toolCall.data.rawInput);
  if (rawInput === undefined) return toolCall;
  const path = typeof rawInput.file_path === "string" ? rawInput.file_path : undefined;
  const newText =
    typeof rawInput.new_string === "string"
      ? rawInput.new_string
      : typeof rawInput.content === "string"
        ? rawInput.content
        : undefined;
  if (path === undefined || newText === undefined) return toolCall;
  const oldText = typeof rawInput.old_string === "string" ? rawInput.old_string : null;
  const diff = {
    type: "diff",
    path,
    oldText,
    newText,
    // A known old text renders as a snippet; an unknown one needs a textual patch,
    // because a `snippet` patch is deliberately suppressed as unpreviewable.
    patch: {
      format: oldText === null ? "unified" : "snippet",
      text: newText
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n"),
    },
  };
  const rest = Array.isArray(content)
    ? content.filter((entry) => asRecord(entry)?.type !== "diff")
    : [];
  return {
    ...toolCall,
    data: { ...toolCall.data, content: [diff, ...rest] },
  };
}

export interface CommandcodePlanPathHost {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}

function addCommandcodePlansPrefix(prefixes: Set<string>, homeOrRoot: string): void {
  const root = homeOrRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (root.length > 0) prefixes.add(`${root}/.commandcode/plans/`);
}

const CANONICAL_HOME_COMMANDCODE_PLANS_PATH =
  /^(?:\/home\/[^/]+|\/Users\/[^/]+|[a-zA-Z]:\/Users\/[^/]+)\/\.commandcode\/plans\/[^/]+\.md$/;
const CASE_INSENSITIVE_CANONICAL_HOME_COMMANDCODE_PLANS_PATH = new RegExp(
  CANONICAL_HOME_COMMANDCODE_PLANS_PATH.source,
  "i",
);

/**
 * Command Code keeps the live plan at `<home>/.commandcode/plans/<name>.md`;
 * `versions/` snapshots and `plans-index.json` are never the plan itself.
 */
export function isCommandcodePlanMarkdownPath(
  path: string | undefined | null,
  host: CommandcodePlanPathHost,
): boolean {
  if (typeof path !== "string") return false;
  const normalized = path.trim().replace(/\\/g, "/");
  if (normalized.length === 0 || normalized.split("/").some((segment) => segment === "..")) {
    return false;
  }
  const win32 = host.platform === "win32";
  const haystack = win32 ? normalized.toLowerCase() : normalized;
  if (!haystack.endsWith(".md")) return false;
  const prefixes = new Set<string>();
  addCommandcodePlansPrefix(prefixes, host.homeDirectory);
  addCommandcodePlansPrefix(prefixes, "~");
  addCommandcodePlansPrefix(prefixes, host.environment.HOME ?? "");
  addCommandcodePlansPrefix(prefixes, host.environment.USERPROFILE ?? "");
  // ACP mocks and isolated spawns use a HOME that is not the server process home.
  addCommandcodePlansPrefix(prefixes, "/tmp/mock-home");
  for (const prefix of prefixes) {
    const needle = win32 ? prefix.toLowerCase() : prefix;
    if (!haystack.startsWith(needle)) continue;
    const rest = haystack.slice(needle.length);
    if (rest.length > 0 && !rest.includes("/")) return true;
  }
  return (
    win32
      ? CASE_INSENSITIVE_CANONICAL_HOME_COMMANDCODE_PLANS_PATH
      : CANONICAL_HOME_COMMANDCODE_PLANS_PATH
  ).test(haystack);
}

/**
 * Plan markdown from one Command Code tool call: a write to
 * `<home>/.commandcode/plans/<name>.md` (raw input or rebuilt diff), or the
 * `exit_plan_mode` fallback `plan` argument when no plan file carries it.
 */
export function extractCommandcodePlanMarkdownFromToolCallData(
  data: Record<string, unknown> | undefined,
  host: CommandcodePlanPathHost,
): string | undefined {
  if (data === undefined) return undefined;

  let sawPlanWrite = false;
  const takePlanText = (
    value: string | undefined,
    filePath: string | undefined,
  ): string | undefined => {
    if (!isCommandcodePlanMarkdownPath(filePath, host) || value === undefined) {
      return undefined;
    }
    sawPlanWrite = true;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const rawInput = asRecord(data.rawInput);
  if (rawInput !== undefined) {
    const fallbackPlan = typeof rawInput.plan === "string" ? rawInput.plan.trim() : undefined;
    if (
      fallbackPlan !== undefined &&
      fallbackPlan.length > 0 &&
      rawInput.file_path === undefined &&
      rawInput.path === undefined &&
      rawInput.content === undefined &&
      rawInput.new_string === undefined
    ) {
      return fallbackPlan;
    }
    const filePath =
      (typeof rawInput.file_path === "string" ? rawInput.file_path : undefined) ??
      (typeof rawInput.path === "string" ? rawInput.path : undefined);
    const content =
      (typeof rawInput.content === "string" ? rawInput.content : undefined) ??
      (typeof rawInput.new_string === "string" ? rawInput.new_string : undefined);
    const fromRaw = takePlanText(content, filePath);
    if (fromRaw !== undefined) return fromRaw;
  }

  const content = data.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const diff = asRecord(block);
      if (diff === undefined || diff.type !== "diff") continue;
      const path = typeof diff.path === "string" ? diff.path : undefined;
      const newText = typeof diff.newText === "string" ? diff.newText : undefined;
      const fromDiff = takePlanText(newText, path);
      if (fromDiff !== undefined) return fromDiff;
    }
  }

  return sawPlanWrite ? "" : undefined;
}

/**
 * All four permission levels exist natively as ACP session modes
 * (`default`, `auto-accept`, `dont-ask`, `bypass`), enforced by the agent itself.
 */
export const COMMANDCODE_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

const RUNTIME_MODE_TO_SESSION_MODE: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "default",
  "auto-accept-edits": "auto-accept",
  auto: "dont-ask",
  "full-access": "bypass",
};

const SESSION_MODE_TO_RUNTIME_MODE: Readonly<Record<string, RuntimeMode>> = {
  default: "approval-required",
  "auto-accept": "auto-accept-edits",
  "dont-ask": "auto",
  bypass: "full-access",
  // Plan grants less than any ceiling; place it under the lowest rank so a
  // ceiling never blocks the agent's own read-only mode.
  plan: "approval-required",
};

/**
 * An explicit approval or sandbox policy must not launch the agent in
 * `bypass`/`dont-ask`, which would perform actions the policy meant to confine;
 * the agent then asks and T3's own policy answers.
 */
export function commandcodeSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): string {
  if (policy.approvalPolicy !== undefined || policy.sandboxPolicy !== undefined) {
    return "default";
  }
  return RUNTIME_MODE_TO_SESSION_MODE[policy.runtimeMode];
}

/** The T3 runtime mode a native session mode grants, for policy-ceiling checks. */
export function commandcodeRuntimeModeForSessionMode(modeId: string): RuntimeMode | undefined {
  return SESSION_MODE_TO_RUNTIME_MODE[modeId];
}

interface CommandcodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly commandcodeSettings: Pick<CommandcodeSettings, "binaryPath" | "taste">;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The driver's FileSystem, captured so the flavor's fixed runtime contract stays clean. */
  readonly fileSystem: FileSystem.FileSystem;
}

export const makeCommandcodeAcpRuntime = Effect.fn("makeCommandcodeAcpRuntime")(function* (
  input: CommandcodeAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { commandcodeSettings, environment, platform, fileSystem, ...runtimeOptions } = input;
  yield* ensureCommandcodeTasteState(
    commandcodeSettings.taste,
    commandcodeSettings.binaryPath,
    environment ?? {},
    platform,
  ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: {
        command: commandcodeBinaryPath(commandcodeSettings.binaryPath, platform),
        args: ["acp"],
        cwd: input.cwd,
        env: { ...environment },
      },
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
