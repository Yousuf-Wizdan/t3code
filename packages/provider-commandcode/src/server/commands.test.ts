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
  it("normalizes live commands and seeds base entries when unadvertised", () => {
    expect(
      commandcodeSlashCommandsFromAvailableCommands([
        command("peek", "Peek at the session"),
        command("herdr", "Herd agents", { hint: "task" }),
      ]),
    ).toEqual([
      { name: "compact", description: "Summarize the conversation and reduce context usage" },
      {
        name: "goal",
        description: "Set a goal Command Code keeps working toward until it is done",
        input: { hint: "Objective, or clear" },
      },
      { name: "peek", description: "Peek at the session" },
      { name: "herdr", description: "Herd agents", input: { hint: "task" } },
    ]);
  });

  it("keeps the advertised compact and goal instead of seeding duplicates", () => {
    const commands = commandcodeSlashCommandsFromAvailableCommands([
      command("goal", "Custom goal wording"),
      command("compact", "Custom compact wording"),
    ]);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ name: "compact", description: "Custom compact wording" });
    expect(commands[1]).toEqual({ name: "goal", description: "Custom goal wording" });
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
          command("goal", "Goal"),
        ],
        skills,
      ),
    ).toEqual([
      { name: "compact", description: "Compact" },
      { name: "goal", description: "Goal" },
    ]);
  });

  it("drops blank and duplicate names", () => {
    const commands = commandcodeSlashCommandsFromAvailableCommands([
      command("  ", "blank"),
      command("peek", "first"),
      command("peek", "second"),
    ]);
    expect(commands.map((entry) => entry.name)).toEqual(["compact", "goal", "peek"]);
    expect(commands[2]?.description).toEqual("first");
  });

  it("is base-seeds-only before the first session reports commands", () => {
    expect(commandcodeSlashCommandsFromAvailableCommands([])).toEqual([
      { name: "compact", description: "Summarize the conversation and reduce context usage" },
      {
        name: "goal",
        description: "Set a goal Command Code keeps working toward until it is done",
        input: { hint: "Objective, or clear" },
      },
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
  slashCommands: [
    { name: "compact" },
    {
      name: "goal",
      description: "Set a goal Command Code keeps working toward until it is done",
      input: { hint: "Objective, or clear" },
    },
  ],
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
    expect(merged.slashCommands.map((entry) => entry.name)).toEqual(["compact", "goal", "peek"]);
    expect(merged.skills).toEqual(skills);
  });

  it("stays base-seeds-only when no session has reported and when signed out", () => {
    const unauthenticated = mergeCommandcodeLiveCommands({
      machineSnapshot: machineSnapshot({ status: "unauthenticated" }),
      skills,
      liveCommands: live,
    });
    expect(unauthenticated.slashCommands.map((entry) => entry.name)).toEqual(["compact", "goal"]);

    const pending = mergeCommandcodeLiveCommands({
      machineSnapshot: machineSnapshot({ status: "authenticated" }),
      skills,
      liveCommands: undefined,
    });
    expect(pending.slashCommands.map((entry) => entry.name)).toEqual(["compact", "goal"]);
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
