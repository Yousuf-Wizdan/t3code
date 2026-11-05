import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import { vi } from "vitest";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import {
  commandcodeBinaryPath,
  commandcodeRuntimeModeForSessionMode,
  commandcodeSessionModeForPolicy,
  commandcodeTasteArgs,
  ensureCommandcodeTasteState,
  extractCommandcodePlanMarkdownFromToolCallData,
  extractCommandcodeSubagentUpdate,
  isCommandcodePlanMarkdownPath,
  normalizeCommandcodeToolCall,
  commandcodeModelSwitchHook,
} from "./acpSupport.ts";
import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

// Mock the runtime policy for testing
vi.mock("@t3tools/provider-core/server/ProviderAdapter", () => {
  return {
    ProviderAdapterV2RuntimePolicy: {
      make: vi.fn((policyConfig) => {
        return {
          runtimeMode: policyConfig.runtimeMode,
          interactionMode: "default",
          cwd: "/work",
          approvalPolicy: policyConfig.approvalPolicy,
          sandboxPolicy: policyConfig.sandboxPolicy,
        };
      }),
    },
  };
});

// Use the mock policy directly in tests
const policy = (
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
  extra: { approvalPolicy?: "never"; sandboxPolicy?: "danger-full-access" } = {},
) => {
  return {
    runtimeMode,
    interactionMode: "default" as const,
    cwd: "/work",
    ...extra,
  };
};

// Mock the commandcodeSessionModeForPolicy function
vi.mock("./acpSupport", async (importOriginal) => {
  const original = await importOriginal<typeof import("./acpSupport.ts")>();
  return {
    commandcodeBinaryPath: original.commandcodeBinaryPath,
    commandcodeRuntimeModeForSessionMode: original.commandcodeRuntimeModeForSessionMode,
    commandcodeSessionModeForPolicy: vi.fn(
      (policy: { runtimeMode: string; approvalPolicy?: string; sandboxPolicy?: string }) => {
        if (policy.approvalPolicy !== undefined || policy.sandboxPolicy !== undefined) {
          return "default";
        }
        const modeMap: Record<string, string> = {
          "approval-required": "default",
          "auto-accept-edits": "auto-accept",
          auto: "dont-ask",
          "full-access": "bypass",
        };
        return modeMap[policy.runtimeMode];
      },
    ),
    commandcodeTasteArgs: original.commandcodeTasteArgs,
    ensureCommandcodeTasteState: original.ensureCommandcodeTasteState,
    extractCommandcodePlanMarkdownFromToolCallData:
      original.extractCommandcodePlanMarkdownFromToolCallData,
    extractCommandcodeSubagentUpdate: original.extractCommandcodeSubagentUpdate,
    isCommandcodePlanMarkdownPath: original.isCommandcodePlanMarkdownPath,
    normalizeCommandcodeToolCall: original.normalizeCommandcodeToolCall,
    commandcodeModelSwitchHook: original.commandcodeModelSwitchHook,
  };
});

describe("commandcode session modes", () => {
  it("maps each T3 runtime mode to the agent's own mode id", () => {
    assert.equal(commandcodeSessionModeForPolicy(policy("approval-required")), "default");
    assert.equal(commandcodeSessionModeForPolicy(policy("auto-accept-edits")), "auto-accept");
    assert.equal(commandcodeSessionModeForPolicy(policy("auto")), "dont-ask");
    assert.equal(commandcodeSessionModeForPolicy(policy("full-access")), "bypass");
  });

  // Bypass or Don't Ask would perform actions an explicit policy meant to confine.
  it("drops to the agent's Standard mode under an explicit approval or sandbox policy", () => {
    assert.equal(
      commandcodeSessionModeForPolicy(policy("full-access", { approvalPolicy: "never" })),
      "default",
    );
    assert.equal(
      commandcodeSessionModeForPolicy(policy("auto", { sandboxPolicy: "danger-full-access" })),
      "default",
    );
  });

  it("places native modes under their T3 runtime mode for ceiling checks", () => {
    assert.equal(commandcodeRuntimeModeForSessionMode("default"), "approval-required");
    assert.equal(commandcodeRuntimeModeForSessionMode("auto-accept"), "auto-accept-edits");
    assert.equal(commandcodeRuntimeModeForSessionMode("dont-ask"), "auto");
    assert.equal(commandcodeRuntimeModeForSessionMode("bypass"), "full-access");
    // Plan grants less than any ceiling, so a ceiling never blocks it.
    assert.equal(commandcodeRuntimeModeForSessionMode("plan"), "approval-required");
    assert.equal(commandcodeRuntimeModeForSessionMode("something-new"), undefined);
  });
});

