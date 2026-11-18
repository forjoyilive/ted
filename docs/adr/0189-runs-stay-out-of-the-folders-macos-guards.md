# Runs stay out of the folders macOS guards

Status: accepted (TED-555). Changes ADR 0047, ADR 0091 and ADR 0121.

During AM-1 the Claude Code Task Lead ran `find ~ -maxdepth 4 -type d -name .ted` and `find ~ -maxdepth 5 -name .env …` to look for files. macOS counts every process Ted starts as Ted, so the user got privacy prompts for Desktop, Documents and Downloads. Those were Bash tool calls inside Claude Code, which Ted’s command sandbox (ADR 0091) never sees. Codex under `workspace-write` reads anywhere too.

Running the whole Provider CLI inside Ted’s Seatbelt profile doesn’t work: macOS refuses a sandbox inside a sandbox (`sandbox_apply: Operation not permitted`), so Codex’s own sandbox, Claude Code’s, and Swift package builds would all break.

## Decision

**One list of personal folders.** `protectedFolders` in `packages/daemon/src/protected-folders.ts` lists the home-relative folders macOS asks about: Desktop, Documents, Downloads, Movies, Music, Pictures, and the personal data under `~/Library` (iCloud Drive, CloudStorage, Containers, Group Containers, Mail, Messages, Safari, Calendars, Reminders, AddressBook). The rest of `~/Library` stays readable, because Xcode, the simulator, Gradle and the Provider CLIs keep settings and caches there.

**Ted’s command sandbox denies them.** On macOS `seatbeltArgs` adds `(deny file-write* file-read-data file-read-xattr …)` for each folder under the real home folder, before the `allow` lines, so a Task whose `TED_HOME` sits inside one (a home folder kept in `~/Documents`) still reaches its own folders. Metadata reads stay allowed, so a path through one still resolves. Linux has no such prompts and is unchanged.

**Claude Code runs its shell commands in its own sandbox on macOS.** Every Claude Run with tools, under `auto` and `bypass`, gets a `sandbox` block in its `settings.json`: `enabled`, `filesystem.denyRead` for the list, and everything else left open: `allowWrite: ["/"]`, `allowedDomains: ["*"]`, `allowLocalBinding`, `allowAllUnixSockets`, `allowMachLookup: ["*"]`. Without these, `ted` commands, git commits, caches, `simctl` and `gh` failed in trials. `autoAllowBashIfSandboxed` is `false`, so what gets approved is unchanged (ADR 0047): under `auto` the allow list is still only `Bash(ted *)`. `permissions.deny` gains `Read(~/<folder>/**)` for the Read, Glob and Grep tools. `failIfUnavailable` stays off, so a missing sandbox never stops a Run; it falls back to today’s behaviour.

**Commands that can’t run inside it rerun outside it.** Electron and Chromium (macOS refuses their Mach service registration), and Swift package builds and other tools that start their own sandbox, fail inside Claude Code’s sandbox; `excludedCommands` had no effect in trials. `allowUnsandboxedCommands` stays `true`, so Claude Code reruns them with `dangerouslyDisableSandbox`; under `auto` its own reviewer approved that without asking. The instructions tell the agent to run these outside the sandbox from the start, so there is no failed first try.

**A guard closes the way back.** A `PreToolUse` hook for Bash (`agents/claude-home-guard.ts`, started through `nodeEntry`) refuses, with exit 2 and a message, a call with `dangerouslyDisableSandbox: true` whose command names the home folder itself (`~`, `$HOME`, `${HOME}` or its path) or a listed folder. The shell part checks for `dangerouslyDisableSandbox` first, so ordinary calls don’t start Node. The match is on text: a command that hides the path (a script, a variable) gets past it, and the instructions cover that.

**Codex under `auto` on macOS gets a permission profile.** In place of `sandbox_mode="workspace-write"` it gets `default_permissions="ted"` and a `ted` profile that extends `:workspace`, denies the list and enables the network, with the same `approval_policy` and `approvals_reviewer` as before (ADR 0121). Codex ignores a profile while `sandbox_mode` is set anywhere in its config, so a user’s own `~/.codex/config.toml` with `sandbox_mode` on a resumed, non-isolated session falls back to the old behaviour. Permission profiles are marked beta by Codex. Under `bypass` Codex has no sandbox and gets only the instructions.

**The instructions say it too.** `preamble.md` and `sub-agent.md` tell the agent not to list or search the home folder or open personal folders, not to retry a refused read outside the sandbox, and to run Electron, Chromium and Swift or Xcode builds outside Claude Code’s sandbox.

## Consequences

- A `find ~` in a Run is refused quietly with “Operation not permitted”; Ted posts nothing.
- A Bash command that writes to the paths Claude Code always protects (`.git/hooks`, `.git/config`, `.claude/`, shell startup files) is refused inside its sandbox and rerun outside it.
- A new personal folder macOS starts guarding is added to `protectedFolders`, which feeds all three places.
- Package downloads in Claude Code’s shell go through its local network proxy.
