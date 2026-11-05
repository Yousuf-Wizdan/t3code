// Normalizes `cmd acp` live `available_commands_update` payloads into the
// provider snapshot's slash commands. The initialize response never carries
// commands, so this is the only channel; the machine snapshot stays on the
// base seeds (compact, goal) until the first session reports in.
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as Effect from "effect/Effect";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";

// Wrong-surface mod commands: editor setup for other editors, not T3 threads.
const HIDDEN_COMMANDCODE_COMMANDS = new Set(["acp"]);

/** Names the `$` menu already offers via the filesystem skill scan. */
export function commandcodeSkillNames(
  skills: ReadonlyArray<{ readonly name: string }>,
): Set<string> {
  return new Set(skills.map((skill) => skill.name.trim().toLowerCase()));
}

export const COMMANDCODE_BASE_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  COMPACT_SLASH_COMMAND,
  {
    name: "goal",
    description: "Set a goal Command Code keeps working toward until it is done",
    input: { hint: "Objective, or clear" },
  },
  {
    name: "plan",
    description: "Enter or exit plan mode",
    input: { hint: "Subcommand: enter, exit, status" },
  },
  {
    name: "export",
    description: "Export session: html, jsonl, md, or a file path",
    input: { hint: "Format or output path" },
  },
  {
    name: "share",
    description: "Share session as a GitHub gist",
    input: { hint: "gist [html|jsonl|md]" },
  },
];

export function commandcodeSlashCommandsFromAvailableCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  skillNames: ReadonlySet<string> = new Set(),
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>(
    COMMANDCODE_BASE_SLASH_COMMANDS.map((command) => [command.name, command]),
  );
  for (const command of commands) {
    const name = command.name.trim();
    if (name.length === 0) continue;
    const lower = name.toLowerCase();
    if (HIDDEN_COMMANDCODE_COMMANDS.has(lower)) continue;
    if (skillNames.has(lower)) continue;
    const description = command.description.trim();
    const hint = command.input?.type === "text" ? command.input.hint.trim() : "";
    // A live re-advertise of a base seed keeps its seat with live wording;
    // later duplicates stay dropped. Map.set on an existing key preserves
    // insertion order, so the base order never shifts.
    if (byName.has(name)) {
      if (name === COMPACT_SLASH_COMMAND.name || name === "goal") {
        byName.set(name, {
          name,
          ...(description ? { description } : {}),
          ...(hint ? { input: { hint } } : {}),
        });
      }
      continue;
    }
    byName.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return [...byName.values()];
}

// Live commands map: generation counter prevents stale publishes from
// overwriting newer ones; entries evicted on instance destruction.
const liveCommandsByInstance = new Map<
  string,
  {
    readonly commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>;
    readonly generation: number;
  }
>();

export const publishCommandcodeLiveCommands = (
  instanceId: ProviderInstanceId,
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const key = String(instanceId);
    const current = liveCommandsByInstance.get(key);
    liveCommandsByInstance.set(key, {
      commands: [...commands],
      generation: (current?.generation ?? 0) + 1,
    });
  });

export const readCommandcodeLiveCommands = (
  instanceId: ProviderInstanceId,
): Effect.Effect<ReadonlyArray<EffectAcpSchema.AvailableCommand> | undefined> =>
  Effect.sync(() => liveCommandsByInstance.get(String(instanceId))?.commands);

export const clearCommandcodeLiveCommands = (instanceId: ProviderInstanceId): Effect.Effect<void> =>
  Effect.sync(() => {
    liveCommandsByInstance.delete(String(instanceId));
  });

/**
 * Merges the latest live payload into a cwd snapshot. Stale payloads from a
 * previous sign-in never surface: only an authenticated snapshot merges.
 */
export function mergeCommandcodeLiveCommands(input: {
  readonly machineSnapshot: ServerProvider;
  readonly skills: ServerProvider["skills"];
  readonly liveCommands: ReadonlyArray<EffectAcpSchema.AvailableCommand> | undefined;
}): ServerProvider {
  if (input.liveCommands === undefined || input.machineSnapshot.auth.status !== "authenticated") {
    return { ...input.machineSnapshot, skills: input.skills };
  }
  return {
    ...input.machineSnapshot,
    skills: input.skills,
    slashCommands: commandcodeSlashCommandsFromAvailableCommands(
      input.liveCommands,
      commandcodeSkillNames(input.skills),
    ),
  };
}