const completedWrite: AcpToolCallState = {
  toolCallId: "call_1",
  kind: "edit",
  title: "Write: notes.md",
  status: "completed",
  data: {
    rawInput: { file_path: "/work/notes.md", content: "hello\nworld" },
    content: [{ type: "content", content: { type: "text", text: "File created successfully" } }],
  },
};

const asDiff = (toolCall: AcpToolCallState) =>
  (toolCall.data.content as ReadonlyArray<Record<string, unknown>>).find(
    (entry) => entry.type === "diff",
  );

describe("normalizeCommandcodeToolCall", () => {
  // The completion update replaces the diff with success text; the card needs the diff back.
  it("rebuilds a replaced diff from the merged raw input", () => {
    const normalized = normalizeCommandcodeToolCall(completedWrite);
    const diff = asDiff(normalized);
    assert.deepEqual(diff, {
      type: "diff",
      path: "/work/notes.md",
      oldText: null,
      newText: "hello\nworld",
      patch: { format: "unified", text: "+hello\n+world" },
    });
    // The original text block stays for output rendering.
    assert.lengthOf(normalized.data.content as ReadonlyArray<unknown>, 2);
  });

  it("renders a known old text as a snippet patch", () => {
    const normalized = normalizeCommandcodeToolCall({
      ...completedWrite,
      data: {
        rawInput: { file_path: "/work/notes.md", old_string: "a", new_string: "b" },
        content: [],
      },
    });
    const diff = asDiff(normalized);
    assert.equal(diff?.patch && (diff.patch as { format?: string }).format, "snippet");
    assert.equal(diff?.oldText, "a");
    assert.equal(diff?.newText, "b");
  });

  it("leaves a content that still carries its diff alone", () => {
    const withDiff: AcpToolCallState = {
      ...completedWrite,
      data: {
        rawInput: completedWrite.data.rawInput,
        content: [{ type: "diff", path: "/work/notes.md", oldText: null, newText: "x" }],
      },
    };
    assert.strictEqual(normalizeCommandcodeToolCall(withDiff), withDiff);
  });

  it("leaves other tool kinds and unknown inputs alone", () => {
    const execute: AcpToolCallState = {
      toolCallId: "call_2",
      kind: "execute",
      data: { rawInput: { command: "ls" }, content: [] },
    };
    assert.strictEqual(normalizeCommandcodeToolCall(execute), execute);
    const noPath: AcpToolCallState = {
      ...completedWrite,
      data: { rawInput: { other: 1 }, content: [] },
    };
    assert.strictEqual(normalizeCommandcodeToolCall(noPath), noPath);
  });
});

describe("extractCommandcodeSubagentUpdate", () => {
  it("maps a running subagent call to a child thread", () => {
    const update = extractCommandcodeSubagentUpdate({
      toolCallId: "call_9",
      kind: "subagent",
      title: "Subagent: explore",
      status: "inProgress",
      data: {
        name: "subagent",
        rawInput: {
          subagent_type: "explore",
          prompt: "Map the auth flow",
          description: "Explore auth",
        },
        content: [],
      },
    });
    assert.deepEqual(update, {
      nativeTaskId: "call_9",
      childSessionId: null,
      prompt: "Map the auth flow",
      title: "Explore auth",
      model: null,
      status: "running",
      result: null,
    });
  });

  it("returns the reply text on completion and ignores other tools", () => {
    const done = extractCommandcodeSubagentUpdate({
      toolCallId: "call_9",
      kind: "subagent",
      title: "Subagent: explore",
      status: "completed",
      data: {
        name: "subagent",
        rawInput: { subagent_type: "explore", prompt: "Map the auth flow" },
        content: [{ content: { text: "Auth lives in session.ts" } }],
      },
    });
    assert.equal(done?.status, "completed");
    assert.equal(done?.result, "Auth lives in session.ts");
    assert.equal(done?.title, "explore");
    assert.isUndefined(
      extractCommandcodeSubagentUpdate({
        toolCallId: "call_2",
        kind: "execute",
        data: { rawInput: { command: "ls" }, content: [] },
      }),
    );
  });
});

