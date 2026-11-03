import { describe, it } from "@effect/vitest";
import { assert } from "@effect/vitest";

import { commandcodeUsageFormat } from "./usage.ts";

const state = () => commandcodeUsageFormat.state?.initial() ?? { sessionId: "" };

const assistantLine = (usage: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "message",
    id: "msg-1",
    timestamp: "2026-11-02T16:22:53.611Z",
    model: "xiaomi/mimo-v2.6-flash",
    message: { role: "assistant" },
    usage,
    ...extra,
  });

describe("commandcodeUsageFormat", () => {
  it("parses an assistant usage record with provider-reported cost", () => {
    const [record] = commandcodeUsageFormat.parseLine(
      assistantLine({
        inputTokens: 23832,
        outputTokens: 161,
        cacheReadTokens: 6144,
        cacheWriteTokens: 0,
        costUsd: 0.0025386032,
      }),
      state(),
    );
    assert.deepEqual(record, {
      provider: "commandcode",
      timestampMs: Date.parse("2026-11-02T16:22:53.611Z"),
      model: "xiaomi/mimo-v2.6-flash",
      rateModel: "xiaomi/mimo-v2.6-flash",
      sessionId: "",
      totals: {
        uncachedInputTokens: 23832 - 6144,
        cachedInputTokens: 6144,
        cacheCreationTokens: 0,
        outputTokens: 161,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.0025386032,
      speed: "standard",
      dedupeKey: JSON.stringify(["commandcode", "msg-1", ""]),
    });
  });

  it("defaults the model when the record carries none", () => {
    const [record] = commandcodeUsageFormat.parseLine(
      assistantLine({ inputTokens: 10, outputTokens: 5 }, { model: undefined }),
      state(),
    );
    assert.equal(record?.model, "default");
    assert.isFalse("rateModel" in (record ?? {}));
  });

  it("drops records with no tokens and no cost", () => {
    assert.deepEqual(
      commandcodeUsageFormat.parseLine(
        assistantLine({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
        state(),
      ),
      [],
    );
  });

  it("ignores user messages and malformed lines", () => {
    assert.deepEqual(
      commandcodeUsageFormat.parseLine(
        JSON.stringify({
          type: "message",
          id: "msg-2",
          timestamp: "2026-11-02T16:22:53.611Z",
          message: { role: "user" },
          usage: { inputTokens: 5 },
        }),
        state(),
      ),
      [],
    );
    assert.deepEqual(commandcodeUsageFormat.parseLine("{ not json", state()), []);
    assert.deepEqual(
      commandcodeUsageFormat.parseLine(JSON.stringify({ type: "session", id: "abc" }), state()),
      [],
    );
  });

  it("tracks the session id across lines", () => {
    const session = state();
    assert.deepEqual(
      commandcodeUsageFormat.parseLine(
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-1",
          timestamp: "2026-11-02T16:22:53.611Z",
          cwd: "C:\\repo",
        }),
        session,
      ),
      [],
    );
    const [record] = commandcodeUsageFormat.parseLine(
      assistantLine({ inputTokens: 10, outputTokens: 5 }),
      session,
    );
    assert.equal(record?.sessionId, "sess-1");
  });
});
