/** Local-disk usage probe aggregating Command Code session transcripts. */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";

import {
  makeUsageLimits,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const AuthFile = Schema.fromJsonString(
  Schema.Struct({
    userName: Schema.optional(Schema.String),
    userId: Schema.optional(Schema.String),
    apiKey: Schema.optional(Schema.String),
    authenticatedAt: Schema.optional(Schema.String),
  }),
);
const decodeAuthFile = Schema.decodeUnknownOption(AuthFile);

const UsageLine = Schema.Struct({
  type: Schema.Literal("message"),
  timestamp: Schema.String,
  message: Schema.Struct({ role: Schema.Literal("assistant") }),
  usage: Schema.Struct({
    costUsd: Schema.optional(Schema.Unknown),
    inputTokens: Schema.optional(Schema.Unknown),
    outputTokens: Schema.optional(Schema.Unknown),
  }),
});
const decodeUsageLine = Schema.decodeUnknownOption(UsageLine);

const ROLLING_DAYS = 30;
const ROLLING_MS = ROLLING_DAYS * 24 * 60 * 60 * 1_000;

interface AggregatedUsage {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
}

function tokenNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function parseTurnFromLine(line: string, cutoffMs: number): AggregatedUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const decoded = decodeUsageLine(parsed);
  if (decoded._tag !== "Some") return null;
  const entry = decoded.value;
  const timestampMs = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs) return null;
  const cost = entry.usage.costUsd;
  const costUsd = typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0;
  return {
    costUsd,
    inputTokens: tokenNum(entry.usage.inputTokens),
    outputTokens: tokenNum(entry.usage.outputTokens),
    turns: 1,
  };
}

function aggregateJSONLFile(raw: string, cutoffMs: number): AggregatedUsage {
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  for (const line of raw.split("\n")) {
    const turn = parseTurnFromLine(line, cutoffMs);
    if (turn !== null) {
      costUsd += turn.costUsd;
      inputTokens += turn.inputTokens;
      outputTokens += turn.outputTokens;
      turns += 1;
    }
  }
  return { costUsd, inputTokens, outputTokens, turns };
}

function commandcodeProjectsDir(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? NodeOS.homedir();
  return `${home}/.commandcode/projects`;
}

function commandcodeAuthFile(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? NodeOS.homedir();
  return `${home}/.commandcode/auth.json`;
}

export const probeCommandcodeUsage = Effect.fn("probeCommandcodeUsage")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderUsageLimits, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const cutoffMs = Date.now() - ROLLING_MS;

  const authRaw = yield* fs
    .readFileString(commandcodeAuthFile(environment))
    .pipe(Effect.orElseSucceed(() => null));
  const authDecoded = authRaw !== null ? decodeAuthFile(authRaw) : undefined;
  const credentialFingerprint =
    authDecoded?._tag === "Some"
      ? (authDecoded.value.userName?.trim() ?? authDecoded.value.userId?.trim() ?? undefined)
      : undefined;

  if (credentialFingerprint === undefined && authRaw === null) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Command Code is not signed in. Run `cmdc login` to authenticate.",
    });
  }

  const projectsDir = commandcodeProjectsDir(environment);

  const projectDirs = yield* fs
    .readDirectory(projectsDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTurns = 0;

  yield* Effect.forEach(
    projectDirs,
    (projectSlug) =>
      Effect.gen(function* () {
        const projectPath = `${projectsDir}/${projectSlug}`;
        const files = yield* fs
          .readDirectory(projectPath)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

        const sessionFiles = files.filter(
          (f) =>
            f.endsWith(".jsonl") && !f.startsWith("hooks-audit-") && !f.includes(".checkpoints."),
        );

        yield* Effect.forEach(
          sessionFiles,
          (file) =>
            Effect.gen(function* () {
              const raw = yield* fs
                .readFileString(`${projectPath}/${file}`)
                .pipe(Effect.orElseSucceed(() => null));
              if (raw === null) return;
              const agg = aggregateJSONLFile(raw, cutoffMs);
              totalCost += agg.costUsd;
              totalInputTokens += agg.inputTokens;
              totalOutputTokens += agg.outputTokens;
              totalTurns += agg.turns;
            }),
          { concurrency: 4 },
        );
      }),
    { concurrency: 4 },
  );

  if (totalTurns === 0 && totalCost === 0) {
    return {
      ...makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message:
          "No Command Code sessions found in the last 30 days. Start a session to see usage.",
      }),
      externalUsage: {
        label: "View billing & plan",
        url: "https://commandcode.ai/billing",
      },
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
    };
  }

  const costPercent = totalCost > 0 ? Math.min(100, Math.round(totalCost * 1000) / 10) : 0;

  const windows = [
    {
      id: "commandcode_30d_cost",
      kind: "monthly" as const,
      label: `30-day spend (\$${totalCost.toFixed(4)})`,
      usedPercent: costPercent,
      windowDurationMins: ROLLING_DAYS * 24 * 60,
    },
    {
      id: "commandcode_30d_turns",
      kind: "other" as const,
      label: `Turns (${totalTurns.toLocaleString()} in 30 days)`,
      usedPercent: 0,
      windowDurationMins: ROLLING_DAYS * 24 * 60,
    },
  ];

  return {
    ...makeUsageLimits({ checkedAt, windows }),
    externalUsage: {
      label: "View billing & plan",
      url: "https://commandcode.ai/billing",
    },
    ...(credentialFingerprint ? { credentialFingerprint } : {}),
  };
});
