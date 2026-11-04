import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { CommandcodeSettings } from "../settings.ts";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { checkCommandcodeProviderStatus } from "./status.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(CommandcodeSettings)({ enabled: true });
const disabledSettings = Schema.decodeSync(CommandcodeSettings)({});

/** An isolated home so the probe never reads the machine's real catalog cache. */
const makeHome = Effect.fn("makeHome")(function* (
  files: ReadonlyArray<{ readonly name: string; readonly content: string }> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectory({ prefix: "commandcode-home-" });
  if (files.length > 0) {
    const cacheDir = path.join(home, ".commandcode", "cache", "model-catalog", "v1");
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    for (const file of files) {
      yield* fs.writeFileString(path.join(cacheDir, file.name), file.content);
    }
  }
  return home;
});

const CATALOG_CACHE = JSON.stringify({
  cacheVersion: 3,
  body: {
    object: "list",
    data: [
      {
        id: "claude-sonnet-5-5",
        display: { label: "Claude Sonnet 5.5" },
        aliases: ["sonnet-5.5"],
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "open-local-model",
        name: "Open Local Model",
        display: { label: "Open Local Model" },
        aliases: [],
        reasoningEfforts: null,
      },
      { display: { label: "row without an id" } },
    ],
  },
});

/** Holds stdout and the exit back until `answered` completes, like a CLI slow to answer. */
function processHandle(stdout: string, code: number, answered: Effect.Effect<void> = Effect.void) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_102),
    exitCode: Effect.as(answered, ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.unwrap(
      Effect.as(
        answered,
        stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(stdout)),
      ),
    ),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Answers `cmdc` invocations by their arguments and records which ran. */
const check = (statusJson: string, versionDelay: Duration.Input = 0, home = "") =>
  Effect.gen(function* () {
    const outputs: Record<string, string> = {
      "--version": "1.88.2\n",
      "status --json": statusJson,
    };
    const invoked: Array<string> = [];
    // A win32 miss falls back to a shell:true escaped command line with empty
    // args; decode the probe from whichever shape the harness receives.
    const probeKey = (command: ChildProcess.Command): string => {
      if (!ChildProcess.isStandardCommand(command)) return "";
      if (command.args.length > 0) return command.args.join(" ");
      if (typeof command.command === "string" && command.command.includes("status")) {
        return "status --json";
      }
      return "--version";
    };
    const spawner = ChildProcessSpawner.make((command) => {
      const args = probeKey(command);
      invoked.push(args);
      const stdout = outputs[args];
      return Effect.succeed(
        processHandle(
          stdout ?? "",
          stdout === undefined ? 2 : 0,
          args === "--version" ? Effect.sleep(versionDelay) : Effect.void,
        ),
      );
    });
    // Miss PATH resolution by default so the harness exercises the same
    // shell:true fallback the packaged app takes before shell discovery.
    const draft = yield* checkCommandcodeProviderStatus(settings, { HOME: home }, "win32").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(SpawnExecutableResolution, () => undefined),
    );
    return { draft, invoked };
  }).pipe(Effect.provide(NodeServices.layer));

