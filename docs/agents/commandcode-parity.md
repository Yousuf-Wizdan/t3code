# Command Code provider parity notes

Thin ACP flavor in `packages/provider-commandcode/src/server/` on the generic
adapter (`packages/provider-acp/src/server/adapter.ts`). Copy patterns: fx
(subagents), grok (context/compaction), kiro (fork), registry Devin (terminals).

## What the harness supports natively (no T3 wiring)

- Shell/command execution: the harness runs tools in-process over ACP
  `tool_call` frames. It has no `terminal/create` handler (verified: zero hits
  in the installed bundle), so T3 must NOT pass `clientTerminals` — only Devin
  needs that path (`provider-acp-registry/adapter.ts:299-306`).
- Background tasks: `task_create/task_update/task_list/task_get/task_output/
  task_stop` + `subagent_start/subagent_stop` agent events exist in the bundle.

## What T3 must map (this fork)

- Subagents: `extractCommandcodeSubagentUpdate` in `acpSupport.ts` maps the
  native `subagent` tool (`subagent_type/prompt/description/model`) to
  `AcpAdapterV2SubagentUpdate`; caps `supportsSubagents + emitsSubagentLifecycle`
  in `adapter.ts` (fx pattern).
- Context: `getModelContextWindow` reads `sessionSetupResult.models ??
  sessionModelStateFromInitialize` `_meta.totalContextTokens` (grok pattern);
  `status --json context_window` (1048576, verified live) is threaded into the
  default model's capabilities `_meta` via typed `ModelCapabilities._meta`
  (`packages/contracts/src/model.ts`). Per-turn `PromptResponse.usage` +
  `usage_update {used,size}` flow when `reportsPerTurnPromptUsage:true` (glm
  precedent); window also arrives via `usage_update.size` unconditionally.
- Compaction: `supportsCompaction:true` (grok); fork-head `canForkThread:true`,
  `canForkFromTurn:false` until `cmd acp` advertises `session/fork`.
- Auth stays probe-only (`cmdc status --json`, fx/kiro precedent) — no
  `ProviderAuthController`. Slash seeding stays live-merge
  (`onAvailableCommandsUpdate` → `publishCommandcodeLiveCommands`).

Never patch the harness (`C:\Users\yousu\AppData\Roaming\npm\node_modules\
command-code`) — T3 layer only.