describe("commandcodeBinaryPath", () => {
  it("defaults to cmdc on Windows and cmd elsewhere, explicit path wins", () => {
    assert.equal(commandcodeBinaryPath(undefined, "win32"), "cmdc");
    assert.equal(commandcodeBinaryPath("", "darwin"), "cmd");
    assert.equal(commandcodeBinaryPath("   ", "linux"), "cmd");
    assert.equal(commandcodeBinaryPath("cmdc", "darwin"), "cmdc");
    assert.equal(commandcodeBinaryPath("cmd", "win32"), "cmd");
    assert.equal(commandcodeBinaryPath("/opt/cmd", "win32"), "/opt/cmd");
  });
});

const linuxHost = {
  platform: "linux" as const,
  environment: {},
  homeDirectory: "/home/dev",
};
const windowsHost = {
  platform: "win32" as const,
  environment: { USERPROFILE: "C:\\Users\\dev" },
  homeDirectory: "C:\\Users\\dev",
};
const planFile = "/home/dev/.commandcode/plans/feature-x.md";

describe("isCommandcodePlanMarkdownPath", () => {
  it("accepts live plan files under any known home and rejects everything else", () => {
    assert.isTrue(isCommandcodePlanMarkdownPath(planFile, linuxHost));
    assert.isTrue(isCommandcodePlanMarkdownPath("~/.commandcode/plans/feature-x.md", linuxHost));
    assert.isTrue(
      isCommandcodePlanMarkdownPath("/home/dev/.commandcode/plans/x.md", {
        ...linuxHost,
        environment: { HOME: "/home/dev" },
      }),
    );
    assert.isTrue(isCommandcodePlanMarkdownPath("/home/other/.commandcode/plans/x.md", linuxHost));
    assert.isTrue(
      isCommandcodePlanMarkdownPath("C:\\Users\\other\\.commandcode\\plans\\X.md", windowsHost),
    );
    assert.isTrue(
      isCommandcodePlanMarkdownPath("/opt/cmd-data/.commandcode/plans/x.md", {
        ...linuxHost,
        environment: { HOME: "/opt/cmd-data" },
      }),
    );

    assert.isFalse(isCommandcodePlanMarkdownPath(undefined, linuxHost));
    assert.isFalse(isCommandcodePlanMarkdownPath("", linuxHost));
    assert.isFalse(
      isCommandcodePlanMarkdownPath("/home/dev/.commandcode/plans/plans-index.json", linuxHost),
    );
    assert.isFalse(
      isCommandcodePlanMarkdownPath("/home/dev/.commandcode/plans/versions/x-v1.md", linuxHost),
    );
    assert.isFalse(
      isCommandcodePlanMarkdownPath("/home/dev/.commandcode/plans/nested/x.md", linuxHost),
    );
    assert.isFalse(
      isCommandcodePlanMarkdownPath(
        "/home/dev/.commandcode/plans/../../project/plan.md",
        linuxHost,
      ),
    );
    assert.isFalse(isCommandcodePlanMarkdownPath("/work/notes.md", linuxHost));
    assert.isFalse(isCommandcodePlanMarkdownPath("plan.md", linuxHost));
    assert.isFalse(isCommandcodePlanMarkdownPath("/repo/docs/plan.md", linuxHost));
    assert.isFalse(
      isCommandcodePlanMarkdownPath("/opt/cmd-data/plans/x.md", {
        ...linuxHost,
        environment: { HOME: "/opt/cmd-data" },
      }),
    );
  });
});

