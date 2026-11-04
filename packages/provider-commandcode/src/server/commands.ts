// Normalizes `cmd acp` live `available_commands_update` payloads into the
// provider snapshot's slash commands. The initialize response never carries
// commands, so this is the only channel; the machine snapshot stays
// compact-only until the first session reports in.
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

export function commandcodeSlashCommandsFromAvailableCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  skillNames: ReadonlySet<string> = new Set(),
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();
  for (const command of commands) {
    const name = command.name.trim();
    if (name.length === 0) continue;
    const lower = name.toLowerCase();
    if (HIDDEN_COMMANDCODE_COMMANDS.has(lower)) continue;
    if (skillNames.has(lower)) continue;
    if (byName.has(name)) continue;
    const description = command.description.trim();
    const hint = command.input?.type === "text" ? command.input.hint.trim() : "";
    byName.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  if (!byName.has(COMPACT_SLASH_COMMAND.name)) {
    return [COMPACT_SLASH_COMMAND, ...byName.values()];
  }
  return [...byName.values()];
}

// The adapter flavor and the driver snapshot live in different objects with
// no shared service between them, so the latest payload per instance waits
// here until `snapshotForCwd` merges it on pull.
const liveCommandsByInstance = new Map<string, ReadonlyArray<EffectAcpSchema.AvailableCommand>>();

export const publishCommandcodeLiveCommands = (
  instanceId: ProviderInstanceId,
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    liveCommandsByInstance.set(String(instanceId), [...commands]);
  });

export const readCommandcodeLiveCommands = (
  instanceId: ProviderInstanceId,
): Effect.Effect<ReadonlyArray<EffectAcpSchema.AvailableCommand> | undefined> =>
  Effect.sync(() => liveCommandsByInstance.get(String(instanceId)));

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
