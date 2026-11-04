import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  commandcodeSkillNames,
  commandcodeSlashCommandsFromAvailableCommands,
  mergeCommandcodeLiveCommands,
  publishCommandcodeLiveCommands,
  readCommandcodeLiveCommands,
} from "./commands.ts";

const command = (name: string, description = `${name} does things`, input?: { hint: string }) => ({
  name,
  description,
  ...(input ? { input: { type: "text" as const, hint: input.hint } } : {}),
});

describe("commandcodeSlashCommandsFromAvailableCommands", () => {
  it("normalizes live commands and seeds compact when unadvertised", () => {
    expect(
      commandcodeSlashCommandsFromAvailableCommands([
        command("peek", "Peek at the session"),
        command("herdr", "Herd agents", { hint: "task" }),
      ]),
    ).toEqual([
      { name: "compact", description: "Summarize the conversation and reduce context usage" },
      { name: "peek", description: "Peek at the session" },
      { name: "herdr", description: "Herd agents", input: { hint: "task" } },
    ]);
  });

  it("keeps the advertised compact instead of seeding a duplicate", () => {
    const commands = commandcodeSlashCommandsFromAvailableCommands([
      command("compact", "Custom compact wording"),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ name: "compact", description: "Custom compact wording" });
  });

  it("hides wrong-surface mod commands and skill names the $ menu already offers", () => {
    const skills = commandcodeSkillNames([{ name: "grilling" }, { name: "TDD" }]);
    expect(
      commandcodeSlashCommandsFromAvailableCommands(
        [
          command("acp", "Connect Command Code to Zed"),
          command("grilling", "Grill the user"),
          command("tdd", "Test-driven development"),
          command("compact", "Compact"),
        ],
        skills,
      ),
    ).toEqual([{ name: "compact", description: "Compact" }]);
  });

  it("drops blank and duplicate names", () => {
    const commands = commandcodeSlashCommandsFromAvailableCommands([
      command("  ", "blank"),
      command("peek", "first"),
      command("peek", "second"),
    ]);
    expect(commands.map((entry) => entry.name)).toEqual(["compact", "peek"]);
    expect(commands[1]?.description).toEqual("first");
  });

  it("is compact-only before the first session reports commands", () => {
    expect(commandcodeSlashCommandsFromAvailableCommands([])).toEqual([
      { name: "compact", description: "Summarize the conversation and reduce context usage" },
    ]);
  });
});

const machineSnapshot = (auth: ServerProvider["auth"]): ServerProvider => ({
  instanceId: ProviderInstanceId.make("commandcode"),
  driver: ProviderDriverKind.make("commandcode"),
  displayName: "Command Code",
  enabled: true,
  installed: true,
  version: "1.88.2",
  status: "ready",
  auth,
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "compact" }],
  skills: [],
});

describe("mergeCommandcodeLiveCommands", () => {
  const skills = [{ name: "grilling", path: "/skills/grilling/SKILL.md", enabled: true }];
  const live = [command("peek", "Peek"), command("grilling", "Grill")];

  it("merges live commands and keeps skills out of the slash menu", () => {
    const merged = mergeCommandcodeLiveCommands({
      machineSnapshot: machineSnapshot({ status: "authenticated" }),
      skills,
      liveCommands: live,
    });
    expect(merged.slashCommands.map((entry) => entry.name)).toEqual(["compact", "peek"]);
    expect(merged.skills).toEqual(skills);
  });

  it("stays compact-only when no session has reported and when signed out", () => {
    const unauthenticated = mergeCommandcodeLiveCommands({
      machineSnapshot: machineSnapshot({ status: "unauthenticated" }),
      skills,
      liveCommands: live,
    });
    expect(unauthenticated.slashCommands.map((entry) => entry.name)).toEqual(["compact"]);

    const pending = mergeCommandcodeLiveCommands({
      machineSnapshot: machineSnapshot({ status: "authenticated" }),
      skills,
      liveCommands: undefined,
    });
    expect(pending.slashCommands.map((entry) => entry.name)).toEqual(["compact"]);
    expect(pending.skills).toEqual(skills);
  });

  it("publishes and reads the latest payload per instance", async () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("commandcode-test-live");
      expect(yield* readCommandcodeLiveCommands(instanceId)).toBeUndefined();
      const payload = [command("peek", "Peek")];
      yield* publishCommandcodeLiveCommands(instanceId, payload);
      expect(yield* readCommandcodeLiveCommands(instanceId)).toEqual(payload);
    }).pipe(Effect.runPromise));
});