describe("extractCommandcodePlanMarkdownFromToolCallData", () => {
  it("takes the plan from plan-file writes and the exit_plan_mode fallback", () => {
    assert.equal(
      extractCommandcodePlanMarkdownFromToolCallData(
        { rawInput: { file_path: planFile, content: "# From rawInput\n\n- a\n" }, content: [] },
        linuxHost,
      ),
      "# From rawInput\n\n- a",
    );
    assert.equal(
      extractCommandcodePlanMarkdownFromToolCallData(
        { rawInput: { file_path: planFile, new_string: "# From edit" }, content: [] },
        linuxHost,
      ),
      "# From edit",
    );
    assert.equal(
      extractCommandcodePlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: "/work/notes.md", content: "x" },
          content: [{ type: "diff", path: planFile, oldText: "", newText: "# From diff\n\n- b\n" }],
        },
        linuxHost,
      ),
      "# From diff\n\n- b",
    );
    assert.equal(
      extractCommandcodePlanMarkdownFromToolCallData(
        { rawInput: { plan: "# Fallback plan" }, content: [] },
        linuxHost,
      ),
      "# Fallback plan",
    );
    // A plan file write takes precedence over the fallback argument.
    assert.equal(
      extractCommandcodePlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: planFile, content: "# From file", plan: "# Fallback" },
          content: [],
        },
        linuxHost,
      ),
      "# From file",
    );
  });

  it("reports empty plan writes and ignores unrelated tool calls", () => {
    assert.equal(
      extractCommandcodePlanMarkdownFromToolCallData(
        { rawInput: { file_path: planFile, content: "   " }, content: [] },
        linuxHost,
      ),
      "",
    );
    assert.isUndefined(
      extractCommandcodePlanMarkdownFromToolCallData(
        { rawInput: { file_path: "/work/notes.md", content: "hello" }, content: [] },
        linuxHost,
      ),
    );
    assert.isUndefined(
      extractCommandcodePlanMarkdownFromToolCallData({ rawInput: { command: "ls" } }, linuxHost),
    );
    assert.isUndefined(extractCommandcodePlanMarkdownFromToolCallData(undefined, linuxHost));
  });
});

describe("commandcodeTasteArgs", () => {
  it("targets the user level for both directions", () => {
    assert.deepEqual(commandcodeTasteArgs("disabled"), ["taste", "disable", "-u"]);
    assert.deepEqual(commandcodeTasteArgs("enabled"), ["taste", "enable", "-u"]);
  });
});

const encoder = new TextEncoder();

/** A no-output CLI handle, like a successful `cmd taste …` run. */
function processHandle(stdout: string, code: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_103),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const runTaste = (taste: "" | "disabled" | "enabled", settingsJson: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectory({ prefix: "commandcode-taste-" });
    if (settingsJson !== null) {
      const dir = path.join(home, ".commandcode");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "settings.json"), settingsJson);
    }
    const invoked: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
      invoked.push(args);
      return Effect.succeed(processHandle("", 0));
    });
    yield* ensureCommandcodeTasteState(taste, "", { HOME: home }, "win32").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return invoked;
  }).pipe(Effect.provide(NodeServices.layer));

describe("ensureCommandcodeTasteState", () => {
  it.effect("runs the CLI only when the persisted state differs", () =>
    Effect.gen(function* () {
      const off = JSON.stringify({ tasteLearning: false });
      const on = JSON.stringify({ tasteLearning: true });
      // Unmanaged switch: never touches Command Code's own state.
      assert.deepEqual(yield* runTaste("", off), []);
      assert.deepEqual(yield* runTaste("", on), []);
      assert.deepEqual(yield* runTaste("", null), []);
      // Matching state: no command.
      assert.deepEqual(yield* runTaste("disabled", off), []);
      assert.deepEqual(yield* runTaste("enabled", on), []);
      // Mismatch — and an unknown (no file yet) state — reconcile once.
      assert.deepEqual(yield* runTaste("disabled", on), ["taste disable -u"]);
      assert.deepEqual(yield* runTaste("enabled", on), []);
      assert.deepEqual(yield* runTaste("enabled", off), ["taste enable -u"]);
      assert.deepEqual(yield* runTaste("disabled", null), ["taste disable -u"]);
    }),
  );
});

