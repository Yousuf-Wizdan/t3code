import { assert, describe, it } from "@effect/vitest";

import {
  commandcodeHeadlessArgs,
  commandcodeHeadlessError,
  commandcodeHeadlessResult,
} from "./textGeneration.ts";

const successStream = [
  '{"type":"event","event":{"type":"run_start","sessionId":"s1"}}',
  '{"type":"event","event":{"type":"text_delta","delta":"hi"}}',
  '{"type":"result","subtype":"success","sessionId":"s1","stopReason":"end_turn","durationMs":8421,"finalText":"{\\"subject\\":\\"fix: the thing\\"}"}',
  "",
].join("\n");

describe("commandcodeHeadlessArgs", () => {
  it("never sends T3's default or auto sentinels as a model", () => {
    assert.deepEqual(commandcodeHeadlessArgs("default"), [
      "-p",
      "--no-session",
      "--output-format",
      "json",
      "--skip-onboarding",
    ]);
    assert.deepEqual(commandcodeHeadlessArgs("auto"), [
      "-p",
      "--no-session",
      "--output-format",
      "json",
      "--skip-onboarding",
    ]);
  });

  it("passes a chosen model through to -m", () => {
    assert.deepEqual(commandcodeHeadlessArgs("claude-haiku-5-5"), [
      "-p",
      "--no-session",
      "--output-format",
      "json",
      "--skip-onboarding",
      "-m",
      "claude-haiku-5-5",
    ]);
  });
});

describe("commandcodeHeadlessResult", () => {
  it("reads finalText from the trailing result line", () => {
    assert.equal(commandcodeHeadlessResult(successStream), '{"subject":"fix: the thing"}');
  });

  it("returns undefined for failed runs and missing result lines", () => {
    assert.equal(
      commandcodeHeadlessResult('{"type":"result","subtype":"max_turns","finalText":"partial"}'),
      undefined,
    );
    assert.equal(commandcodeHeadlessResult('{"type":"event","event":{}}'), undefined);
    assert.equal(
      commandcodeHeadlessResult('{"type":"result","subtype":"error","error":"not authenticated"}'),
      undefined,
    );
  });
});

describe("commandcodeHeadlessError", () => {
  it("reports the result line's failure detail", () => {
    assert.equal(
      commandcodeHeadlessError(
        '{"type":"result","subtype":"error","error":"not authenticated"}',
        3,
      ),
      "not authenticated",
    );
    assert.equal(
      commandcodeHeadlessError('{"type":"result","subtype":"max_turns"}', 8),
      "Command Code headless run ended with max_turns.",
    );
    assert.equal(
      commandcodeHeadlessError("no json here", 5),
      "Command Code headless run failed with exit code 5.",
    );
  });
});