describe("checkCommandcodeProviderStatus", () => {
  it.effect.each([
    {
      label: "answers after 6 s",
      versionDelay: "6 seconds",
      status: "ready",
      version: "1.88.2",
      message: undefined,
    },
    {
      label: "never answers",
      versionDelay: "Infinity",
      status: "error",
      version: null,
      message:
        "Timed out running `cmdc --version` after 10 s (cold start or AV scan?). Use Refresh provider status to retry.",
    },
  ] as const)("gives `cmdc --version` 10 s when it $label", (row) =>
    Effect.gen(function* () {
      const fiber = yield* check(
        JSON.stringify({ authenticated: true, version: "1.88.2", user: "someone" }),
        row.versionDelay,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const { draft } = yield* Fiber.join(fiber);
      assert.equal(draft.status, row.status);
      assert.equal(draft.version, row.version);
      assert.equal(draft.message, row.message);
    }),
  );

  // `cmdc status --json` from 1.88.2, trimmed to the fields T3 reads plus a few it ignores.
  it.effect("reads login state from `cmdc status --json` without opening an ACP session", () =>
    Effect.gen(function* () {
      const signedIn = yield* check(
        JSON.stringify({
          authenticated: true,
          version: "1.88.2",
          user: "hellojzuf",
          provider: "command-code",
          model: "xiaomi/mimo-v2.6-flash",
          context_window: 1048576,
        }),
      );
      assert.deepEqual(signedIn.invoked, ["--version", "status --json"]);
      assert.equal(signedIn.draft.status, "ready");
      assert.equal(signedIn.draft.version, "1.88.2");
      assert.deepEqual(signedIn.draft.auth, {
        status: "authenticated",
        label: "hellojzuf",
      });
      assert.deepEqual(
        signedIn.draft.models.map((model) => model.slug),
        ["default"],
      );
      // "Default" names the model the session runs once a session reports it.
      assert.equal(signedIn.draft.models[0]?.name, "Default (xiaomi/mimo-v2.6-flash)");
      assert.equal(signedIn.draft.supportsTextGeneration, true);

      const signedOut = yield* check(JSON.stringify({ authenticated: false, version: "1.88.2" }));
      assert.equal(signedOut.draft.status, "error");
      assert.equal(signedOut.draft.auth.status, "unauthenticated");
      assert.equal(signedOut.draft.message, "Run `cmdc login` to sign in.");

      // A status output T3 cannot read is not reported as signed out.
      const unknown = yield* check("not json");
      assert.equal(unknown.draft.status, "warning");
      assert.equal(unknown.draft.auth.status, "unknown");
    }),
  );

  it.effect("names the spawn failure instead of blaming PATH when the version probe errors", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(
        // The generic spawner handle returns PlatformError; fail with the raw
        // message the probe surfaces so the detail branch is covered.
        () => Effect.fail("spawn ENOENT: cmdc") as never,
      );
      const draft = yield* checkCommandcodeProviderStatus(settings, { HOME: "" }, "win32").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SpawnExecutableResolution, () => undefined),
      );
      assert.equal(draft.status, "error");
      assert.isTrue(draft.installed);
      assert.match(draft.message ?? "", /Failed to run `cmdc --version`: spawn ENOENT: cmdc/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a disabled instance without spawning", () =>
    Effect.gen(function* () {
      const invoked: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
        invoked.push(args);
        return Effect.succeed(processHandle("", 0));
      });
      const draft = yield* checkCommandcodeProviderStatus(
        disabledSettings,
        { HOME: "" },
        "win32",
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.deepEqual(invoked, []);
      assert.equal(draft.status, "disabled");
      assert.equal(draft.message, "Command Code is disabled in T3 Code settings.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists the local model catalog with per-model effort options", () =>
    Effect.gen(function* () {
      const home = yield* makeHome([{ name: "catalog-test.json", content: CATALOG_CACHE }]);
      const listed = yield* check(
        JSON.stringify({
          authenticated: true,
          version: "1.88.2",
          user: "someone",
          model: "claude-sonnet-5-5",
        }),
        0,
        home,
      );
      assert.deepEqual(
        listed.draft.models.map((model) => model.slug),
        ["default", "claude-sonnet-5-5", "open-local-model"],
      );
      const effortOptions = {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select" as const,
            options: [
              // The session always offers a synthetic Default first, then the
              // model's own levels — which go past high: xhigh, max, …
              { id: "default", label: "Default" },
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
              { id: "xhigh", label: "Xhigh" },
              { id: "max", label: "Max" },
            ],
          },
        ],
      };
      // The Default row carries the current model's efforts; the catalog row its own.
      assert.deepEqual(listed.draft.models[0]?.capabilities, effortOptions);
      assert.deepEqual(listed.draft.models[1]?.capabilities, effortOptions);
      assert.equal(listed.draft.models[1]?.name, "Claude Sonnet 5.5");
      assert.deepEqual(listed.draft.models[1]?.aliases, ["sonnet-5.5"]);
      // A model without efforts keeps plain capabilities, and id-less rows drop out.
      assert.deepEqual(listed.draft.models[2]?.capabilities, { optionDescriptors: [] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps Default-only models when the cache is missing or unreadable", () =>
    Effect.gen(function* () {
      const missing = yield* check(
        JSON.stringify({ authenticated: true, version: "1.88.2", model: "some-model" }),
        0,
        yield* makeHome(),
      );
      assert.deepEqual(
        missing.draft.models.map((model) => model.slug),
        ["default"],
      );

      const broken = yield* check(
        JSON.stringify({ authenticated: true, version: "1.88.2" }),
        0,
        yield* makeHome([{ name: "catalog-broken.json", content: "{ not json" }]),
      );
      assert.deepEqual(
        broken.draft.models.map((model) => model.slug),
        ["default"],
      );
      assert.equal(broken.draft.status, "ready");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts the older catalog envelope", () =>
    Effect.gen(function* () {
      const home = yield* makeHome([
        {
          name: "catalog-legacy.json",
          content: JSON.stringify({
            catalog: {
              models: [
                {
                  id: "models-dev/id",
                  display: { label: "Models Dev" },
                  aliases: [],
                  reasoningEfforts: ["medium"],
                },
              ],
            },
          }),
        },
      ]);
      const listed = yield* check(
        JSON.stringify({ authenticated: true, version: "1.88.2" }),
        0,
        home,
      );
      assert.deepEqual(
        listed.draft.models.map((model) => model.slug),
        ["default", "models-dev/id"],
      );
      const descriptor = listed.draft.models[1]?.capabilities?.optionDescriptors?.[0];
      assert.equal(descriptor?.type, "select");
      assert.deepEqual(
        descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
        ["default", "medium"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
