import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type { CommandcodeSettings } from "../settings.ts";

const Usage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Unknown),
  outputTokens: Schema.optional(Schema.Unknown),
  cacheReadTokens: Schema.optional(Schema.Unknown),
  cacheWriteTokens: Schema.optional(Schema.Unknown),
  costUsd: Schema.optional(Schema.Unknown),
});
const Entry = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.NonEmptyString,
  timestamp: Schema.String,
  model: Schema.optional(Schema.String),
  message: Schema.Struct({ role: Schema.Literal("assistant") }),
  usage: Usage,
});
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown, path: string, sessionId: string): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  // inputTokens is cumulative per session; cache counters are disjoint from it.
  const cachedInputTokens = tokenCount(entry.usage.cacheReadTokens);
  const cacheCreationTokens = tokenCount(entry.usage.cacheWriteTokens);
  const outputTokens = tokenCount(entry.usage.outputTokens);
  const totals = {
    uncachedInputTokens:
      Math.max(0, tokenCount(entry.usage.inputTokens)) - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: 0,
  };
  const cost = entry.usage.costUsd;
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) <= 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "commandcode",
      timestampMs,
      model: entry.model ?? "default",
      ...(entry.model === undefined ? {} : { rateModel: entry.model }),
      sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["commandcode", entry.id, path]),
    },
  ];
}

export const commandcodeUsageFormat: TranscriptUsageFormat<{ sessionId: string }> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    model: true,
    message: { role: true },
    usage: true,
  },
  usageMarkers: ['"usage"'],
  state: {
    initial: () => ({ sessionId: "" }),
    schema: Schema.Struct({ sessionId: Schema.String }),
  },
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "session" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      state.sessionId = (parsed as { id: string }).id;
      return [];
    }
    return parseRecord(parsed, "", state.sessionId);
  },
  parseProjected: (projected, state) => parseRecord(projected, "", state.sessionId),
};

export const commandcodeUsageReader: ProviderUsageReader<CommandcodeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "commandcode",
  format: commandcodeUsageFormat,
  directories: Effect.fn("commandcodeUsageReader.directories")(function* () {
    const path = yield* Path.Path;
    return [{ dir: path.join(".commandcode", "projects") }];
  }),
};
