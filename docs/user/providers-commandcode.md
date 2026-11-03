# Command Code

T3 Code can run [Command Code](https://commandcode.ai). Command Code uses the login on the machine that runs the T3 Code server.

## Set up Command Code

1. Install the CLI on that machine:

   ```bash
   npm i -g command-code
   ```

2. Run `cmd login` in a terminal on that machine (`cmdc login` in PowerShell; on Windows `cmd` is the Windows command processor).
3. Open **Settings → Providers**, select **Add provider**, find Command Code, and enable it.

When **Binary path** is blank, T3 Code picks the executable per platform: `cmdc` on Windows, `cmd` on macOS and Linux. Set **Binary path** only if the CLI lives somewhere unusual.

Every Command Code instance on the same machine shares that machine's `cmd login`. T3 Code does not keep a separate login per instance.

## Models and effort

The model picker lists **Default** first. That option keeps the model the Command Code session already runs. Every other row comes from Command Code's own local model catalog — the same one `/model` reads — refreshed whenever the CLI refreshes it, so the full catalog is available before a thread is opened. A custom model you add in the provider settings goes to Command Code as is, and Command Code reports an error if its backend does not offer it.

Each model carries an **Effort** control that mirrors the session's exactly: **Default** first (the level the model itself uses when nothing is pinned), then every level Command Code offers for it in `/effort` — such as `off, high, max` on DeepSeek V4 Flash or `low … max` on Claude. A model without effort levels shows no control. Your choice applies when the thread's session opens, the same way the terminal's `/effort` does.

## Permission modes

T3 Code offers all four of its modes, and Command Code enforces each one itself:

| Mode                  | Command Code mode  | Behavior                                                              |
| --------------------- | ------------------ | --------------------------------------------------------------------- |
| **Supervised**        | Standard           | Command Code asks before it changes files or runs commands.           |
| **Auto-accept edits** | Accept Edits       | File edits are accepted automatically; riskier actions still ask.     |
| **Auto**              | Don't Ask          | Command Code acts without prompting, keeping its own safety rails on. |
| **Full access**       | Bypass Permissions | Command Code skips its permission checks.                             |

An explicit approval or sandbox policy always launches Command Code in its Standard mode, so Command Code cannot bypass a policy T3 Code set. Command Code's own Plan mode (read-only research) is available from the mode picker in the composer's model options; plan output arrives as ordinary conversation messages.

## Sessions

Expand the provider card in **Settings → Providers**, choose a project, and select **List sessions** to import an existing Command Code session into a thread. Importing the same session again returns the same thread.

## Checkpoints

Checkpoint rollback restores your files as usual. Command Code cannot rewind its own conversation, so the next turn after a rollback continues the session without the pre-checkpoint conversation history.

## Commands and skills

Slash commands and skills Command Code provides appear under **Provider** in the `/` menu while a session runs; `$`-prefixed skills open from T3 Code's `$` menu.

## Text generation

Command Code can generate thread titles, commit messages, pull request text, and branch names. T3 Code runs these as short headless `cmd -p --no-session` queries that keep nothing on disk.

## Taste learning

Command Code learns your coding taste from accepted and rejected work. The provider settings' **Taste learning** switch controls it for this user (every project on this machine):

| Setting                           | Behavior                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Leave as configured** (default) | Never changes Command Code's own state; whatever the CLI says stays.                                |
| **Disabled**                      | Runs `cmdc taste disable` (`cmd taste disable` on macOS/Linux) for this user when a session starts. |
| **Enabled**                       | Runs `cmdc taste enable` (`cmd taste enable` on macOS/Linux) for this user when a session starts.   |

State is read first, so the command only runs when the state actually differs — switching the terminal's own `cmdc taste off`/`on` stays in effect until a T3 session with a different setting starts. The same two commands work directly in any terminal.

## Not supported yet

- Usage and credit limits in T3 Code's Usage screens. Command Code has no machine-readable quota command; run `/usage` in Command Code for your plan and credits.
- Dedicated sub-agent threads. Command Code's sub-agents report as tool activity inside the parent thread.

See [provider setup](./install.md#providers) and [Permission modes](./permission-modes.md).