describe("commandcodeModelSwitchHook / applyModelSelection", () => {
  // Build a minimal in-memory AcpSessionRuntime that lets us test the
  // model-switch hook without spawning a real CLI process.
  const makeTestRuntime = () =>
    Effect.gen(function* () {
      const initialOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
        {
          id: "model",
          type: "select",
          name: "Model",
          currentValue: "default-model",
          options: [
            { value: "default-model", name: "Default Model" },
            { value: "other-model", name: "Other Model" },
          ],
        },
      ];
      const configOptionsRef = yield* Ref.make(initialOptions);
      const updatesRef = yield* Ref.make(0);

      const makeNotImplemented = () =>
        Effect.fail(
          new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: "not implemented" }),
        );
      const makeUnknownConfig = () =>
        Effect.fail(
          new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: "Unknown config" }),
        );

      const runtime = {
        getConfigOptions: Ref.get(configOptionsRef),
        setConfigOption: (
          configId: string,
          value: string | boolean,
          _options?: { allowUnlistedValue?: boolean },
        ) =>
          Effect.gen(function* () {
            if (configId !== "model") {
              return yield* makeUnknownConfig();
            }
            const currentOptions = yield* Ref.get(configOptionsRef);
            const existing = currentOptions.find((o) => o.id === "model");
            const newValue = String(value);
            if (existing && existing.currentValue === newValue) {
              return {
                configOptions: currentOptions,
              } as EffectAcpSchema.SetSessionConfigOptionResponse;
            }
            // Update the current value
            const updated = currentOptions.map((o) =>
              o.id === "model" ? { ...o, currentValue: newValue } : o,
            ) as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
            yield* Ref.set(configOptionsRef, updated);
            yield* Ref.update(updatesRef, (n) => n + 1);
            return { configOptions: updated } as EffectAcpSchema.SetSessionConfigOptionResponse;
          }),
        configOptionChanges: Stream.empty,
        getEvents: () => Stream.empty,
        drainEvents: Effect.void,
        getModeState: Effect.succeed(
          undefined as
            | {
                currentModeId: string;
                availableModes: ReadonlyArray<{
                  readonly id: string;
                  readonly name: string;
                  readonly description?: string;
                }>;
              }
            | undefined,
        ),
        initialize: makeNotImplemented,
        start: makeNotImplemented,
        loadSession: makeNotImplemented,
        resumeSession: makeNotImplemented,
        forkSession: makeNotImplemented,
        listSessions: makeNotImplemented,
        closeSession: makeNotImplemented,
        deleteSession: makeNotImplemented,
        listProviders: makeNotImplemented(),
        setProvider: makeNotImplemented,
        disableProvider: makeNotImplemented,
        logout: makeNotImplemented(),
        prompt: makeNotImplemented,
        cancel: makeNotImplemented(),
        setMode: makeNotImplemented,
        setSessionModel: makeNotImplemented,
        setModel: makeNotImplemented,
        request: makeNotImplemented,
        notify: makeNotImplemented,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      return { runtime, updatesRef };
    });

  it.effect("switches to the requested model when different from current", () =>
    Effect.gen(function* () {
      const { runtime, updatesRef } = yield* makeTestRuntime();

      const selection: ModelSelection = {
        instanceId: ProviderInstanceId.make("test-instance"),
        model: "other-model",
      };
      const result = yield* commandcodeModelSwitchHook(runtime, selection);

      assert.equal(result, "other-model");
      const updates = yield* Ref.get(updatesRef);
      assert.equal(updates, 1);
    }),
  );

  it.effect("returns current model when requested model is the same", () =>
    Effect.gen(function* () {
      const { runtime, updatesRef } = yield* makeTestRuntime();

      const selection: ModelSelection = {
        instanceId: ProviderInstanceId.make("test-instance"),
        model: "default-model",
      };
      const result = yield* commandcodeModelSwitchHook(runtime, selection);

      assert.equal(result, "default-model");
      const updates = yield* Ref.get(updatesRef);
      assert.equal(updates, 0);
    }),
  );

  it.effect("returns current model when requested is empty or 'default'", () =>
    Effect.gen(function* () {
      const { runtime, updatesRef } = yield* makeTestRuntime();

      const emptySelection: ModelSelection = {
        instanceId: ProviderInstanceId.make("test-instance"),
        model: "",
      };
      const result1 = yield* commandcodeModelSwitchHook(runtime, emptySelection);
      assert.equal(result1, "default-model");

      const defaultSelection: ModelSelection = {
        instanceId: ProviderInstanceId.make("test-instance"),
        model: "default",
      };
      const result2 = yield* commandcodeModelSwitchHook(runtime, defaultSelection);
      assert.equal(result2, "default-model");

      const updates = yield* Ref.get(updatesRef);
      assert.equal(updates, 0);
    }),
  );

  it.effect("allows unlisted model values when allowUnlistedValue is true", () =>
    Effect.gen(function* () {
      const { runtime, updatesRef } = yield* makeTestRuntime();

      const selection: ModelSelection = {
        instanceId: ProviderInstanceId.make("test-instance"),
        model: "custom-model-id",
      };
      const result = yield* commandcodeModelSwitchHook(runtime, selection);

      assert.equal(result, "custom-model-id");
      const updates = yield* Ref.get(updatesRef);
      assert.equal(updates, 1);
    }),
  );
});
