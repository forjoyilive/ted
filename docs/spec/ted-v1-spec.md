# TED v1 spec

Status: ready to split into build tickets, 2026-11-08. Built from the map [KRI-8](https://linear.app/kriyadesign/issue/KRI-8), the resolution comments and replies on KRI-9 to KRI-23 and KRI-52 to KRI-66, the KRI-8 comments “Figma consistency pass” and “Polish pass”, `GLOSSARY.md`, and ADRs 0001 to 0007. Many of the KRI-53 to KRI-66 resolutions were decided by Claude on Nabha’s behalf and are marked “pending review” in Linear; this spec states them as decided.

How to read it:

- Each rule ends with its source ticket in brackets, for example (KRI-60). Where a reply or a later ticket changed a rule, the spec states the current rule and cites the ticket that set it.
- Terms are the glossary’s. Capitalized words (Task, Run, Stage, Gate, Factory, …) mean exactly what `GLOSSARY.md` says.
- Screen detail is here only where a builder needs it. The Figma file is the reference for the rest: [TED in Figma](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED), one page per prototype ticket: “KRI-61 Task thread”, “KRI-62 Board and List”, “KRI-63 Task details”, “KRI-64 First launch and Settings”, “KRI-65 Factory setup and settings” and “KRI-66 Automations and Plans”. Page 1 holds the KRI-13 and KRI-23 frames.
- Open questions that remain are listed at the top of `ted-v1-gaps.md`.

---

## 1. Overview and scope

TED (“Totally Excellent Development”) is a desktop app for running software factories. Agents carry development Tasks through a configurable Workflow of Stages. The human steers through the Inbox and Comments. (KRI-8)

- **Solo.** One user per machine. (KRI-8)
- **Desktop only.** macOS and Linux. No Windows, no phone. (KRI-14, KRI-8)
- **Multiplayer is not built, only not locked out.** The store is built for sync from day one. Each Task has a stable internal ID next to its display ID, so a sync backend can renumber clashing IDs later. (KRI-8, KRI-9, KRI-58)
- **One machine.** Each machine has its own daemon, limit on working Runs and queue. Nothing in v1 may assume there is only one machine. (KRI-15)
- **Agents:** Claude Code and Codex, run through the user’s own installed CLIs. (KRI-14, KRI-21, ADR 0004)
- **Code host:** GitHub only, through the user’s `gh` login. GitHub Enterprise works wherever `gh` is signed in to that host. (KRI-20, KRI-57, ADR 0007)
- **Language:** English only. (KRI-20)
- **Built standalone.** TED ports logic from agent-orchestrator (agent launch flags, PTY handling, worktree setup, sending CI failures and review comments to agents, the preview server manager, the chat host) and copies React UI code under Apache-2.0, preserving applicable upstream notices and marking changed files. (KRI-14, KRI-18, KRI-20, ADR 0003)

---

## 2. Architecture

### 2.1 Processes

- **Daemon.** A headless TypeScript process on Node. It owns agent processes, PTYs, the store, Apps, simulators, GitHub watching, Automations and the CLI/MCP server. It listens on `127.0.0.1` only (HTTP, SSE and WebSocket). (KRI-10, KRI-59)
- The daemon ships inside the Electron app and runs with `ELECTRON_RUN_AS_NODE`, so there is one runtime to sign and update. (KRI-10)
- **Per-Run hosts.** Agents and Apps run in detached hosts, so closing the window, a daemon crash or an update doesn’t stop them. A restarted daemon reattaches to every host and reads the output it missed. (KRI-10, KRI-59)
- **Electron app.** A client only. It talks to the daemon and nothing else. It renders the Inbox, Views, Run chats, shells (xterm.js) and diffs. Local web Apps open in a Task browser; hosted previews and the browser’s Open ↗ action open in the default browser. (KRI-10, KRI-18, KRI-34, ADR 0097)
- Whenever the daemon runs from the app, the app process stays alive with its menu-bar icon (tray on Linux), even with no window open. Notifications and the unread count belong to the app. (KRI-59, KRI-57)
- The UI never says “daemon”. It says “TED” or “TED in the background”. Docs and the CLI may say daemon. (KRI-59)
- Tauri 2 is the runner-up. Because the app is only a client, switching later is a contained change. (KRI-10)

### 2.2 Store

- **LiveStore:** an event log in SQLite, offline-first, with a swappable sync backend (0.5.0, beta). PowerSync is the fallback if LiveStore hits blockers. (KRI-9)
- The daemon is the only process that owns the store. The app, CLI and MCP server read and write through it. (KRI-9)
- TED never rewrites events. A changed event gets a new versioned name (`v2.TaskCreated`) and the old one keeps its handler. State tables rebuild from the log when their schema changes. (KRI-59)
- Attachments: metadata in the store; bytes on disk, addressed by content hash. (KRI-9)
- Tasks, Comments, the Inbox, Runs, Automations and Planning Runs live in the store. (KRI-8, KRI-60)
- Everything TED keeps lives under `~/.ted/`: the store, clones (`repos/`), worktrees (`worktrees/`), the Library (`library/`), logs (`logs/`), backups (`backups/`), `daemon.json` and, on Linux without a keyring, `secrets/`. (KRI-8, KRI-58, KRI-59, KRI-57, ADR 0006)

### 2.3 The `ted` CLI, MCP server and local authentication

- The `ted` CLI is the contract between agents and TED. An MCP server (`ted mcp`) mirrors it one to one. Both send requests to the daemon. (KRI-11, KRI-59)
- TED puts `ted` on the `PATH` of every Run. People install it from Settings → General → Command line (11.3). deb and rpm packages install `/usr/bin/ted`. (KRI-59, KRI-57)
- If the daemon isn’t running, `ted` starts it and retries for up to 2 minutes. A daemon started this way shows no icon and exits after a minute with nothing to do. An enabled Automation counts as something to do. (KRI-11, KRI-59)
- **Loopback auth.** The daemon picks a port and writes it with a random token to `~/.ted/daemon.json` (mode 0600), replaced at each start. The app, CLI and MCP server send the token with every request. That token may read everything but changes only what the `ted` commands outside a Run need; answering or approving any Inbox item, changing settings and the other human decisions need requests signed with the app’s own key, which the app hands to the daemon it starts and never writes to disk or sends. (ADR 0054-the-app-holds-the-human-token-in-memory) Requests without it are refused, except `/healthz`, which returns only “ok” and the version. Requests whose `Host` isn’t `127.0.0.1` or `localhost`, or that carry a browser `Origin`, are refused. (KRI-59)
- **Run environment.** Each Run gets `TED_TASK`, `TED_RUN` and its own Run token in `TED_RUN_CAPABILITY`, so commands need no IDs. Outside a Run, commands take `--task`. (KRI-11, KRI-59)
- **What a Run token may do.** A Run acts only on its own Task, or, for an Automation or Planning Run, on what it creates. The current Task Lead may also read peer context and send attributed plain notes to Tasks in its own Factory through the dedicated peer routes; this grants no control over those Tasks. (KRI-160) (KRI-59)
  - Allowed: post Comments and set the activity line; report outcomes (the Task Lead only); start, message and stop its own sub-agents; edit its own Task’s title, description, Repos and blockers (`ted task block` may name any Task as the blocker); create Tasks (Automations through `ted task create`, Splits and Planning Runs through `ted task propose`); read Tasks, the brief and Checks; report its own tool-call boundary so TED can deliver a queued Run-chat message (10.6).
  - Refused: answering or approving any Inbox item; signing off, merging, archiving or deleting; editing any other Task; changing settings, Automations or `workflow.yaml` through the API. A Task may still change `.ted/` files on its branch, which go through review.
  - Run tokens prevent mistakes. Agents run as the same user and can read `daemon.json`, so the human’s decisions need the app’s in-memory token, not that file’s. (ADR 0054-the-app-holds-the-human-token-in-memory)
- Credential variables, including `GH_TOKEN`, `GITHUB_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`, are kept out of the commands agents run, so a prompt-injected command can’t read them. Agents only commit; TED pushes (9.1). (KRI-59, ADR 0057)
- The full command set is in 7.10.

#### Peer coordination (KRI-160)

`ted peers [--offset <n>]` lists other unarchived Tasks in the current Task Lead’s Factory, with their Stage, derived status and reported activity, selected repos, Lead state, brief timestamp, snapshot time and change cursor. `ted peers show <Task>` reads the current description, Original request and latest brief. `ted peers watch [--cursor <cursor>] [--timeout <seconds>]` returns a fresh page when the snapshot changes or after at most 25 seconds. This exposes reported activity, not Conversations or tool output. Responses contain at most 30 Tasks; `nextOffset` continues the listing.

`ted peers send <Task> --operation <unique-id> "<text>"` records a plain Comment attributed to the sending Run and Task. The operation ID is unique within the sending Task: replaying the same recipient and text returns the original receipt, and changing either fails. Text is limited to 8 KiB, with at most 20 pending notes from one Task to another. `ted peers inbox [--offset <n>]` lists received messages, pending first, with delivery receipts and at most 30 per page. Delivered means handed to the agent transport, not understood or acted on.

The daemon derives the Factory from the current Lead’s verified Run. Sub-agents, stale Leads, Planning and Automation Runs cannot use these commands. Cross-Factory targets, self-targets and archived targets are refused; Done Tasks cannot receive new notes. Peer context grants no human authorization. Sending starts no Task, changes no queue order, answers no Gate and cancels no Merge. Working Leads receive notes at their next safe boundary while no request is awaiting the human; stopped or idle Tasks retain pending notes for their next normal start. Notes follow the recipient Task across Lead replacement, persist atomically with their Comments, and reuse the existing Comment delivery receipt. Recipient Task and Factory deletion remove peer projections. Deleting a sender retains notes already posted to other Tasks, including their stored sender attribution and pending delivery.

### 2.4 OS permissions and secrets

- Asked for only when needed. (KRI-20)
  - Notifications: when the first Inbox item arrives. (KRI-20, KRI-57)
  - Protected macOS folders (Documents, Desktop, Downloads, iCloud Drive): the first time TED reads a folder chosen in the Add Factory form or as a repo’s local folder. (KRI-20, KRI-58)
  - Never requested: Accessibility, Screen Recording, Full Disk Access, microphone, camera, Automation. (KRI-20, KRI-57)
- **Secrets.** The Linear API key is the only secret TED stores. TED holds no agent credentials and no GitHub token. (KRI-57, ADR 0004, ADR 0007)
- The daemon writes the Linear key to the OS keyring through a native module (for example `@napi-rs/keyring`): the macOS Keychain, or the Secret Service over D-Bus on Linux. Service `TED`, account `linear-api-key`. Not Electron’s `safeStorage`, which works only in the main process and falls back to a hardcoded password on Linux. (KRI-57)
- **Linux with no Secret Service:** TED never falls back silently. The Linear row says “No keyring found on this computer” and offers **Save in a file only you can read**, which writes `~/.ted/secrets/linear-api-key` (file 0600, folder 0700). A locked keyring shows “Keyring is locked”. **Remove** deletes the key wherever it was stored. (KRI-57)
- The daemon uses the Linear key only to fill in a Task from a pasted Linear URL. It is never passed to agents. (KRI-57)

### 2.5 Finding CLIs and the environment

- Apps started by the OS don’t get the user’s shell `PATH`. When TED in the background starts, and on every **Check again**, it reads the user’s login-shell environment (`$SHELL -l -i -c env`, 10-second timeout). If that fails, it falls back to `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and npm’s and bun’s global bins. (KRI-57)
- Health checks run each CLI with exactly the environment its Runs will get. Each health row shows the binary path it found. (KRI-57)
- Every Fix that runs a CLI command opens it in the user’s own terminal app, never TED’s embedded terminal, because a pasted login code would pass through TED’s process. On macOS that is Terminal.app through a temporary `.command` file opened with `open -a Terminal`. On Linux it is the first of `$TERMINAL`, `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm`. **Copy command** is always next to it. After opening a terminal, TED checks again when its window regains focus, and every 5 seconds while the first-launch screen or the Settings row is open. (KRI-57)
- Commands Fix runs: `claude auth login`, `codex login`, `gh auth login --web --hostname <host> -s workflow`, `gh auth refresh -s workflow`, `gh auth setup-git`, `claude update`, `codex update`, or the brew, npm or apt command when a CLI can’t update itself. (KRI-54, KRI-57)

---

## 3. Daemon operations

Figma: KRI-64 First launch and Settings (Reconnecting, data screens, banners, menu-bar menu, footer chips).

### 3.1 Closing, quitting and keeping it alive

- Closing the window keeps Runs going behind the menu-bar icon (tray on Linux). (KRI-11)
- **Quit** (⌘Q) with work running asks: **Keep running in the background** (default) / **Stop them and quit** / **Cancel**. “Work running” means active Runs or enabled Automations. With only Automations on, the dialog reads “2 Automations are on. Keep TED running in the background so they fire?”, with the same three buttons. (KRI-11, KRI-59, KRI-64)
- The choice can be remembered in Settings → General → **When you quit with work running**: Ask each time (default), Keep running in the background, Stop it and quit. (KRI-57)
- Keep running closes every window and the Dock icon but keeps the menu-bar icon. **Quit TED completely** in that menu ends the app and the daemon. With nothing running, Quit ends both. (KRI-59, KRI-11)
- **Missed Automation firings:** after sleep or downtime, each Automation that missed one or more slots fires once on start, shown as “Made up” in its history. Automations don’t keep the machine awake. (KRI-59, KRI-66)
- **Stay Awake** while any Run is working, on by default (`caffeinate` on macOS, `systemd-inhibit` on Linux). (KRI-20)

### 3.2 Start at login

- Offered on the first-launch screen, checked by default; a toggle in Settings → General. (KRI-57)
- At login TED starts the app in the background with its menu-bar icon and the daemon, with no window, so notifications, the unread count and Automations all work. (KRI-57)
- macOS: a LaunchAgent in the app bundle registered through `SMAppService` (Electron `setLoginItemSettings` with `type: 'agentService'`), starting the app with `--background`. If macOS reports `requires-approval`, the toggle shows “Allow TED in System Settings → Login Items” with a button that opens that pane. (KRI-57)
- Linux: an XDG autostart entry, `~/.config/autostart/ted.desktop`, running `ted-app --background`. For AppImage it is rewritten after each update. (KRI-57)
- A TED started at login stays running until **Quit TED completely**. (KRI-57)

### 3.3 Daemon crashes

- A crash doesn’t stop agents or Apps (2.1). The app restarts the daemon at once, then after 5 s and 30 s. (KRI-59, KRI-57)
- **While it is down:** a dark bar across the top of the window, above every banner: “Reconnecting to TED… Runs keep going. Actions are off until TED is back.” The last screen stays, dimmed; every action is disabled. (KRI-59, KRI-64)
- **After 3 crashes in 10 minutes** TED stops restarting and shows the stops-work banner “TED’s background process keeps stopping”, with **Restart ▾** (its menu holds **Copy report**) and one notification. Copy report collects the last daemon log and crash output with no upload. Crash output goes to `~/.ted/logs/`. (KRI-59, KRI-64)

### 3.4 Updates

- One stable channel. The app downloads updates in the background. (KRI-20, KRI-59)
- When one is ready, a blue chip in the sidebar footer reads “Update ready · Restart”, and the menu-bar menu shows “Restart to update to 1.4”. (KRI-59, KRI-64)
- **Restarting never stops Runs.** It restarts the app and the daemon; agents and Apps keep running in their hosts and the new daemon reattaches. The daemon first waits for running Checks and an in-progress merge (up to 10 minutes), and the chip reads “Finishing 2 Checks…”. (KRI-59, KRI-64)
- If the human doesn’t click, the update installs the next time every window is closed, or at the next launch. (KRI-59)
- If an old host can’t talk to the new daemon, the daemon restarts that agent at its next idle point, resuming the same Run. (KRI-59, KRI-53)
- A failed install, on any platform, is the warning banner “Update to 1.4 failed” with **Download**. (KRI-59)
- Agent CLIs update separately and never silently (7.5). (KRI-54)

### 3.5 Disk use and a full disk

- TED watches free space on the volume that holds `~/.ted/`. (KRI-59)
  - **Below 10 GB:** warning banner “Disk almost full · 8.2 GB free”, with **Open** (Settings → Storage).
  - **Below 2 GB:** TED holds new work. Queued Tasks show “Queued · disk full”; no new Runs, Apps, simulators or Automation firings start. Running Runs keep going. Stops-work banner “Disk full · new work held · 1.4 GB free” and one notification.
  - **Above 4 GB** TED releases the hold by itself. Held Automation firings make up once.
- If a store write fails anyway, the daemon stops accepting changes and shows “TED can’t save changes: disk full” until a write succeeds. (KRI-59)
- Worktrees, clones and simulators are excluded from Time Machine; the store and backups stay included. (KRI-59)
- Cleanup lives in Settings → Storage (11.3). (KRI-59)

### 3.6 Migrations, backups and retention

- When an update changes the schema, the first start shows a full-window “Updating TED’s data…” screen with progress (“38,140 of 61,090 events · about a minute left”). Runs keep going. (KRI-59, KRI-64)
- **Before every schema-changing update**, TED copies the store to `~/.ted/backups/`, keeping the last three such copies. (KRI-59)
- **Daily backup:** the event log and attachment list (not worktrees, clones or simulators), keeping 7. Attachment files are stored by hash and not copied again. (KRI-59)
- **Restore** is `ted backup restore <name>`, which asks to stop all Runs first and copies the current data to `~/.ted/backups/` before restoring. (KRI-59, KRI-64)
- If a rebuild fails, or the store was written by a newer TED, a full-window screen shows “TED couldn’t update its data” or “This data needs TED 1.4 or later”, with **Restore the backup from before the update (loses changes since <date>)**, **Copy report**, and **Download TED 1.4** or **Quit TED**. Each screen ends “Runs keep going in the background.” (KRI-59, KRI-64)
- `ted export --factory <key> [--format json|markdown] --output <path>` and Settings → Storage → Export a Factory save a single-file snapshot of all retained Tasks, including Done and archived Tasks, Comments and answers, saved brief and description versions, and Task Run metadata. JSON is the default. Existing destinations are refused. Attachment names and references are included, but attached files, Run Conversations, deleted records, repo files and non-Task Runs are excluded. Known token-shaped secrets and URL credentials are redacted. Export is for reading outside TED; use backups to restore TED data. (KRI-71)
- **Kept:** (KRI-59)
  - The event log, forever. No compaction in v1 (KRI-73).
  - Conversations and raw Run output, for as long as their Task is open. After the Task is Done or archived, for the number of days set in Settings → Storage (7 by default). A Run without a Task keeps them that long after it finishes; a Coordinator’s Runs keep them while the Coordinator exists (ADR 0098).
  - App logs, the last 10 MB per running App, deleted with the worktree.
  - TED’s own logs, 7 rolling files of 20 MB.
- Deleting a Task removes its Conversations, raw output, logs and attachments from disk at once. Its events stay in the event log, which only TED reads. (KRI-59)

### 3.7 Banners: where machine and Factory problems show

- **Two banner areas.** App-wide banners sit above everything in the middle pane on every screen. Factory banners sit under the Factory page header, on every page of that Factory (Board, List, Plans, Automations, Settings) and nowhere else. All Tasks shows app-wide banners only. (KRI-56, KRI-62)
- **Rules for every banner:** (KRI-59, KRI-64)
  - One line: what is wrong, what it affects (“3 Runs paused”), and one action button (Fix, Open, Restart, Locate, Retry).
  - **Stops work:** red tint and dot, not dismissable, clears itself when the problem clears.
  - **Warning:** amber tint and dot, × dismisses it for 24 hours, also clears itself.
  - Stops-work first, then warnings, newest first within each. Two show; the rest fold into “+3 more · 1 stops work, 2 warnings · Show all ▾”, which expands in place.
  - A notification fires once when a stops-work problem starts, never when it clears. Warnings never notify.
  - None are Inbox items. `ted status` and `ted doctor` print every active banner.
- The menu-bar icon shows a warning dot and lists the problem while any app-wide banner is up. Factory banners don’t touch it. (KRI-59)
- A Factory with a stops-work Factory banner gets a red ⚠ on its sidebar row. Warnings put nothing on the row. (KRI-56, KRI-59, KRI-62)

**App-wide banners** (KRI-59, KRI-54, KRI-57)

| Problem | Kind | Example text | Action |
|---|---|---|---|
| Agent signed out, not installed, below minimum version, or using the wrong credential | Stops work for that agent kind | “Claude Code is signed out · 3 Runs paused” | Fix |
| Agent usage limit | Stops work for that agent kind | “Claude usage limit · resets 14:20 · 3 Runs paused” | Open (Settings → Agents) |
| Offline | Stops work | “You’re offline · 5 Runs paused until the connection returns” | none |
| GitHub CLI missing or signed out | Stops work (merges, pull request watching) | “GitHub CLI is signed out · 2 Tasks waiting to merge · Fix”, or “· needed to add a Factory” with no Task at Merge | Fix |
| GitHub rate limit lasting over 15 minutes | Warning | “GitHub rate limit · checking again at 14:05” | none |
| TED keeps stopping | Stops work | “TED’s background process keeps stopping” | Restart ▾ |
| Disk full | Stops work | “Disk full · new work held · 1.4 GB free” | Open |
| Store write failed | Stops work | “TED can’t save changes: disk full” | Open |
| Disk almost full | Warning | “Disk almost full · 8.2 GB free” | Open |
| Update failed to install | Warning | “Update to 1.4 failed” | Download |
| Daily backup failed | Warning | “Today’s backup failed: <reason>” | Open |

**Factory banners** (KRI-59, KRI-65, KRI-57)

| Problem | Kind | Example text | Action |
|---|---|---|---|
| Setup not finished | Warning | “Setup isn’t finished · Tasks use TED’s defaults until it merges” | Open setup Task |
| Setup suggested (repos changed, a Check’s command not found) | Warning | “A Check’s command wasn’t found: `pnpm test:e2e`” | Open Factory settings |
| No Checks | Warning | “No Checks set up · Validate relies on the agent alone” | Open Factory settings |
| `workflow.yaml` or a Stage file has an error | Warning, with or without an earlier valid version | “workflow.yaml has an error on line 12 · using the last valid version (a1b2c3d)” | Open Factory settings |
| A repo is gone on GitHub, or access lost | Stops work for Tasks whose Repos include it | “Can’t find kriya/notebook-api on GitHub · 2 Tasks can’t start” | Fix (Settings → Repos) |
| The GitHub login can’t push to a repo | Stops work for that repo | “Your GitHub login can’t push to kriya/app” | Fix |
| A repo’s local folder is missing | Warning (only copy files are skipped) | “Local folder for notebook-api not found” | Locate |
| Clone failed | Stops work for the Factory | “Couldn’t clone kriya/billing-web · Billing can’t start Tasks until it’s cloned” | Retry |
| `git fetch` fails (network) | Warning | “Can’t fetch notebook-api: couldn’t reach github.com · Tasks start from the last fetch” | Open Factory settings |
| A tool an App needs is missing | Stops work for those Apps | “Xcode not found · iOS simulator Apps can’t start” | Fix |
| An Automation failed 3 firings in a row | Warning | “Automation “Daily triage” failed 3 times in a row” | Open the Automation |

- A deleted TED clone is cloned again before the next worktree, with no banner. If that fails, the clone-failed banner shows. (KRI-65)
- **Not banners:** the Reconnecting bar (3.3); the full-window data screens (3.6); Update ready and plan usage, which are sidebar footer chips; notifications turned off in the OS, a red row in Settings → Notifications; a missing or invalid Linear key, an inline error where a URL is pasted and a red row in Settings → Integrations; drift, which sits on the Stage’s row in Factory settings (5.5); Task problems, which are Task statuses (6.6). (KRI-59, KRI-64, KRI-65)

### 3.8 Notifications

- Settings → Notifications has three switches and a sound switch: (KRI-59, KRI-57, KRI-64)
  - **Inbox items** (on): one notification per new Inbox item. This covers Failed Tasks, permission requests, sign-offs and the idle ask.
  - **Problems that stop work** (on): one notification when such a problem starts.
  - **Task merged** (off): one notification when a Task reaches Done.
  - **Play a sound** (off).
- More than 3 notifications within a minute fold into one: “5 new items in your Inbox”. Clicking opens the Task, or the Settings section for a problem. (KRI-59)
- No notifications for warnings, updates, failed Automation Runs or Tasks starting. No per-Factory mute or quiet hours; the OS’s Focus covers it. No Dock bounce, no separate feed. (KRI-59, KRI-20)
- **Badges:** the sidebar Inbox count, the Dock badge and the menu-bar count all show the number of open Inbox requests, read or not, across Tasks, Automations and planning chats. Two open requests on one Task count as two; a waiting Run without an Inbox request adds nothing. Notes and answered requests don’t count, and archived Tasks’ requests are excluded. (KRI-56, KRI-168; ADR 0088)

### 3.9 Menu-bar menu, and Linux without a tray

- On macOS the icon shows the Inbox count when above zero, and a warning dot while an app-wide banner is up. (KRI-59)
- The menu, top to bottom: (KRI-59, KRI-64)
  1. “3 waiting on you”: opens the Inbox.
  2. “5 of 6 Runs working · 2 queued”: information only.
  3. One line per app-wide problem, with a red or amber dot: opens its Fix.
  4. “Restart to update to 1.4”, when an update is ready.
  5. Open TED, New Task… ⌘N, Settings… ⌘,
  6. Quit TED completely ⌘Q, which asks about work running (3.1).
- Every item is also in the app’s own menus. (KRI-59)
- **Linux menu bar.** Use the native Electron menu bar, with a TED menu holding the same items as the macOS menu-bar menu. This follows the desktop’s own look and keeps the implementation simple. It supersedes the ☰ menu button shown in Figma. ([KRI-169](https://linear.app/kriyadesign/issue/KRI-169/should-ted-on-linux-use-a-native-menu-bar-instead-of-the-menu-in-figma))
- **Linux.** Electron’s tray uses StatusNotifierItem, which stock GNOME doesn’t show. So closing the window keeps TED running, as on macOS. The first time the window closes, TED sends one notification: “TED is still running in the background. Open it again from your app launcher.” Opening TED again focuses the running instance (one instance only); `ted open` does the same. Settings → General has **Show tray icon** (on). The Linux app menu holds the same items as the macOS menu-bar menu. The Inbox count shows in the window title (“TED (3)”) and on the launcher icon where supported. (KRI-59, KRI-64)

---

## 4. Factory and Workflow

### 4.1 Factory

- A **Factory** carries Tasks from creation to merge for one product. It may span several repos. (KRI-8)
- Its first repo is the **primary repo**. The Factory’s overrides live in that repo’s `.ted/` folder, so they are versioned and reviewable. (KRI-8, KRI-12)
- A repo can be the primary repo of only one Factory, matched by owner/repo. A repo can be a secondary repo in any number of Factories. (KRI-22, KRI-58)
- A Factory’s name, key and machine-only settings (local folders, sidebar order) live in TED’s store, not in `workflow.yaml`. A Factory with one repo and no overrides needs no `.ted/` folder. (KRI-12, KRI-58)
- Running the Workflow without TED is not a goal. TED never writes to `AGENTS.md`. Agents read the repo’s own `AGENTS.md` / `CLAUDE.md`; TED has no rules-file feature. (ADR 0001, KRI-12, KRI-20)

### 4.2 Factory key and Task IDs

- Each Factory has a **Factory key**: 2 to 5 characters, uppercase letters and digits, starting with a letter, unique on this machine. Chosen in the Add Factory form, suggested from the name (“Nabha’s Blog” → `NB`). It can’t be changed after the Factory is added (KRI-75). (KRI-58)
- Task IDs are `<key>-<n>`, counting from 1 per Factory. The setup Task is `NB-1`. (KRI-58)
- `NB-44` is a display ID. Each Task also has a stable internal ID that links and blockers use. Search matches an exact ID across every Factory. (KRI-58)

### 4.3 Clones, worktrees and local folders

- **TED works in its own clones** (ADR 0006). One full clone per GitHub repo under `~/.ted/repos/<owner>/<repo>/`, shared by every Factory that uses the repo. Task worktrees live under `~/.ted/worktrees/<TASK-ID>/<name>/`. TED never adds worktrees to, checks out in, or writes to the user’s own clone. (KRI-58, ADR 0006)
- **Local folder.** A repo added from a folder remembers that folder as its local folder on this machine, in TED’s store, never in `workflow.yaml`. Its only use is as the source of `copy` files. A repo added by URL has no local folder until the human sets one in Factory settings → Repos. (KRI-58, glossary)
- Clones and fetches use plain `git` with the user’s own git credentials (SSH keys or an HTTPS credential helper). TED never passes `gh`’s token to git and never changes the user’s git config. If an HTTPS clone fails while `gh` is signed in, Fix suggests `gh auth setup-git` in the user’s terminal. (KRI-57, ADR 0007)
- TED fetches a clone before creating a worktree from it, so Task branches start from the latest `origin/<base_branch>`. (KRI-58)
- **Where `.ted/` is read from:** always the primary repo’s GitHub default branch (`origin/<default>`), fetched at each Stage entry, whatever `base_branch` says. Every pull request TED opens to change `.ted/` (setup Tasks, settings Save, drift merges) targets that branch. (KRI-58)

### 4.4 Layers

Three layers, each with the same layout (`workflow.yaml` and `stages/*.md`): (KRI-12, ADR 0002)

1. **TED defaults**, shipped inside the app. Readable, not editable.
2. **Library**, in `~/.ted/library/`. Applies to all of the user’s Factories.
3. **Factory**, in `.ted/` in the primary repo.

Rules:

- The more specific layer wins. (KRI-12)
- TED resolves the layers each time a Task enters a Stage. A Library edit or a TED update can change a running Task, starting at its next Stage. TED records which file and layer each Stage entry used. (ADR 0002, KRI-12)
- `order` is all or nothing: the most specific layer that has one wins outright. (KRI-12)
- `stages.<id>` settings and `lead`, `reviewer`, `planner` merge key by key across layers. (KRI-12, KRI-53)
- A Stage file in a more specific layer replaces the one with the same id as a whole. (KRI-12)
- Every Workflow setting, including Gates and whether Design is on, can be set in the Library and per Factory. Factory-only keys: `repos` (with `apps`, `merge_method`, `worktree`), Checks and `max_working_runs`. Permission mode is machine-local per Factory (7.8); a legacy `permissions` key is advisory only. (KRI-12, KRI-53, KRI-57)
- Any Task TED creates to change `.ted/` (setup, drift merge) has the Review Gate forced on. Setup also forces the Design Gate. (KRI-22, KRI-58)

### 4.5 `workflow.yaml`

| Key | Where | Meaning | Source |
|---|---|---|---|
| `version` | any layer | Schema version, `1`. | KRI-12 |
| `lead` | any layer, merged | The Task Lead’s agent: `claude` or `codex`, or `{agent, model, effort}`. One Task Lead Run spans all Stages. Default agent: Claude if installed, else Codex. | KRI-12, KRI-53 |
| `reviewer` | any layer, merged | `codex`, `claude` or `same`, or `{agent, model, effort}`. Validate’s reviewer and the loop check. Default: the other kind when both are installed, else `same`. | KRI-16, KRI-53 |
| `planner` | any layer, merged | Agent for Planning Runs only, as `lead`. Default: Claude if installed, else Codex. | KRI-53, KRI-60 |
| `model` (in `lead`, `reviewer`, `planner`) | any layer | The CLI’s alias where it has one (Claude: `opus`, `sonnet`, `haiku`, …), the exact name otherwise (Codex has no aliases). Unset: the CLI’s own default and any org admin default. | KRI-53 |
| `effort` (same) | any layer | The CLI’s levels: `low`, `medium`, `high`, `xhigh`, `max`, plus `ultra` on some Codex models. An unsupported level drops to the highest the model allows. Unset: the CLI’s default. | KRI-53 |
| `permissions` | Legacy Factory key | Advisory `auto` or `bypass`; never authorizes Bypass. The effective mode is chosen on each computer (7.8). | KRI-20, KRI-53, KRI-165 |
| `max_working_runs` | Factory only | Optional per-Factory cap on working Runs. Unset by default. | KRI-15, KRI-57 |
| `repos` | Factory only | List of the Factory’s repos; the first is the primary repo (4.6). | KRI-58 |
| `order` | any layer | Ordered list of agent Stage ids (4.7). | KRI-12, KRI-58 |
| `stages.<id>.enabled` | any layer | `false` turns a Stage off without editing `order`. | KRI-12 |
| `stages.<id>.effort` | any layer | Task Lead effort for this working Stage: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Optional; Backlog and Done take no effort. | KRI-67 |
| `stages.<id>.gate` | any layer | `true` puts a Gate at the end of the Stage. | KRI-12 |
| `stages.<id>.max_back` | any layer | Limit on send-backs from this Stage (6.7). UI label: **Send-backs**. | KRI-12, KRI-58, KRI-65 |
| `stages.<id>.based_on` | Factory or Library | Hash of the inherited Stage file an override was copied from (5.5). | KRI-22, KRI-58 |
| `stages.backlog.enabled` | any layer | The only setting Backlog takes. Done takes none. | KRI-15, KRI-58 |
| `stages.clarify.depth` | any layer | `auto` (default), `none`, `few`, `grilling`. | KRI-19 |
| `stages.validate.checks` | Factory | List of Checks (8.1). | KRI-16, KRI-57 |
| `stages.validate.loop_check` | any layer | Send-back count at which the loop check runs; default `3`; `false` turns it off. | KRI-16 |

- **Defaults:** Gates on Design and Review; Merge on with no Gate; every Stage has `max_back: 3` except Validate, which has 5. (KRI-12, KRI-16, KRI-52, KRI-58)
- **Not in `workflow.yaml`:** the machine’s limit on working Runs, billing per agent kind, and every other machine setting (11.2). Sub-agents and Automations have no key: the Task Lead picks for each sub-agent, and each Automation stores its own. (KRI-15, KRI-53, KRI-54, KRI-57)
- An unknown key is a warning, not an error, so a newer file still loads. (KRI-58)

A new Task follows Stage effort settings unless the human explicitly chooses its effort. Precedence is a fixed per-Task effort (including CLI default), then the effective Stage effort, then the Task’s saved lead effort, then the CLI default. Existing Tasks keep their saved effort fixed until the human selects **Follow Stage settings**. Stage effort is resolved at Stage entry; later Workflow edits apply at the next Stage. The Run and conversation stay the same: TED resumes with the new effort at idle, before delivering the new Stage’s instructions. Returning to an unconfigured Stage restores the saved lead effort. Library and Factory Workflow tables expose **Task Lead effort** with an **Inherit** option; removing a local override restores inheritance. `ted task lead <id> claude|codex --stage-effort` follows Stage settings; existing lead commands without this option keep fixed effort semantics. Reviewer, sub-agent, Planning and Automation settings are unchanged. (KRI-67)

### 4.6 `repos`

- `repos` is a list. Order matters: the first entry is the primary repo, and multi-repo Tasks merge in list order. (KRI-58)

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Short label, `[a-z0-9-]`, unique in the Factory. Used by a Check’s `repo:`, worktree folder names and UI grouping. Defaults to the GitHub repo name. |
| `remote` | secondary repos only | Any GitHub remote form. TED matches repos by owner/repo. Left out on the primary entry, which is the repo the file sits in; a primary `remote` that names another repo is ignored with a warning. |
| `base_branch` | no | Branch Task branches start from and pull requests target. Default: the repo’s GitHub default branch. |
| `merge_method` | no | `squash` (default), `merge`, `rebase` (KRI-52). |
| `worktree.setup` | no | A command, or `{run, timeout}`. Runs once in a new worktree, after copying files, before any Run uses it. Default timeout 15m. |
| `worktree.teardown` | no | A command, or `{run, timeout}`. Runs before TED removes a worktree. A failure is logged and removal goes on. |
| `worktree.env` | no | Map of plain strings, set for every Run, Check, App, shell, `setup` and `teardown` in that repo’s worktree. Committed, so no secrets. |
| `worktree.copy` | no | Paths or globs copied from the repo’s local folder into each new worktree, for untracked files such as `.env`. Copied once by the daemon, never symlinked. A missing folder or file is skipped and the repo’s settings row says so. |
| `apps` | no | The repo’s Apps (9.6). |

(Source for the table: KRI-58.)

- **Single-repo Factories:** `repos` is optional; without it the Factory has one repo, the one holding `.ted/`. Setup and the settings panel always write `repos`, even with one entry. (KRI-58)
- TED tracks a Task’s repos by owner/repo. Renaming a `name` in the settings panel also rewrites each Check’s `repo:` in the same Save. (KRI-58)
- Validation errors: duplicate `name`, the same repo twice, a secondary entry without `remote`, a non-GitHub remote, a Check whose `repo:` names no entry. (KRI-58)
- **App ports across repos.** Every App and every Run of a Task gets `TED_APP_<NAME>_PORT` and `TED_APP_<NAME>_URL` for each App of that Task. `<NAME>` is the App name upper-cased, non-alphanumerics as `_`. An App’s `env` can refer to them: `API_URL: ${TED_APP_API_URL}`. (KRI-58)

**Example:** a two-repo Factory, `.ted/workflow.yaml` in `kriya/app`, the primary repo (KRI-58):

```yaml
version: 1
lead: { agent: claude, model: opus, effort: high }
reviewer: { agent: codex, effort: medium }
planner: claude
max_working_runs: 3
repos:
  - name: app
    merge_method: squash
    worktree:
      setup: "npm ci"
      env:
        EXPO_NO_TELEMETRY: "1"
      copy: [".env"]
    apps:
      - name: Web
        run: "npm run web -- --port ${PORT}"
        url: "http://localhost:${PORT}"
        ready: url
      - name: iPhone
        kind: ios-simulator
        device: "iPhone 17"
        run: "npx expo run:ios --device ${TED_SIMULATOR_UDID}"
  - name: api
    remote: git@github.com:kriya/api.git
    base_branch: develop
    merge_method: rebase
    worktree:
      setup: { run: "bundle install && bin/rails db:prepare", timeout: 20m }
      teardown: "bin/rails db:drop"
      env:
        RAILS_ENV: development
      copy: [".env", "config/master.key"]
    apps:
      - name: API
        kind: command
        run: "bin/rails server -p ${PORT}"
order: [intake, clarify, design, work, validate, review, merge]
stages:
  backlog:  { enabled: true }
  clarify:  { depth: auto }
  design:   { gate: true }
  validate:
    max_back: 5
    loop_check: 3
    checks:
      - { name: Typecheck, run: "npm run typecheck" }
      - { name: API tests, run: "bin/rails test", repo: api, timeout: 10m }
    based_on: 3f9c2e1
  review:   { gate: true, based_on: 9a01b7d }
  merge:    { enabled: true, gate: false, max_back: 3 }
```

Task branches in `api` start from `develop` and their pull requests target it; `.ted/` is still read from `kriya/app`’s default branch. A Task touching both repos runs in `~/.ted/worktrees/KR-12/` with `app/` and `api/` inside, and merges `app` first. (KRI-58)

### 4.7 Stages and `order`

- v1 has the built-in Stages only: Backlog, Intake, Clarify, Design, Work, Validate, Review, Merge, Done. Custom Stages, including plain agent Stages from a Stage file, are later (KRI-50). (KRI-58)
- `order` lists agent Stages only, each at most once: `intake`, `clarify`, `design`, `work`, `validate`, `review`, `merge`. Rules: `intake` first, `work` present, `merge` last when listed. Anything else may be reordered. A Stage left out of `order` is off. (KRI-58)
- Backlog is always first and Done always last; neither appears in `order`. Backlog can be turned off with `stages.backlog.enabled: false`; Done can’t. (KRI-58)
- A Stage file with an unknown id (`.ted/stages/security.md`) is ignored, with a warning in settings. To add a step, edit the built-in Stage file it belongs to. (KRI-58)

### 4.8 Stage files

- `stages/<id>.md`. The Stage id is the filename, title-cased for display. Plain Markdown, no frontmatter. Suggested headings, not checked: Goal, Skip when, Steps, Done when, Send back when, Ask the human when. (KRI-12)
- Stage files hold plain instructions (“ask the human”, “report the outcome”). At Run start TED adds a preamble that maps them to `ted` commands and points to `ted help`. Nothing needs installing. (KRI-11, ADR 0001)
- On every Stage change, TED hands the live Task Lead Run the next Stage file. (KRI-11)
- The human never sees Stage file names or `workflow.yaml` outside settings. The thread shows plain events such as “You approved · Task moved to Design.” (KRI-11)
- Backlog and Done have no Stage file. (glossary)

### 4.9 Library

- The user’s own Stage files and Workflow settings in `~/.ted/library/`. Library edits from app Settings write straight there, with no pull request. TED also watches the folder, so edits made in another editor apply after validation. (KRI-22, KRI-58)
- The Library UI is in Settings → Library (11.3); its `lead`, `reviewer` and `planner` are in Settings → Agents. (KRI-57, KRI-58)
- Library sharing and versioning are later (KRI-49).

### 4.10 Factory notes

- `.ted/notes.md`. Facts about the product only: how to run it, conventions, risky areas. Suggested headings: Product, Repos, Running locally, Conventions, Risky areas. Intake reads the Repos heading to choose which repos a Task touches. (KRI-22, KRI-58)
- Given to every Run in the Factory. Never instructions for a Stage; those belong in Stage files. (KRI-22)

### 4.11 Invalid `workflow.yaml` or Stage file

- TED validates each layer whenever it resolves the Workflow. Errors: YAML that doesn’t parse, a wrong type, an unknown Stage id, a broken `order` rule, the `repos` errors in 4.6, an empty or unreadable Stage file. (KRI-58)
- On an error TED keeps using that layer’s last valid version and records which one each Stage entry used. With no last valid version (a repo added with a broken `.ted/`), the layer is skipped and the inherited layers apply. (KRI-58)
- Where it shows: the warning Factory banner (3.7); an amber notice at the top of Factory settings or Settings → Library with file, line and column, the message, and “TED is using the last valid version, from 3f9c2e1, 2 days ago”, plus **Open on GitHub**; a thread event on each Task that entered a Stage meanwhile (“Used last valid TED settings: .ted/workflow.yaml has an error”). Never in the Inbox, no notification, nothing on the sidebar row. (KRI-58, KRI-65)
- The settings panel loads the last valid version. Saving from it replaces the broken file. (KRI-58)
- **Prevention:** the settings panel and the Library editor never write an invalid file. When a Task’s changes touch `.ted/`, TED adds a built-in **TED settings** Check at Validate. Agents and humans can run `ted workflow check [<path>]`. (KRI-58)

---

## 5. Factory management

Figma: KRI-65 Factory setup and settings.

### 5.1 Add Factory form

- Opened from **+ Add Factory** at the end of the sidebar’s Factories section, and from first launch. A 640-wide dialog over the current page. The first Factory uses the same dialog titled “Add your first Factory”, with **Show the tutorial** ticked. (KRI-58, KRI-65, KRI-57)
- **Repos:** an ordered list, starting with one row. The first row is labelled **Primary** and can’t be dragged below others; other rows have a drag handle and ×. An empty row shows **Choose folder…** and a “GitHub URL or owner/repo” box side by side. A filled row shows `owner/repo`, the folder path when chosen from a folder, an editable **Name** (`name`), and an access line. **+ Add another repo** sits below. (KRI-58, KRI-65)
- From a folder, TED reads the GitHub remote (`origin`, else the only GitHub remote) and clones that. (KRI-58)
- **Access check**, by TED with no agent, through `gh`: `gh api repos/{owner}/{repo}` using `permissions.push`, the default branch, and `gh api repos/{owner}/{repo}/contents/.ted?ref=<default>` (404 means no `.ted/`). Messages name “the GitHub account TED uses (nabha)”, never `gh` or a token. Problems, each with a fix button: (KRI-57, KRI-58, KRI-65)
  - already another Factory’s primary repo: “kriya/app is the primary repo of Factory Kriya. Add it as a second repo, or open that Factory.” → **Open Kriya**
  - read-only access (TED needs push) → **Check again**; fork-only repos are later (KRI-76)
  - not found → **Check again**, **GitHub settings** (opens Settings → Integrations → GitHub)
  - no commits yet → **Check again**
  - folder with no GitHub remote → **Choose folder…**
- Notes: “Also used by Factory Notebook. TED shares one clone between them.” on a secondary repo; “Has TED settings already. They’ll be used, and the setup Task will wait in Backlog” on a primary repo with `.ted/`. (KRI-22, KRI-58, KRI-65)
- If `gh` is missing or signed out, the form shows the GitHub row with Fix and doesn’t start setup. (KRI-57)
- **Name:** required, defaults to the primary repo’s name with its first letter capitalized. **Key:** defaults from Name, live check for format and uniqueness, “Task IDs look like NB-1. Can’t be changed later.” **Show the tutorial:** on by default only for the first Factory. (KRI-58, KRI-22)
- **Add Factory** stays disabled until every repo row shows ✓ and Name and Key are valid. The footer says why (“Fix the 4 repo problems and the key to continue”) or what happens next (“TED clones both repos, then starts the setup Task BL-1”). (KRI-58, KRI-65)
- Nothing about agents, permissions or Checks is asked here. (KRI-58)

### 5.2 After Add Factory: cloning

- The Factory appears in the sidebar at once, and its Board opens with a **Setting up <Factory>** panel above the columns: one row per repo with clone progress, or “✓ Already cloned for Notebook · fetched”. (KRI-58, KRI-65)
- **New Task** works while cloning; the Task waits in Queued until the clones finish. **Plan** and **Filter** are disabled until then. (KRI-65)
- A failed clone turns that row red with the reason and **Retry**, raises the stops-work clone-failed Factory banner, and puts the red ⚠ on the sidebar row. TED retries by itself when the connection returns. (KRI-65)
- When every repo is cloned, TED creates the setup Task (`NB-1`). (KRI-58, KRI-65)

### 5.3 The setup Task

Factory setup is the Factory’s first Task, run through the inherited Workflow. (KRI-22, ADR 0005)

- It goes to the very front of the queue, ahead of all Priorities, but waits for a free slot like any Task. Its Priority is Urgent, so its requests come first in the Inbox. (KRI-22, KRI-55, KRI-56)
- A repo that already has `.ted/` gets its setup Task in Backlog, not started. (KRI-22)
- The Design and Review Gates are always on, even if the Library turns them off. (KRI-22)
- It shows a grey **Setup** chip next to its ID. Task details adds a note: “The Design and Review Gates are always on for a setup Task. Tasks started before it merges use TED’s defaults.” (KRI-65)
- Stages: (KRI-22)
  - **Intake:** filled in by TED.
  - **Clarify** at grilling depth: asks how the human works: which Stages, where Gates go, merge habits.
  - **Design:** the full proposal as an ordinary design review with **Request changes** and **Approve**. (KRI-60, KRI-65)
  - **Work:** writes the files on a branch.
  - **Validate:** runs the proposed Checks and starts the Apps on that branch.
  - **Review** and **Merge** follow.
- Setup tries each proposed Check on the default branch and tries to start each App, reporting pass or fail and the time taken. The proposal card shows, top to bottom: a two-sentence summary; **Workflow**, one line per Stage, unchanged Stages in grey as “As TED’s default”; **Checks · tried on main** (✓ or ✕, name, command, repo, duration; a Check that fails is listed as “left off” with the reason); **Apps · started on main** (kind, how it became ready, time taken); **Files it will write**, each with one line on what it holds; and a grey line naming what stays at TED’s defaults. No per-item checkboxes; changes go through Request changes. (KRI-22, KRI-65)
- Setup doesn’t propose repos; it may note a sign that one is missing. It suggests `lead`, `reviewer` or `planner` values only if asked. (KRI-22, KRI-53)
- **Tutorial:** when on, the Task Lead posts an ordinary Comment with a **Tutorial** chip as each Stage starts: what the Stage does, what it will do here, and “Change it later: Factory settings → Workflow → Design.” (KRI-22, KRI-65)
- **What setup writes:** Factory notes (`.ted/notes.md`); Stage overrides (`.ted/stages/<id>.md`), full copies edited for this product, always `validate.md`, others only when the steps really change; and `workflow.yaml` with `repos`, Checks, `apps` and Stage settings. (KRI-22, KRI-58)
- **Around setup:** the Factory can be used during setup; Tasks use the inherited layers until setup merges. While a setup Task is open, creating or starting a Task shows “Setup isn’t finished. This Task will use TED’s defaults” with **Start anyway** and **Open setup Task**. If setup never finished and no setup Task is open, the first Task started shows “This Factory hasn’t been set up” with **Start anyway** and **New setup Task**. These never block and are never Inbox items. (KRI-22, ADR 0005)
- **New setup Task** is always at the top of Factory settings. A later setup Task proposes changes to the current files, shown as a diff. (KRI-22, KRI-58)

### 5.4 Factory settings panel

- A Factory page: header “Notebook / Settings”, **New setup Task** on the right, a left section nav, and all sections on one scrolling page. It opens from the Factory’s **Settings** sidebar entry, the Factory row menu, or the Factories list in app Settings. (KRI-65, KRI-57, KRI-58)
- Each section heading carries a chip saying where it saves: “Saved on this Mac” (grey; “Saved on this computer” on Linux), applied at once, or “Saved to the repo · pull request” (blue), collected until Save. (KRI-58, KRI-65)
- **Sections:** (KRI-58, KRI-65, KRI-53)
  1. **General** (this Mac): Name, Key (read-only, “Can’t be changed”), **Remove Factory…**
  2. **Repos** (repo, except Local folder): one card per repo, primary first. Name, Base branch (placeholder “main (GitHub default)”), Merge method, **Worktree** (Setup, Teardown, an environment variables table with “Committed to the repo, so no secrets. Put secrets in a file to copy.”, Files to copy), **Local folder** (this Mac: path, **Choose…**, **Clear**, “✓ .env found”; amber with **Locate…** when missing), and **Apps** with **+ Add App**. The primary card reads “Can’t be removed or moved”. Secondary cards have a drag handle and ⋯ with **Open on GitHub** and **Remove from Factory…**. **+ Add repo** uses the Add Factory row.
  3. **Workflow:** one table with Stage, On, Gate, Send-backs, Clarify depth, From (**Default**, **Library** or **Factory**), and actions (**Override**, or **Edit file** and **Reset to inherited**). Intake’s and Work’s toggles are disabled. Backlog reads “Always first” with its on/off toggle; Done reads “Always last”. Ignored unknown Stage files show as a warning line. Drift sits on its Stage’s row (5.5).
  4. **Checks:** Name, Command, Repo (multi-repo only), Timeout (placeholder 10m), Last run, **Run now** (or **Stop**) and ×. The built-in TED settings Check is a read-only last row.
  5. **Agents:** Task Lead (`lead`), Reviewer (`reviewer`), Planner (`planner`), each with agent, model (placeholder “default model”), effort, a From chip and **Reset to inherited**. Inherited rows are read-only until **Override** is clicked.
  6. **Permissions and limits:** **Auto** and **Bypass** radios. Bypass reads “Only for Factories whose Runs happen in an isolated machine or VM. Can’t be set in the Library.” Then **Limit on working Runs**: “of this Mac’s 6. Leave empty to use only the Mac’s limit.”
  7. **Factory notes:** Markdown editor with Edit and Preview.
- **Override for this Factory** copies the inherited file into `.ted/` and writes `based_on`; **Reset to inherited** deletes the Factory copy. Both collect until Save like other repo edits. (KRI-12, KRI-22)
- With the Review Gate off, the panel warns that Merge runs right after Validate. (KRI-52)
- **Run now** runs a Check on the repo’s `base_branch` in a scratch worktree TED keeps for this. `setup` runs only when that worktree is created; later runs reset it to `origin/<base_branch>`. A scratch worktree is deleted when the next Run now starts or after 24 hours, and is listed in Settings → Storage. (KRI-65, KRI-8 coordinator decision 13)
- **Save bar**, only while repo changes are unsaved: “2 unsaved changes to .ted/workflow.yaml”, **Discard**, **Review and save…**. Each changed field shows an **Edited** chip. (KRI-65)
- **Save dialog** (“Save TED settings”): names the repo and account, shows a diff per file, lists side effects, and offers **Save and merge** (default) or **Save as pull request**; the button label follows the choice. Save commits on a branch and opens one pull request, “Update TED settings”, targeting the primary repo’s default branch. **Save and merge** merges through the same GitHub path as Task merges (9.9), with no Task and no Validate. If the default branch requires reviews or passing checks, TED leaves the pull request open and says why. (KRI-22, KRI-52, KRI-65, KRI-58)
- Save and merge is disabled, with the reason, while `gh` is signed out. (KRI-57)
- The files on the default branch stay the source of truth. (KRI-22)

### 5.5 Drift

- When TED creates an override it writes `based_on: <hash>` under that Stage. When the inherited file changes, the Stage’s row turns amber: “Inherited version changed. TED’s default review.md changed in TED 1.4. Your copy is based on 9a01b7d.”, an inline diff, and **Keep mine** (updates `based_on`), **Use inherited** (Reset), **Merge with an agent**. The sidebar’s Settings entry and the Workflow nav item show the count. Never in the Inbox and never a banner. (KRI-22, KRI-59, KRI-65)
- **Merge with an agent** creates an ordinary Task in that Factory. TED fills Intake: title “Merge inherited changes into review.md”, the inherited diff and current override in the description, Repos the primary repo, Clarify depth None, Priority None. Review Gate forced on; Design skips itself. Work edits the override and `based_on`; Validate runs the TED settings Check; it waits for a slot like any Task. (KRI-58)
- Library copies record `based_on` in `~/.ted/library/workflow.yaml`. After a TED update changes a default file, the Library row shows **Default version changed** with a diff, **Keep mine** and **Use default**. No Merge with an agent, because that needs a Factory. (KRI-58)

### 5.6 Rename, reorder and remove

- **Factory row menu** in the sidebar (right-click, or ⋯ on hover): **New Task**, **Plan**, **Rename…** (edits the name in place; Enter saves, Esc cancels; saved on this Mac; key and Task IDs don’t change), **Move up** / **Move down** (disabled at the ends), **Factory settings**, **Show in Finder** (the primary repo’s local folder; hidden when it has none; **Show in file manager** on Linux), **Open on GitHub**, and, after a divider in red, **Remove Factory…**. No Archive, Duplicate or change-key item. (KRI-58, KRI-65)
- Factory order is per machine, in TED’s store; drag or Move up/down. ⌘1 to ⌘9 follow it. (KRI-56, KRI-58)
- **Remove Factory…** opens a dialog with real counts and a typed-key confirm (“Type MS to confirm”): TED stops every Run in the Factory and deletes its Tasks, Comments, Runs, Conversations, Plans and Automations from the store; runs `teardown`, deletes its worktrees and simulator devices, and deletes clones no other Factory uses. **Close open pull requests on GitHub** is checked by default. Branches stay on GitHub. `.ted/` stays in the repo; adding the repo again picks it up with the setup Task in Backlog. No undo and no archived Factories in v1. (KRI-58, KRI-65)
- **Remove a secondary repo:** Repos card → **Remove from Factory…**. TED refuses while any open Task has the repo in its Repos field, and the dialog lists those Tasks; the human removes the repo from them, or finishes or archives them, first. Otherwise the card greys out with “Removed when you save” and **Undo**, and the same edit removes that repo’s Apps and the Checks pointing at it. The clone is deleted when nothing uses it. (KRI-8 coordinator decision 12, KRI-58, KRI-65)
- **Add a repo:** through Save; the Factory banner then suggests a New setup Task. (KRI-58, KRI-22)
- The primary repo can’t be removed or moved from first place in v1 (KRI-75). (KRI-58)

---

### 5.7 Coordinator

Each Factory has one saved Coordinator conversation, opened between List and Plans in the Factory sidebar. It compares current Tasks, briefs and Comments and recommends next work. Each Task retains its Task Lead. The Coordinator works only when messaged; there is no background monitoring. Before the first message, agent, model and effort default to the Factory’s planner settings and can be changed with the existing planning controls.

Human requests in the conversation can start Backlog Tasks, reorder Backlog Tasks among Backlog neighbours and Queued Tasks among Queued neighbours, resume stopped or failed Tasks, send a Task Lead a message, and answer a Task’s open requests: questions, Clarify rounds, proposals, size checks, failure decisions, Gate requests and sign-offs. The request names the kind of action and the Tasks, by name or as a group, and may leave each answer to the Coordinator’s judgement. Permission prompts, simulator asks and the Linear team ask stay with the human (ADR 0094). Advice alone authorizes no change; ambiguous requests and recommendations require a chat reply before acting. Starts use the ordinary Intake queue, blockers and slot limits. Reordering uses neighbour IDs and existing Priority rules. Daemon-authored receipts give the actual result and preserve before/after facts. Multi-Task requests execute individually, with partial results reported individually. Stale facts are refused and operation IDs deduplicate actions.

A Coordinator Run is a deliberate exception to the ordinary own-Task authority in §2.3. Stored Run association identifies its Factory; only Factory-scoped Coordinator reads, its start, move, tell, answer and resume tools, caller discovery and its own tool-call boundary are available. Human messages, Stop and Retry are app-only. Generic Run routes cannot grant it broader authority, and other Runs cannot use Coordinator tools. Task text is untrusted context. Task edits, settings and credentials remain unavailable, and a Stage changes only as the effect of an answer.

Every idle-to-working turn enters the common queue at the Planning tier, counts against machine and Factory limits, and observes disk and agent health holds. An idle conversation holds no working slot. Messages during a response wait for a tool boundary. Stop cancels undispatched messages and interrupts the response while retaining history. Retry resumes through the queue; if the agent cannot resume its session, a replacement Run receives saved history and action receipts as context. The header shows Ready, Queued, Working, Paused or Failed. The context pane links to Tasks read or changed, with their current status. **New conversation** in the header asks first, then stops the Coordinator and deletes its conversation, pending messages, history and managed files; the next message starts a fresh conversation with nothing carried over. Removing a Factory removes its Coordinator the same way.

## 6. Tasks and Stages

### 6.1 Task basics

- A Task is a unit of work moving through a Workflow. Once code exists, it has one pull request in each repo it changes. (glossary, KRI-13, KRI-58)
- **Fields:** title; description (versioned, the first version kept as **Original request**, never editable); Priority (Urgent, High, Medium, Low, None); hand-set rank; Clarify depth (Auto, None, Few, Grill); **Task Lead** (agent, model, effort); **Repos** (multi-repo Factories only); source URL; Blocked by and Blocks; Task brief (versioned); Stage history; branch. (KRI-15, KRI-19, KRI-20, KRI-53, KRI-55, KRI-58)
- **Ways Tasks are created:** by hand in the New Task dialog (typing, or pasting a Linear URL), which is the main way; by an Automation; by Split it; by a planning chat; as a Follow-up. Created-by is shown and filterable. (KRI-20, KRI-19, KRI-52, KRI-56)
- **Task Lead field:** filled from `lead`; changeable any time. A model or effort change applies at the Run’s next idle point (waiting at a Gate or between turns) by resuming with new flags; it never interrupts a turn. An agent change starts a fresh Run from the brief. Sub-agents can’t be changed by hand. (KRI-53)
- **Repos field:** Intake sets it (`ted task repos set app api`); the Task Lead changes it any time (`ted task repos add|remove <name>`); the human edits it in Task details. Hidden in single-repo Factories. Removing a repo from a Task is refused while that repo has an open pull request; if its worktree has commits, TED asks first. (KRI-58)

### 6.2 New Task dialog

Figma: KRI-63 Task details (New Task dialog frames).

- Opened with **+** in the sidebar, **New Task** in a View header, the menu-bar menu, or ⌘N / `C`. (KRI-55, KRI-56)
- Header “New Task in [Notebook ▾]”; the Factory defaults to the current one. (KRI-55, KRI-63)
- **Title:** optional. If blank, TED uses the first line of the description, and the Task Lead may rename it. (KRI-55)
- **Description:** required, focused on open. Pasting a Linear URL shows a removable source card (“Linear · NOTE-212 · Search ignores accents”) and fills Title, Priority and the branch (6.3). (KRI-55, KRI-63, KRI-60)
- **Attachments:** drag and drop. (KRI-55)
- **Priority** (default None) and **Blocked by** (a search over every Factory on this machine) share a row. (KRI-55, KRI-63)
- **More**, closed by default with a one-line summary: **Clarify depth** (Auto, None, Few, Grill) and **Task Lead** (agent, model, effort, filled from the Factory’s `lead`). (KRI-55, KRI-63)
- **Start now:** checked by default. The footer line says what happens: “Unchecked puts it in Backlog”, or with a blocker, “Waits as Blocked until NB-35 merges”. (KRI-55, KRI-63)
- No repo picker. **Create** (⌘↵) closes the dialog; **Create more** keeps it open. (KRI-55, KRI-58)

### 6.3 Creating from Linear

- Pasting a Linear URL fetches the issue there and then with the Linear API key: title → Task title, description → context for the Task Lead, Priority copied, Linear’s suggested branch name → branch. (KRI-20, KRI-15, KRI-60)
- **No key:** a note under Description reads “Add a Linear API key to fill in the title, Priority and branch from Linear.”, with an inline key field, **Save** (stores it where Settings does, then fetches at once) and **Create a key ↗**. (KRI-57, KRI-60)
- **Create** without a key still works: the URL is the source, the description is as typed, the first line is the title, and the branch is slugged from the title. (KRI-60)
- An invalid key, a missing issue or no access shows “Couldn’t fetch from Linear: <reason>. The Task will be created with the link only.” A URL from a workspace the key can’t read fails with “This Linear key can’t read issues in <workspace>”. One Linear workspace per machine; several are later (KRI-77). (KRI-60, KRI-57)
- `ted task create --source <Linear URL>` without a key falls back the same way. (KRI-60)
- No built-in Linear connector; two-way sync is later (KRI-26). (KRI-20)

### 6.4 Editing a Task

- The human can edit title, description, Priority, Clarify depth, Task Lead, Repos and blockers at any time (`E` opens Edit title and description). (KRI-55, KRI-58, KRI-56)
- Each description edit makes a new version. If a Run is live, TED sends the change into it as a Comment with the diff. The thread shows an event line with **Show changes**. (KRI-55, KRI-61)
- Changing Clarify depth after Clarify is over does nothing, and the field says so. (KRI-55)

### 6.5 Where Tasks land, starting, and the queue

- **Created by hand:** with **Start now** checked, the Task is Queued at the start of Intake; unchecked, it goes to Backlog. (KRI-15, KRI-55)
- **Created by an Automation:** Backlog, unless it passes `ted task create --start`. The Automation’s prompt holds the rule. (KRI-15, KRI-60)
- **Follow-up:** skips Backlog; still waits for a slot. (KRI-52)
- **Split and planning pieces:** Backlog (6.13, 13.4). (KRI-19, KRI-60)
- **Start** (leaves Backlog): the play button on a Backlog card, dragging a card to Intake (or into the Queued group in a Manual-sorted List), `S`, `ted task start <id>`, or an Automation. A blocked Backlog card has no Start button. (KRI-15, KRI-56, KRI-62)
- **Un-start:** dragging a Queued card back to Backlog, or **Move to Backlog** in the Task actions menu. A Task that has had a Run can’t go back to Backlog. (KRI-15, KRI-63)
- **Blocked Tasks and Start now.** A Task with a blocker starts as soon as its last blocker merges only if it was meant to start: created with Start now checked (or `--start`), or already started. Created with Start now unchecked, it stays in Backlog after the blocker merges. The human can start it by hand at any time. Removing the last blocker by hand never starts a Task. (KRI-55 change from Nabha’s review, KRI-15)
- **Snooze:** an existing Backlog Task can be scheduled for a date and time in TED’s app-wide timezone, saved as a fixed instant. It stays in Backlog until due, including with automatic Backlog starts or Overnight mode on. When due it starts through the normal queue even if Factory automatic starts are off; blockers, capacity and safety holds still apply. Snoozes survive restart, and overdue Tasks are handled when TED next runs. The Task actions menu offers Snooze…, Change snooze… and Cancel snooze. Start clears the snooze and starts early; archiving cancels it. Cancel restores ordinary Backlog behavior, so automatic starts may start it immediately. Pending snoozes keep TED running in the background; Quit is still available. (KRI-42)

**Queue and limits**

- **Queued** is a status: a started Task waiting at the start of Intake for a free slot, with no Run and no worktree. (KRI-15, KRI-58)
- **Max working Runs on this machine**, in Settings → Limits, default 6. It always stays on. (KRI-15, ADR 0004)
- **Start fewer Runs when this computer is busy**, in Settings → Limits, off by default. While the 1-minute load average is at or above the number of cores, TED starts no new work unless nothing is working, and starts again once it falls below three quarters of the cores. Working Runs carry on, and the limit above is still the most TED runs. A held Task reads “Queued · this computer is busy”. (ADR 0101)
- Optional per-Factory `max_working_runs`. A new Run starts only when both limits have room. When a Factory’s cap is full, its Board and List header shows “4 of 4 working”. (KRI-15, KRI-8 coordinator decision 17)
- **What counts:** working Runs: Task Leads, sub-agents, Automation Runs and active Planning Runs. Runs waiting on the human, a Task Lead waiting only on its sub-agents, Paused Runs, Apps and Checks don’t count. While a new worktree’s `setup` runs, the Task holds its slot. (KRI-15, KRI-19, KRI-18, KRI-54, KRI-60, KRI-58)
- **The limit gates new starts only:** new Tasks, Resume, new sub-agents, Automation and Planning Runs. A waiting Run that the human answers starts working at once, even if that goes over the limit. (KRI-60)
- **Queue order on the machine:** (KRI-60, KRI-55)
  1. the setup Task
  2. waiting sub-agent requests
  3. new Planning Runs
  4. Automation Runs
  5. Tasks, by Priority (Urgent first), then hand-set rank.
- The queue is shared across all Factories on the machine. A new Task goes to the bottom of its Priority group. Priority is set by hand, copied from Linear, or passed with `--priority`. (KRI-15)
- Queued Tasks whose agent kind is Paused show Paused (with their queue place in the activity line, “Queued · 3rd · resets 15:40”), and Tasks of the other kind move ahead. (KRI-54, KRI-62)
- The human orders the queue on a Board (one Factory) or in the List sorted Manual (any Factory, including All Tasks). The Working Runs popover is read-only (10.3). (KRI-56)

### 6.6 Statuses

A Task shows one status at a time, or none, chosen by precedence (highest first). A status is not a Stage. (KRI-55)

| # | Status | Colour | Glyph | Meaning | Source |
|---|---|---|---|---|---|
| 1 | Failed | red | ! in a red disc | A resume and a fresh Run both failed (7.6). Has a FAILED ask with Retry. | KRI-54, KRI-55 |
| 2 | Partly merged | red | half-filled ring | A multi-repo merge stopped partway. | KRI-52 |
| 3 | Waiting on you | amber | dot | An Inbox item on the Task is unanswered. The only amber status. | KRI-55 |
| 4 | Paused · reason | grey | ‖ | The agent can’t run: usage limit, signed out, not installed, below the minimum version, using an API key instead of the subscription, or offline. | KRI-54, KRI-59 |
| 5 | Working | blue | spinner arc | Some Run on the Task is working, including a Task Lead waiting only on its sub-agents, `setup` running in a new worktree (“Setting up app · npm ci”), and Checks running. | KRI-55, KRI-58, KRI-60 |
| 6 | Stopped | grey | ■ | The human stopped the Task. | KRI-55 |
| 7 | Blocked | grey | ⊘ | No Run; waiting for another Task to merge. Shown as one “Blocked by NB-44” chip with the ID as a link. | KRI-55, KRI-62 |
| 8 | Queued · 2nd | blue | clock | Waiting for a slot, with its place in the machine-wide queue. “Queued · disk full” during the disk hold. | KRI-55, KRI-59 |
| 9 | Waiting for CI, Waiting for GitHub review, Waiting for merge, Waiting for GitHub sign-in | grey | dashed ring; with a dot; half filled | At Merge, waiting on GitHub. | KRI-55, KRI-52, KRI-57 |
| 10 | (none) | | | An unstarted Backlog Task, a Done Task. | KRI-55 |

(Colours and glyphs: KRI-8 coordinator decision 24; KRI-62’s “Card in every status” frame is the reference.)

- **Markers**, shown as outline chips beside or instead of a status: Blocked by (on a Backlog Task, the same chip as status 7) and **Needs planning**. (KRI-55, KRI-61, KRI-62)
- “Idle” is a Run icon state only. “Archived” is a filter, not a status. (KRI-55)
- The **activity line** is one line of free text set by the agent with `ted status "…"`, or by TED: the Paused reason’s next step (“Continues by itself at 14:20”), “Starts when NB-41 merges”, “Retrying (rate limited)”, “2 requests waiting on you”, “Merged 2h ago · PR #470, #88”. (KRI-11, KRI-54, KRI-61, KRI-62)
- **Model unavailable** (KRI-53): when the user’s plan doesn’t include the model a Run asks for, TED never switches silently. The Run waits, its Run row shows “Model unavailable”, and a `question` Comment offers **Use the default model** (this Run only) or **Change setting**. The Task therefore shows Waiting on you. (KRI-53, KRI-55)

### 6.7 Gates, outcomes and send-backs

- The Task Lead reports the end of a Stage with `ted outcome advance | back --to <Stage> --findings <file> | ask`. TED picks the next Stage from the Workflow. `back` goes only to an earlier Stage and always carries a Findings file. Agents can’t skip a Gate. (KRI-11, KRI-16)
- A Gate comes at the end of its Stage: the Task Lead writes the Task brief and posts a request. **Approve** moves the Task on. **Request changes** keeps it in the Stage, except at Review and the Merge Gate, where the Task Lead picks Work or Design. (KRI-12, KRI-18, KRI-60)
- A Stage that skips itself skips its Gate. (KRI-12)
- `max_back` sits on the Stage that sends back. It counts only send-backs the Task Lead makes on its own; a send-back after the human’s Request changes doesn’t count. Going over turns `back` into `ask`; the count resets when the human answers. A send-back from Review resets Validate’s count. (KRI-12, KRI-58, KRI-18)
- The Task brief is written at every Gate. (KRI-11, KRI-17)
- **Stage history.** The header’s Stage track shows past Stages, the current one, skipped Stages struck through and future Stages greyed. Clicking a Stage filters the thread to that Stage’s events. There is no separate Stage history section. (KRI-13, KRI-8 coordinator decision 4)
- A Gate request (design review, grilling sign-off, sign-off) is withdrawn automatically when the Task leaves that Stage before the human answers: “Withdrawn · the Task went back to Work before you answered”. (KRI-61)

### 6.8 Backlog

- Built-in holding Stage, always first. No Stage file, no Run, no worktree, no tokens. (KRI-15, KRI-58)
- Can be turned off with `stages.backlog.enabled: false`; then every new Task starts at Intake. (KRI-15)
- For Tasks that are blocked or not wanted yet. “Not clear yet” is not a reason; Clarify handles that. (KRI-15)

### 6.9 Intake

- Turns what came in into a Task with a clear title and description: restates the request, links sources, sets Repos from Factory notes. (KRI-12, KRI-58)
- Queued Tasks wait at the start of Intake. The worktree is created when the Task leaves Queued (6.17). (KRI-15, KRI-58)
- For a setup Task or a drift merge Task, TED fills Intake in. (KRI-22, KRI-58)

### 6.10 Clarify

- Removes ambiguity before Design. (KRI-12)
- **Size check first.** Clarify’s first step checks whether the Task fits one pull request per repo. If not, it asks with choices: **Plan in chat**, **Split it**, **Plan it outside TED**, **Grill anyway**. Nothing else checks size; turning Clarify off turns the check off. (KRI-19)
- **Depth:** none, few, grilling. The Task Lead picks by default and posts its pick and why as an event line; the field shows “Few · by the Task Lead”. The human can set it on the Task beforehand or change it by Comment. `stages.clarify.depth` sets a default. (KRI-19, KRI-63)
- **Rounds.** A round is one Comment (kind `round`) holding all its questions, answered in one go. Agents post rounds with `ted ask --round <file>`; TED renders them. In the Inbox a round is one row, kind “Clarify round”. Card details are in 10.5. (KRI-19, KRI-55, KRI-56, KRI-61)
- **Few:** one round, no sign-off; the Task moves on when answered. The Task Lead may switch to grilling (event line) if answers raise something bigger. (KRI-19)
- **Grilling** ends with a sign-off Comment summarizing what was decided. Approve moves on; Request changes starts another round. It acts as a Gate that is on only at grilling depth. Decisions go under the brief’s Decisions so far. (KRI-19)
- **Talk it through** on an unanswered round opens the Task Lead’s own Run chat in the middle pane, with its context and its agent, model and effort. The round sits collapsed above the input; the header reads “Talking through Round 2” with **Done talking**. TED sends the Run one line saying the human wants to talk it through. **Done talking**, or the Task Lead deciding it’s done, makes the Task Lead post a summary `note` with `ted ask --close --summary <file>`, which closes the round as “Answered in Talk it through”. Anything still open goes into a new round. (KRI-60, KRI-61)
- Wayfinder is not part of Clarify in v1 (KRI-48). (KRI-19)
- **Plan in chat** opens a planning chat from this Task (13.5). (KRI-19, KRI-60)
- **Plan it outside TED:** the Task returns to Backlog with a **Needs planning** marker. The Task Lead posts why it judged the Task too big and what a plan needs to settle, then its Run stops. On restart, Clarify runs as usual and reads whatever the plan left in the description. The marker clears on start. (KRI-19)

### 6.11 Design

- Decides how to build it. Writes the approach in the brief, with a prototype or Figma link for UI work. Skips itself for small, obvious changes. Gate on by default. (KRI-12)
- The design review card is in 10.5. Request changes keeps the Task in Design. (KRI-13, KRI-12, KRI-61)

### 6.12 Work

- Builds on the Task’s branch, with tests, and sub-agents for parallel pieces where useful. Agents only commit; TED pushes (9.1). (KRI-12, KRI-58)
- Work can run `ted checks [--name <Check>]` before it hands off. Results go back to the agent, and the thread gets one event line (“Work ran Checks: ✓ Typecheck ✗ Tests”). (KRI-16, KRI-60)
- CI failures, review comments and merge conflicts from GitHub go to the Task Lead’s open Run, or to a fresh Run started from the brief. (KRI-20)

### 6.13 Split it

- The Task Lead posts the pieces as a `proposal` with `ted task propose --file <file>` (title, one-line scope, Priority, blocked-by by row number). The card is the same as a planning chat proposal (13.4). (KRI-19, KRI-60, KRI-55)
- **Create N Tasks** creates them in Backlog, linked back to the original; **Request changes** revises the list. (KRI-19, KRI-60)
- The original Task becomes the first piece. It keeps its thread and history, narrows its title and description, and continues through the Workflow. Its row on the proposal is locked on. (KRI-19, KRI-66)
- Blocked pieces start when their blockers merge; the rest wait for the human unless **Start the unblocked ones** is ticked. (KRI-19, KRI-60)
- Task details keeps the collapsed **Original request**, and the Task Lead gets it next to the current description at Run start. (KRI-19)

### 6.14 Review

- The Task Lead writes the brief: what changed, how it was checked, what to try. TED marks the pull requests ready when the sign-off is posted (9.1). (KRI-12, KRI-58)
- Gate on by default. The sign-off card is in 9.2. (KRI-12, KRI-18)
- **Request changes:** the human’s text plus any draft line comments go to the Task Lead’s open Run as one Comment. The Task Lead picks Work or Design. The fix always passes through Validate again and returns with a new sign-off. (KRI-18, KRI-60)
- Review is the configurable human review and sign-off step. Its default Stage file reuses Validate’s code review, security review and evidence, and carries their remaining notes into the brief. Missing reviews or later unreviewed changes go back to Validate; if the Workflow omits Validate, the Task Lead asks the human how to restore validation before sign-off. Fixes go back to Work and pass Validate again. (KRI-199)
- TED never posts a GitHub approval. (KRI-18, KRI-52)

### 6.15 Done

- Holding Stage at the end of the Workflow. Nothing runs there. (KRI-52)
- When every pull request has merged, TED moves the Task to Done, stops the Task Lead’s Run (kept as history), stops the Apps, runs `teardown` and removes the worktrees, and releases Tasks blocked on this one. (KRI-52, KRI-58)
- Done Tasks stay until archived by hand; auto-archive is later (KRI-27). (KRI-52)
- A Done Task is never reopened. **Follow up** on a Done Task creates a new Task linked to the original, starting from its Task brief. It skips Backlog and still waits for a slot. The Task Lead may skip Clarify and Design. Typing a Comment on a Done Task offers **Comment only** and **Follow up**. Unsent line comment drafts go with a Follow up. (KRI-52, KRI-61, KRI-60)
- Automations never create Follow-ups. (KRI-55)

### 6.16 Blockers

- A **Blocked by** field in Task details and the New Task dialog searches every Factory on this machine, so cross-Factory blockers are allowed. Agents use `ted task block <id> --by <id>` and `ted task unblock`. (KRI-55)
- **Adding a blocker:** a Backlog Task stays in Backlog; a Queued Task goes back to Backlog. A running Task’s Task Lead is told, explains whether it can still make useful progress, recommends waiting or continuing, and asks the human before doing more work. The Task shows Waiting on you while the question is open. **Wait for blocker** saves the brief and stops the Task Lead (Blocked), keeping the worktree and Stage for a fresh Run when its blockers merge. **Continue independent work** keeps the blocker link and lets the Task Lead work on independent parts; it must save the brief and block itself when it reaches dependent work. (KRI-55, KRI-175)
- **Blocked mid-flow:** when the Task Lead finds another Task must merge first, it adds the link, writes the brief and stops its Run. The Task stays in its Stage as Blocked, keeping its worktree. When the blocker merges, a fresh Run starts from the brief. (KRI-15, KRI-58)
- A Task counts as merged only when every pull request has merged. (KRI-52)
- A blocker that would make a cycle is refused, with the cycle named. (KRI-55)
- Archiving or deleting a Task that blocks others lists those Tasks and asks **Unblock them** (default) or **Keep them blocked**. Kept links show “Blocked by archived NB-12” or “Blocked by deleted NB-35”. (KRI-55, KRI-63)

### 6.17 Worktrees and branches

- **Created** when the Task leaves Queued and its first Task Lead Run is about to start. Steps: fetch, create the branch and worktree from `origin/<base_branch>`, copy the `copy` files, run `setup`, start the Task Lead Run. Only the primary repo’s worktree is created at start; adding a repo to Repos creates its worktree at once (`ted task repos add` returns when `setup` has finished, with its output). (KRI-58)
- If `setup` fails, the Run starts anyway and gets the output first, as a thread event and to the Task Lead. (KRI-58)
- **Sandbox:** outside Bypass, Task `setup` and `teardown` run automatically in TED’s OS sandbox, like Checks. This includes added repos and setup resumed after a restart. They may write only the Task’s worktrees, private package caches and command temp folder (plus the sandbox’s platform allowances); clones are read-only. A missing or unsafe sandbox fails the command without running it unsandboxed. Setup failure still starts the Task Lead with its report; teardown failure is logged and removal continues. Bypass keeps unsandboxed execution. (KRI-164, ADR 0096)
- **Run folder:** in a single-repo Factory, the repo’s worktree. In a multi-repo Factory, always the Task folder `~/.ted/worktrees/<TASK-ID>/`, with each repo’s worktree as a subfolder named after `name`. (KRI-58)
- **Not created** for Backlog or Queued Tasks. **Kept** while the Task is Stopped, Failed, Paused, Blocked mid-flow or Waiting for merge. **Removed** at Done or archive, after `teardown`. (KRI-58)
- **Branch names:** Linear’s suggested name when created from a Linear URL, otherwise `ted/<task-id>-<slug>` (for example `ted/nb-44-fix-login-redirect`; slug cut to 40 characters at a word boundary). The same name in every repo of the Task. Fixed when the first worktree is created; renaming the Task doesn’t rename it. On a clash in any repo, TED appends `-2`, `-3`, …. No prefix setting. (KRI-58)

### 6.18 Stop, Resume, Retry and the idle Task Lead

- **Stop** (Task actions menu or palette; no shortcut) stops every Run on the Task (kept as history), frees its slots, keeps the worktree and Apps, and leaves the Task in its Stage as **Stopped**. Stopping the Task Lead’s Run is the same action. There’s no human Pause; Paused is only for agents that can’t run. (KRI-55, KRI-56)
- **Resume** (`S`, the header button, or **Send and resume** in the comment box) starts a fresh Task Lead Run from the brief plus Comments since, through the queue. (KRI-55, KRI-61, KRI-63)
- **Retry** on a Failed Task is Send and resume. It is on the FAILED ask, on hover and in the menu of a Failed card or List row, and on `S`. (KRI-61, KRI-8 coordinator decision 14, KRI-56)
- **Task Lead goes idle without asking:** after the Run has been idle for 60 seconds with no unanswered request, TED sends one nudge into the Run: “Continue, or post a Comment if you need the human.” The delay is fixed, with no user-facing setting. It measures time in the idle state; thinking or running a tool while the Run is working does not count. If it goes idle again with nothing open, TED posts a `question`, “The Task Lead stopped without saying why”, with the agent’s last message and **Nudge again**. (KRI-55, KRI-177)

### 6.19 Archive and delete

- **Archive** (⌘⌫ opens the dialog) is the only way out; there is no Canceled state. It stops all Runs and Apps, removes the worktree, deletes the Task’s simulator device, and keeps Comments, brief, Conversations and branches. With open pull requests, **Close the pull requests on GitHub** is checked by default and names them. (KRI-11, KRI-18, KRI-55, KRI-63)
- **Unarchive** reopens the pull requests if their branches still exist, recreates the worktree from the branch and starts a fresh Task Lead Run from the brief. A Done Task unarchives back to Done with no Run, worktree or Apps. (KRI-11, KRI-55, KRI-58)
- An archived Task opens read-only: a bar “Archived 3 Nov · **Unarchive**”, the Stage track ending “· Archived from Work”, and no comment box. Its Inbox requests leave the Inbox. (KRI-56, KRI-62)
- **Delete** (palette or menu; no shortcut) removes the Task, its Runs, Conversations, Comments and brief after a confirm. It leaves pull requests and branches on GitHub; the dialog offers **Archive instead**. (KRI-11, KRI-63)
- Auto-delete of archived Tasks is later (KRI-27).

### 6.20 Comments on a Task with no live Run

- Stored, and the next Run gets them with the brief: Backlog, Queued, Blocked, Stopped and Failed Tasks. A Paused Run is still open, so a Comment queues in its input as usual. (KRI-55)
- Comment box per state is in 10.5. (KRI-61)

---

## 7. Agents and Runs

### 7.1 Task Lead

- One Task Lead per Task. It carries the Task through its Stages, may start sub-agents, and writes the Task brief at each Gate. (glossary, KRI-8)
- Its agent, model and effort come from `lead`, or from the Task Lead field on one Task (6.1). (KRI-12, KRI-53)
- **One long Run** is the default; no fresh agent per Stage. Context-heavy work (exploration, implementation, review) goes to sub-agents, and the Task Lead keeps only their final messages. The agents’ own compaction handles long context; there is no handoff command. Revisiting this with Diagnostics is later (KRI-43). (KRI-17)
- The Run stays open and idle while it waits for the human. (KRI-11)
- Only the Task Lead reports outcomes, posts questions, rounds, reviews, sign-offs and proposals, and writes the brief. Sub-agents may post plain Comments. (KRI-11)

### 7.2 Sub-agents

- Started by the Task Lead with `ted run start --agent <kind> [--model <m>] [--effort <level>] --prompt-file <file> [--name <name>] [--own-worktree]`. Anything left out falls back to `lead`. The name defaults to the prompt file’s first heading and labels the Runs list and tabs. (KRI-11, KRI-53, KRI-8 coordinator decision 1)
- The Task Lead picks agent, model and effort for each, guided by Stage files. No per-Task cap; the limits on working Runs cover it. (KRI-53)
- Share the Task’s worktree by default; `--own-worktree` separates. (KRI-11)
- `ted run wait <id>` returns the final message; `ted run send <id>` sends follow-ups. (KRI-11)
- Don’t receive the human’s Comments. The human can open a sub-agent’s chat, message it and Stop it. (KRI-11, KRI-8 steering)
- A failed sub-agent is reported to the Task Lead, which decides what to do, with no Inbox item. (KRI-54)
- The reviewer Run is named “Reviewer · Validate”. (KRI-63)

### 7.3 Runs

- A Run is one agent conversation: on a Task (Task Lead or sub-agent), for an Automation, or for planning. (glossary)
- **Live chat** is the only view of a Run in v1: streaming messages, collapsible tool-call rows, edits expandable to diffs, and the composer (10.6). Port agent-orchestrator’s chat host (`adapters/chatdriver/`) and React chat components. No TUI; switching is later (KRI-24). (KRI-20)
- **Side chat** opens beside a Task Lead Run’s chat, with a switch between the two in narrow panes. One persistent side chat belongs to each Task Lead Run, including historical Runs while their output is kept. It uses a fixed Conversation snapshot, the source Run’s agent/model/effort, and answers only from supplied text, with no tools or Task authority. Closing the panel keeps the exchange. Each turn queues under normal Run limits; Stop reply affects only the side chat. Snapshot omissions are shown; a missing snapshot makes the chat read-only. (KRI-29)
- **Transport:** Codex through `codex app-server`. Claude Code with a subscription through the CLI (an interactive PTY or `claude -p --output-format stream-json`); the Agent SDK only with an API key. (KRI-21, ADR 0004)
- Agent hooks for Claude Code and Codex tell TED whether a Run is working, idle, waiting or finished. They are set through per-Run flags. (KRI-20, KRI-53)
- **Per-Run flags only.** TED passes everything as flags on each Run (`--settings`, `--mcp-config`, `-c key=value`, …) and never writes to `~/.claude` or `~/.codex`. The `ted mcp` server is passed the same way. (KRI-53, KRI-59)
- **Comments into Runs:** the human’s Comments on a Task go straight into the Task Lead’s live Run, queued if it is mid-turn. A Comment counts as read once the agent has started a turn with it. Agents’ Comments count as read when the human opens them. A message typed into a Run chat goes only to that Run and is not a Comment. (KRI-11, KRI-20)
- **Stop** a Run: it becomes read-only history and is never resumed; work continues in a fresh Run. (KRI-11, glossary)
- **Restart:** a manual action on an idle or waiting Run (greyed out while working), plus an automatic restart of idle Runs onto a new Claude Code or Codex version (Settings → Agents, on by default). (KRI-20, KRI-63)
- **Resume, not replace.** TED records each Run’s agent session ID. On a restart (new agent version, a model or effort change, a daemon restart or update) it resumes that session in the same worktree (`claude --resume`, `codex resume` / `thread/resume`) and passes the per-Run flags again. It stays the same Run. If the resume fails (session file gone, incompatible format, crash loop), TED starts a fresh Run from the brief and shows it as a new Run. (KRI-53)
- **Fresh Task Lead Run from the brief** plus Comments since, when there is no live session to continue: after a failed resume, on Resume or Retry, on unarchive, when a blocker merges for a Task blocked mid-flow, on restart after Plan it outside TED, when GitHub events arrive with no open Run, and when the Task Lead’s agent changes. (KRI-17, KRI-15, KRI-19, KRI-20, KRI-53, KRI-55)

### 7.4 Run start

At Run start TED gives the agent: (KRI-11, KRI-19, KRI-22, KRI-60)

- the preamble mapping plain intents to `ted` commands, shown as a collapsed first row in the Run chat (KRI-53)
- the current Stage file
- Factory notes
- the original request next to the current description
- for a fresh Run, the Task brief and Comments since
- for an Automation Run, the open Tasks this Automation has created, with their sources (12.4)

### 7.5 When an agent can’t run

- **Paused** (a status, not a failure) covers: a usage limit; a CLI that is signed out, not installed, below TED’s minimum supported version, or using the wrong credential; and the machine being offline. The reason shows after the status: “Paused · Claude usage limit, resets 14:20”. Paused Runs stay open and don’t count toward the limit. Queued Tasks of that agent kind show the same reason, and Tasks of the other kind move ahead. When the agent can run again, TED continues the Runs by itself. (KRI-54, KRI-59)
- **Usage limit:** the whole agent kind pauses until the reset time the CLI reports (Claude’s `rate_limit_event` `resetsAt`; Codex app-server’s `usageLimitExceeded` with `resetsAt`). With no reset time, TED tries one Run every 15 minutes. (KRI-54)
- **No switching to the other agent**, automatic or one-click. The human changes the Task Lead field if they want to. (KRI-54)
- **Short rate limits and overload (429, 529):** the CLI retries them; TED doesn’t retry on top. The activity line shows “Retrying (rate limited)”, from Claude’s `system/api_retry` and Codex’s `willRetry`. (KRI-54)
- **Offline:** every agent kind pauses with the reason “offline”, and the 30-minute no-output clock stops. (KRI-59)
- **Health checks** run before each Run, every 10 minutes, and on auth errors. Fix opens `claude auth login` / `codex login`, shows the install command, or runs `claude update` / `codex update` in the user’s terminal. TED keeps a minimum supported version for each agent kind and never updates a CLI silently. An agent named in `lead`, `reviewer` or `planner` that isn’t installed means Paused (“Codex not installed”), not a config error. (KRI-54, KRI-57)
- **Where it shows:** the app-wide banner (3.7), a red border and status on the agent’s card in Settings → Agents, “3 Runs paused” in the sidebar footer, and one notification when it starts. No Inbox item. (KRI-54, KRI-64)

### 7.6 Failed

- A Run fails when its process exits without finishing or waiting, for a reason other than Paused. Thirty minutes with no output while Working also counts. Time the CLI spends retrying or waiting on a usage limit, or offline, doesn’t count toward the 30 minutes. (KRI-54, KRI-59)
- For a Task Lead Run, TED first resumes the session, then starts a fresh Run from the brief. A second failure within 30 minutes marks the Task **Failed** and posts the FAILED ask: a `question` from TED with a red border and FAILED label, “The Task Lead stopped twice in 30 minutes”, what TED already tried, the last error lines, an **Open last Run** link, and **Send** and **Retry**. (KRI-54, KRI-61, KRI-64)
- A failed Automation or Planning Run gets the same resume attempt, then shows Failed in the Automation’s history or the Plans list with **Retry**, and a red dot on the Automations or Plans sidebar entry. (KRI-54, KRI-60, KRI-66)
- The sidebar footer shows “1 failed” in red (opens All Tasks filtered to Failed), and the Factory row gets a red dot. (KRI-56)

### 7.7 Billing, credentials and cost

- **Billing per agent kind**, in Settings → Agents, stored on this machine: **Subscription** (default) or **API key**. TED never asks for or stores a key. Choosing API key only means TED stops removing the key variables; the CLI’s own setup does the rest. (KRI-54, ADR 0004)
- Under Subscription TED removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CODEX_API_KEY` from the agents’ environment. Codex reads `CODEX_API_KEY`, not `OPENAI_API_KEY`. (KRI-54, ADR 0004)
- Settings → Agents shows what each CLI reports (`claude auth status` `authMethod`; Codex app-server `account/read` `authMode`/`planType`), for example “Claude Max · subscription”. (KRI-54)
- **Credential check.** Each Run row shows “Subscription” or “API key” as the Run reported it at start. If that doesn’t match the billing choice (a stored key, an `apiKeyHelper`, a stray variable), TED pauses that agent kind with “Using an API key, not your subscription”, and Fix explains where the key comes from. (KRI-54)
- **Tokens** show for every Run (“Subscription · 820k tokens”) and in the Runs summary line. **Estimated dollars** show only for API-key Runs: Claude’s `total_cost_usd`, or TED’s price list for Codex. The summary gives dollars only when there are API-key Runs (“4 Runs · 2.1M tokens · $1.12 on API key”) and never says “included in plan”. No budgets or spend warnings in v1. (KRI-54, KRI-63, KRI-64)
- **Plan usage:** Settings → Agents shows bars for the 5-hour and weekly windows with reset times and freshness (“From the last Run · 2 min ago”), from Claude’s `rate_limits` once a Run has made a request and Codex app-server `account/rateLimits/read`. Bars are indigo below 85%, amber at 85%, red at 100%. At 85% in any window, an amber chip appears in the sidebar footer (“Claude 87% · resets 15:40”) that opens Settings → Agents; it hides while that kind is at its limit. No banner or notification. (KRI-54, KRI-64)

### 7.8 Permission modes

- Permission mode is saved per Factory on this computer: `auto` (default) or `bypass`. It applies to Task Leads, sub-agents and reviewers. Planning, Automation and Coordinator Runs always use Auto. (KRI-20, KRI-53, KRI-165)
- Factory settings has a separate **This computer** permission control. **Enable Bypass…** opens a warning with an unchecked acknowledgement and **Enable Bypass**; only the app can save that confirmation. **Use Auto** saves immediately without confirmation. Neither action creates a pull request. New Checks and agent-started Apps also use this mode for sandboxing; the confirmed human-started App exception remains. (KRI-165)
- A committed `.ted/workflow.yaml` cannot enable or disable Bypass. Legacy `permissions` values remain valid but advisory; repo Bypass with local Auto raises a warning linking to Factory settings. Existing repo settings and old Save confirmations do not migrate into consent. Another computer and a removed/re-added Factory start in Auto. (KRI-165)
- Changes apply to newly launched processes, including restart and recovery. Running Runs, Checks and Apps retain their current access until stopped; the settings control explains this. (KRI-165)
- **`auto`:** Claude Code `--permission-mode auto` with prompts routed to TED; Codex `-s workspace-write -a on-request`. Prompts become `permission` Comments. If Claude’s auto mode isn’t available (unsupported model, or disabled by an org admin), TED uses manual mode with every prompt in the Inbox and notes it on the Run. (KRI-53)
- **`bypass`:** Claude Code `bypassPermissions`; Codex `danger-full-access` with no approvals. Only for Factories whose Runs happen in an isolated machine or VM. (KRI-53)
- A permission request is a Comment from the Run with **Deny** and **Approve**, shown in the thread, the Inbox and as a row in the Run chat. A Run waiting on one shows as waiting. Approve and Deny apply to that request only; no “always allow” in v1. A permission request whose Run stops is withdrawn. (KRI-20, KRI-53, KRI-56)

### 7.9 Task brief

- The Task Lead’s own summary of where a Task stands, stored with the Task, versioned, written with `ted brief write`, written at every Gate. (KRI-11, KRI-17)
- Fixed headings: Goal, Decisions so far, Current state (branch, what’s done, Checks status), Open questions, Next step. (KRI-17)
- Task details shows Goal and Next step, plus **Full brief**, which opens the whole brief in the middle pane with “Updated by the Task Lead at the Review Gate · 31m ago”. (KRI-23)

### 7.10 The `ted` command set

The MCP server mirrors every command. Commands sent with a Run token are limited as in 2.3.

| Command | Purpose | Source |
|---|---|---|
| `ted help` | Command reference, named in the Run preamble. | KRI-11 |
| `ted outcome advance` | End the Stage and move on. | KRI-11 |
| `ted outcome back --to <Stage> --findings <file>` | Send back to an earlier Stage. | KRI-11, KRI-16 |
| `ted outcome ask` | Ask the human instead of moving. | KRI-11 |
| `ted comment [--attach <path>] [--choice "…"]` | Post a Comment (note, question with choice buttons, review, sign-off), optionally with files copied into TED’s store. | KRI-11, KRI-55 |
| `ted ask --round <file>` | Post a Clarify or planning round. | KRI-19 |
| `ted clarify depth <none\|few\|grilling> "<why>"` | Pick the Clarify depth and say why. | KRI-142 |
| `ted clarify too-big "<why>" --settle "<point>"` | Ask the size check: Plan in chat, Split it, Plan it outside TED, Grill anyway. | KRI-144 |
| `ted ask --supersedes <id>` | Replace the poster’s own unanswered request. | KRI-61 |
| `ted ask --close --summary <file>` | Close a round after Talk it through, posting the summary note. | KRI-60 |
| `ted brief write` | Write a new version of the Task brief. | KRI-11 |
| `ted status "…"` | Set the activity line. | KRI-11 |
| `ted run start --agent <kind> [--model] [--effort] --prompt-file <file> [--name] [--own-worktree]` | Start a sub-agent. | KRI-11, KRI-53, KRI-63 |
| `ted run wait <id>` / `ted run send <id>` | Wait for a sub-agent’s final message / send it a follow-up. | KRI-11 |
| `ted task create [--start] [--priority <p>] [--source <url>] [--blocked-by <id>] [--description "<text>"]` | Create a Task. `--source` returns the existing Task instead of a duplicate; `--follow-up <id>` revisits a Done Task (12.4). | KRI-15, KRI-20, KRI-55, KRI-60 |
| `ted task start <id>` | Start a Task from Backlog. | KRI-15 |
| `ted task block <id> --by <id>` / `ted task unblock` | Add or remove a blocker. | KRI-55 |
| `ted task repos set`, `add`, `remove <name>` | Set the Task’s Repos. | KRI-58 |
| `ted task propose --file <file>` | Post a Task proposal (Split it, planning chats). | KRI-60 |
| `ted checks [--name <Check>]` | Run the Factory’s Checks now. | KRI-16, KRI-60 |
| `ted run-app` | Start an App or reuse the running instance. | KRI-18 |
| `ted app screenshot <app>` / `ted app record <app> --start` or `--stop` | Capture or record the simulator; saves a file to the Task. | KRI-18 |
| `ted workflow check [<path>]` | Validate `workflow.yaml` and Stage files. | KRI-58 |
| `ted automation <subcommand>`: `list`, `show`, `history`, `create`, `edit`, `enable`, `disable`, `run`, `delete` | Manage Automations (12.3). Inside a Run only `list`, `show` and `history` work. | KRI-60 |
| `ted backup restore <name>` | Restore a backup. | KRI-59 |
| `ted export --factory <key> [--format json\|markdown] --output <path>` | Export one Factory’s retained Tasks and history; never replaces an existing file. | KRI-71 |
| `ted doctor` | Health checks and every active banner. | KRI-20, KRI-59 |
| `ted status` (no argument) | Daemon status and active banners. | KRI-20, KRI-59 |
| `ted open` | Open or focus the app. | KRI-59 |
| `ted mcp` | Start the MCP server for an agent. | KRI-59 |

The daemon also serves `/healthz`. (KRI-20, KRI-59)

### 7.11 Terms of service (ADR 0004)

- Start the user’s installed, unmodified `claude` and `codex` binaries, as live sessions or headless. Never bundle, patch or wrap them. (ADR 0004)
- Sign-in is left to the CLIs (`claude auth login`, `codex login`) or the user’s own API key. TED has no sign-in screen and never reads, copies or stores tokens or keys. (ADR 0004, KRI-57)
- With a Claude subscription, use the CLI, not the Agent SDK. (ADR 0004)
- Never pass `--bare`; opt out if it becomes the default for `-p` (KRI-45). Check Claude Code release notes when updating, following the [subscription compatibility checklist](../research/kri-45-claude-bare.md). (ADR 0004)
- Keep the limit on working Runs on, and show usage limits (7.5). (ADR 0004)
- Keep each agent kind’s sign-in and start code behind one replaceable module. (ADR 0004)
- Before shipping to others: recheck Anthropic’s “third-party harness” rule and the Codex app-server line “App-server authentication has never been permitted for commercial or hosted services”, read OpenAI’s Terms of Use by hand (KRI-44), say “runs Claude Code” in plain text only, never resell usage. (ADR 0004, KRI-21, KRI-54)

---

## 8. Validation

### 8.1 Checks

- Optional commands in `stages.validate.checks`. Each has `name` and `run`, plus optional `repo` (default: the primary repo) and `timeout` (default 10m). Exit code 0 passes; a timeout fails (“✗ Tests · timed out after 10m”). (KRI-16, KRI-60, KRI-65)
- TED runs them itself in the worktree when a Task enters Validate, before the judgment steps. They are not Runs and don’t count toward the limit. (KRI-16, KRI-60)
- **Order:** one after another, in the order listed, never in parallel within a Task. **The first failure ends Validate.** The Checks after it don’t run and show as “– Tests · not run”. The send-back carries the one failing Check, and counts toward `max_back`. List cheap Checks (typecheck, lint) first. (KRI-60 change from Nabha’s review)
- **Environment:** from the root of the Check’s repo in the Task’s worktree, through the user’s login shell (`$SHELL -lc`). The repo’s `worktree.env`, plus `CI=1` and `TED_TASK`. Not `TED_APP_*`: TED doesn’t start Apps for Checks; a Check that needs a server starts it. No TTY, stdin closed. (KRI-60)
- **Output:** TED keeps the full output of every Check with the Validate event; clicking a Check on the ✓ row opens it. The Findings file of a send-back has the last 200 lines of the failing Check and the path to its full log. (KRI-60)
- **Repos the Task didn’t change** (empty diff against the merge-base, uncommitted work included): their Checks are skipped, “– Tests (api) · skipped, no changes”. (KRI-60)
- While Checks run, the Task shows Working, “Running Checks · Tests (2 of 3)”. (KRI-60)
- The rerun after a conflict-free rebase at Merge uses the same runner and also stops at the first failure. (KRI-60)
- **No Checks:** Validate runs on judgment alone, with the “No Checks” warning Factory banner. A Check that exits 127 (command not found) raises the setup-suggested banner. (KRI-22, KRI-59)
- **TED settings Check:** added automatically when a Task’s changes touch `.ted/` (4.11). (KRI-58)

### 8.2 `validate.md`

- Suggested headings only. The default covers: run the project’s tests (and end-to-end tests where they exist); have the reviewer perform code review and security review of the committed diff against a stated base with no Work context; check against the description and the Design brief; for UI changes, take screenshots, judge them against what was wanted, and attach them as evidence. The aim is as much automated validation as possible. (KRI-16, KRI-199)
- Every default Validate pass records the security review’s scope, method and outcome. Changes involving input, files, processes, network or credentials get a review of the relevant trust boundaries, permissions and failure cases, using an available security skill or tool when helpful, or manual review. A change with no security-sensitive impact records why. Code and security Findings use the same blocking/note flow. (KRI-199)
- Factory setup always writes a Factory `validate.md`: how to start the app, which flows to run, what “looks right” means here. (KRI-16, KRI-22)
- For local web Apps, agents use `ted browser open <App>`, `snapshot`, `click`, `fill`, `press`, `navigate`, `back`, `forward`, `reload` and `screenshot` to drive the same Task browser the human sees. Sessions are isolated per Task and last until TED quits. Only the selected App’s origin is reachable; external login and resources use the default browser. (KRI-18, KRI-34, ADR 0097)
- Pass means no blocking Findings. (KRI-16)

### 8.3 Findings

- A Finding is blocking or a note. Only blocking Findings send the Task back. Notes carry into the Review brief. (KRI-16)
- The thread shows “Validate sent this back to Work (round 2 of 5)” with a red-tinted “Blocking findings” box. (KRI-16, KRI-61)

### 8.4 Reviewer

- `reviewer` (4.5). The reviewer performs code review and security review of the committed diff with no Work context, supplied with the Task, acceptance criteria, Design brief, repo guidance and a stated base commit. One reviewer can cover both reviews, reporting requested behaviour, repo standards and security separately with evidence for each Finding. (KRI-16, KRI-53, KRI-199)
- An explicit `reviewer` pauses like any other Run and never falls back. An unset `reviewer` picks from the agent kinds that are installed, signed in and not limited when Validate starts. The Validate event names the reviewer, for example “Reviewed by Claude (Codex unavailable)”. (KRI-54)

### 8.5 Loop limit

- Validate `max_back: 5`. At the third send-back (`loop_check: 3`; `false` turns it off), TED itself starts a sub-agent with the `reviewer` agent, model and effort. It reads the three rounds of Findings and the diffs between them and says **converging** or **looping**. (KRI-16, KRI-53)
- Converging: back to Work with the verdict added. Looping: ask the human now. (KRI-16)
- At the send-back limit, TED runs a fresh Loop check before asking, unless `loop_check` is `false`. This assessment includes the pending Findings as well as the earlier rounds; even a converging verdict waits for the human’s decision. A failed or unavailable assessment is shown as unknown. (KRI-269)
- The ask (a `question`, at a looping verdict or over 5) gives a short progress assessment and recommends an existing next step. It offers **Try again** (resets the count), **Back to Design**, **Move to Review anyway** (open Findings go in the Review brief), plus the text box. Moving on explicitly leaves the Findings open. Full Findings stay in the Task’s history, including the pending send-back; asking does not count as sending back. (KRI-16, KRI-55, KRI-269)

Human-facing Task messages across Stages lead with the current result, risk or needed decision, followed by its consequence and next step. Shared Task Lead guidance keeps routine updates brief and sign-offs clear about what is being approved. Validation summarizes relevant coverage and review outcomes while keeping remaining concerns prominent; detailed logs, review identifiers and test inventories belong in linked or attached evidence. Briefs retain the context a replacement Task Lead needs. Existing messages are not rewritten or automatically shortened. (KRI-269)

### 8.6 Confirmation row

- A compact row such as “✓ Typecheck ✓ Tests ✓ Review ✓ Visual” on each Validate event in the thread and at the top of the Review sign-off. ✗ in red; skipped and not-run Checks in grey; it wraps and ends with an **Output** link. Notes show as “✓ Review · 2 notes”. Nothing extra on Board cards. (KRI-16, KRI-61)

---

## 9. Pull requests, Review and Merge

Figma: KRI-61 Task thread (sign-off, re-sign-off, Merge off, Merge Gate, simulator request); Page 1 (Apps section, App log, simulator popover); KRI-63 Task details (Changes, diff, line comments).

### 9.1 Pushing and pull requests

- **TED pushes and opens pull requests, never the agent.** Agents only commit in their worktree. (KRI-58, ADR 0007)
- When a Task first enters Validate with commits, TED pushes `ted/<id>-<slug>` with the user’s git credentials and opens a **draft** pull request with `gh pr create --draft`. Title: the Task title. Body: the brief’s Goal plus a link back to the Task. (KRI-58)
- TED pushes again each time Validate passes, so CI and hosted previews run on what the human will review. (KRI-58)
- When the sign-off is posted, TED marks the pull request ready for review (`gh pr ready`). (KRI-58)
- Multi-repo Tasks get one pull request per repo that has commits, each linking the others. A repo with no commits gets none. (KRI-58)
- Every GitHub request runs through `gh` as a child process (`gh api` for REST and GraphQL, `gh pr` for create, ready, auto-merge, merge and close), with `GH_PROMPT_DISABLED=1` and `GH_NO_UPDATE_NOTIFIER=1`. Polling sends one batched GraphQL query per host per cycle. TED never runs `gh auth token` or `--show-token`. (KRI-57, ADR 0007)
- **When `gh` fails:** Runs keep going; pull request watching stops; Tasks at Merge show **Waiting for GitHub sign-in**; the app-wide banner shows. Once `gh` works again, TED reads the current state of every open pull request and sends anything it missed (CI failures, review comments, conflicts) to the Task Leads. GitHub rate limits back off on their own. (KRI-57)

### 9.2 Review sign-off card

- Shows the Task brief, the ✓ row, evidence from Validate (screenshots, and recordings where possible), a “How to try it” section where it applies, and its own **Preview** row (hosted, else local Web App, else **Run** / **Run again** with a Log link). (KRI-18, KRI-23)
- Buttons sit in a row below the comment box, secondary left, primary right. (KRI-23, KRI-60)
- **Re-sign-off** after a conflicting rebase or a CI fix at Merge shows a “Changes since you approved” block (one-line summary, changed files with +/− by repo, “no changes” for an unchanged repo), a fresh ✓ row and a **Show first sign-off** link. (KRI-52, KRI-61)
- After sign-off, with the merge pending, the comment box shows an amber note that sending cancels the merge and counts as Request changes, and the button is a red **Send and cancel merge**. (KRI-52, KRI-61)

### 9.3 Button labels

| Card | When | Buttons |
|---|---|---|
| Review sign-off | Merge on, no Merge Gate | **Request changes** · **Approve and merge** |
| Review sign-off | Merge on, with a Merge Gate | **Request changes** · **Approve** |
| Review sign-off | Merge off | **Request changes** · **Approve**, caption “Merge is off for this Factory. You’ll merge on GitHub.” |
| Re-sign-off | after a conflicting rebase or CI fix | same as the first sign-off in that Factory |
| Merge sign-off (Merge Gate) | one / several pull requests | **Request changes** · **Merge** / **Merge 2 pull requests** |
| Design review, grilling sign-off | | **Request changes** · **Approve** |
| Task proposal | | **Request changes** · **Create 4 Tasks** (count of checked rows) |
| Permission | | **Deny** · **Approve** |
| Simulator request | | **Deny** · **Shut down NB-40’s and run** |
| CI stuck at Merge | | **Send to Task Lead** · **Keep waiting**, plus **Merge anyway** only when no pending check is required |
| FAILED ask | | **Send** · **Retry** |
| Idle ask | | **Nudge again** |

(Source: KRI-60, KRI-61, KRI-55.)

### 9.4 Preview

- The one place to look at a Task’s work: the hosted preview its pull request reports (from GitHub Deployments and commit statuses), else its running App. A hosted preview is its own row in the Apps section. TED never deploys anything. (KRI-18, KRI-23)

### 9.5 Line comments and the Changes section

- **Changes** in Task details: “Changes · 5 files” with **Expand all**, files grouped by repo with per-repo +/− totals. A file row shows name, folder in grey, +/− counts, an amber dot for uncommitted work, and a small number for draft line comments. + is green and − is red everywhere. (KRI-20, KRI-63, KRI-8 consistency pass)
- Clicking a file replaces the middle pane with its diff: “← Thread”, path, repo chip, +/−, “1 of 5” with previous and next, **Open in editor**, and a grey line “against its merge-base with develop” naming the repo’s `base_branch`. Unified diff with old and new line numbers. Diffs are the Task branch against its merge-base, uncommitted work included. Image diffs if they come with the ported UI. (KRI-20, KRI-63)
- **Expand all** widens the details pane into one scrolling column of every diff, with the file list as a sticky index. (KRI-20)
- **Drafting:** hovering a line shows **+** in the gutter; click it, or drag down the gutter for a range, to open an inline box with **Add comment** and **Cancel**. Drafts can be written at any Stage once a diff exists, save at once in the store, and sit inline with **Edit** and **Delete**. (KRI-60)
- **Sending:** drafts go with the next Comment the human sends on the Task: Request changes, a plain Comment, or a design review answer. **Approve never sends them and never asks.** The chip above the comment box reads “3 unsent line comments”; clicking it lists them. The diff bar says the drafts go with Request changes or the next Comment, with **Back to sign-off** and **Discard all** when a request is open, or **Send to Task Lead** (posts them as one Comment) when none is. After Done, drafts go with **Follow up**. (KRI-60, KRI-63, KRI-8 coordinator decision 7)
- **To the agent:** one Comment with the human’s text, then each line comment as path, line range, commit SHA, quoted lines and text. **In the thread:** the Comment shows a collapsed “3 line comments”, each linking to its line; one whose lines changed since shows “Outdated”. No reply threads in v1. Never posted to GitHub (KRI-72). (KRI-60)

### 9.6 Apps

```yaml
apps:
  - name: Web
    run: "npm run dev -- --port ${PORT}"
    url: "http://localhost:${PORT}"
    ready: url
  - name: iPhone
    kind: ios-simulator
    device: "iPhone 17"
    run: "npx expo run:ios --device ${TED_SIMULATOR_UDID}"
```

- Declared per repo under `repos[].apps`. Keys: `name`, `run`, `url`, `ready`, `kind`, `device`, optional fixed `port`, optional `env`. (KRI-18, KRI-58)
- `kind`: `web` (default), `command` (no URL) or `ios-simulator`. React Native Web is a `web` App. (KRI-18)
- TED picks a free port per App per worktree and passes it as `${PORT}` and `PORT`. A taken fixed `port:` fails with a clear error. Port agent-orchestrator’s `previewserver` manager. (KRI-18)
- One running instance per App per Task, shared by the human and agents (`ted run-app` reuses it). Restarts and crashes show as thread events. (KRI-18, KRI-61)
- Apps run until stopped, the Task merges, or the Task is archived. They don’t count toward the limit. (KRI-18)
- **Apps section** in Task details: grouped by repo when a Task spans several. Each row: status dot, name, one status line (`localhost:5174`, `iPhone 17 · booted`, `Shut down 20m ago to free a slot for NB-44`, `Exited with code 1`), and ↗ Preview (web) or Show (brings the simulator to the front), ▶/■ Run/Stop, ↻ Restart. A `command` App has no Preview. Clicking a row replaces the thread with the App’s log, with its controls in a header and “← Thread”. (KRI-23)

### 9.7 iOS simulators (macOS only)

- One simulator device per Task, cloned from the App’s `device` on first run, booted when needed, shown in Simulator.app, shut down when idle, deleted when the Task is archived. TED manages the device; the Factory’s `run` builds and installs using `TED_SIMULATOR_UDID`. (KRI-18)
- At most 3 booted at once (Settings → Limits). The sidebar footer shows “Simulators 3 of 3 booted” while any is booted. (KRI-18, KRI-23)
- **The human presses Run with all slots booted:** a popover lists the booted simulators by Task, the one used longest ago selected, with **Cancel** and “Shut down NB-40’s and run”. TED never shuts one down silently. (KRI-23)
- **An agent needs a simulator with all slots booted:** the Run posts a `permission` Comment and waits; the Task shows Waiting on you. The card reads “iPhone needs a simulator · 3 of 3 booted”, lists the booted simulators by Task (ID, title, App, “last used 40m ago”) as radio rows with the oldest pre-selected; a recording simulator is listed but can’t be picked. **Deny** makes `ted run-app` return “No simulator slot: the human denied”. If a slot frees up first, TED uses it and closes the request with “A simulator freed up; nothing was shut down.” (KRI-60, KRI-61)
- `ted app screenshot` / `ted app record` capture through `simctl io`. (KRI-18)
- A missing Xcode or simulator runtime raises the stops-work Factory banner for those Apps. Hidden on Linux. Android emulators are later (KRI-47). (KRI-59, KRI-18)

### 9.8 Trying it by hand: shell and editor

- At any Stage once a worktree exists, through the Task’s shell and **Open in editor**. TED never checks a branch out into the user’s own clone. (KRI-18, ADR 0006)
- The **Code** section in Task details has one row per repo: the pull request, the branch, the worktree path (click to copy), **Shell** and **Open in editor**. Before the first Task Lead Run it reads “No worktree yet”; while `setup` runs, “Setting up…” with a link to the setup log. (KRI-60, KRI-63, KRI-58)
- **Shell** (or ⌃`) replaces the middle pane with Task shells: xterm.js, repo name and worktree path in a shared header, **Open in editor**, “← Thread”. Each pane has **Split right**, **Split below**, **Find**, **Restart shell** and **Close**. Splits can nest, up to eight panes per Task/repo; dividers drag or move with arrow keys when focused. Each new pane starts the user’s login shell at the worktree root with `worktree.env`, `TED_TASK` and `TED_APP_*` but never `TED_RUN`, so `ted` commands act as the human. Input, output, search and restart belong to one pane. (KRI-20, KRI-60, KRI-32)
- The daemon owns the shells and pane layout. They survive app restarts, stay while the Task is Stopped, and end when the worktree is removed or the daemon stops. Closing or restarting a pane confirms before ending its shell and jobs in the original OS session, plus descendants still connected through current parent relationships; other panes keep running. The confirmation warns that programs which detached into separate sessions may keep running. A program that leaves the original session and becomes reparented before cleanup is outside terminal cleanup. An exited shell keeps its output and a Restart action. Closing the last pane shows **Open Shell**; returning to the view stays empty until the human opens a fresh one. “← Thread” hides panes without closing them. A daemon restart resets the layout; next open starts one fresh shell. (ADR 0075, ADR 0097)
- **Editor:** Settings → General → Editor lists the editors TED finds (VS Code `code`, Cursor `cursor`, Zed `zed`, Windsurf `windsurf`, Sublime Text `subl`, JetBrains launchers, Xcode `xed`) and **Custom command** with `{path}`, `{line}`, `{column}`. No default guess: the first use with nothing set shows a picker of editors found and remembers the choice. It opens the worktree folder; from a diff, the file at the line in each editor’s own syntax. (KRI-57)

### 9.9 Merge rules

1. **TED merges, not the Task Lead.** The daemon runs `gh pr merge` under the user’s `gh` login. The Task Lead only fixes what stands in the way (conflicts, CI failures); `merge.md` says how. (KRI-52, ADR 0007)
2. **Approve and merge** merges once CI passes (GitHub’s required checks, or all checks if none are required), the pull request is mergeable, and nothing changed since sign-off apart from a conflict-free rebase. With the Review Gate off, Merge runs right after Validate. (KRI-52)
3. **CI detection.** When TED pushes, it decides whether the repo has CI: yes if the branch has files in `.github/workflows`, the base branch requires status checks, or any of the last 20 commits on the base branch has a check run or status. **No CI:** TED merges as soon as the pull request is mergeable, with the thread line “No CI on app · merged without waiting”. **CI:** TED waits for the checks however slow; required checks are always waited for. If the repo has CI but no check has appeared 10 minutes after the push, or a check is still queued or pending after 60 minutes, TED posts the CI-stuck `question` (author TED) with **Send to Task Lead**, **Keep waiting** (another 60 minutes) and **Merge anyway** (only when no pending check is required). The 60 minutes has no setting. (KRI-60 change from Nabha’s review)
4. **Merge Gate** (`stages.merge.gate: true`, off by default). TED posts the Merge sign-off **after CI passes and every pull request is mergeable**, so Merge merges at once; until then the Task shows Waiting for CI. The card has one row per pull request in merge order (repo, PR number and title, CI summary, mergeable state, merge method, any required GitHub review missing) and “Changes since you approved: none”, or the list. With no Review Gate it also carries the Review card’s content. Request changes works as at Review. (KRI-52, KRI-60)
5. **Merge can be turned off** (`stages.merge.enabled: false`). The Task then waits after sign-off as **Waiting for merge**; the human merges on GitHub, and TED moves the Task to Done when it sees the merge. (KRI-52)
6. **Changes after sign-off.** A conflict-free rebase onto a moved base: TED reruns Checks, waits for CI and merges, with no new sign-off. A rebase with conflicts, or CI failing at Merge: back to Work, through Validate, to a short re-sign-off. Merge `max_back: 3`; over it becomes a question. (KRI-52)
7. **Merge method:** `merge_method` per repo, squash by default. If GitHub doesn’t allow it, TED uses one it does allow and notes it in the thread. The branch is deleted after merge. (KRI-52)
8. **Multi-repo:** merge in `repos` order. TED checks every pull request is green and mergeable before merging the first. Merged pull requests are never reverted automatically. A failure partway leaves the Task in Merge as **Partly merged** until the Task Lead fixes the rest through Work, Validate and a short re-sign-off. (KRI-52)
9. **Branch protection:** after sign-off TED turns on GitHub’s auto-merge where the repo allows it, so GitHub enforces required reviews, checks and merge queues. Otherwise TED polls and merges once GitHub reports the pull request mergeable. A required teammate review shows as **Waiting for GitHub review**, not an Inbox item; review comments go to the Task Lead. (KRI-52, KRI-20)
10. **After merge:** Done (6.15). (KRI-52)

---

## 10. UI

### 10.1 Visual base and dark mode

- Start from agent-orchestrator’s visual style, kept calm and simple. No translucency. (KRI-13, KRI-20)
- Typography and density copy agent-orchestrator exactly: (KRI-14)
  - Fonts: Geist Variable and Geist Mono Variable (bundled); on macOS, `-apple-system` (SF Pro) and SF Mono.
  - Body 14px, line height 1.5. Dense controls 13px, captions 11px, small 12px.
  - Scale (px): 8, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 17, 21, 22, 28. Line heights: 1.42, 1.5, 1.55, 1.6, 1.7; table rows 20px.
  - Terminal 12px (adjustable 10–20, saved per user), line height 1.35. Chat 14px, code in chat 12px.
  - Weights 500 and 600 only, sentence case, tabular numbers.
- Higher contrast for secondary text, captions and lines, in both themes. (KRI-23)
- **Text size:** Settings → General → Display has a − / + percentage control, default 100%, in 5% steps from 80% to 200%. It changes app text immediately and is saved on this computer. Default restores 100%. Terminal font size stays independent; Electron zoom still works. (KRI-51)
- **Dark mode is in v1.** TED follows the system appearance by default. Settings → General → **Appearance**: System, Light, Dark. It changes the theme at once, with no restart. Every colour is a token with a light and a dark value, including status colours, diff green and red, and the agent marks. Dark versions of the main screens are being designed in Figma. (KRI-64 change from Nabha’s review)
- **Colour meanings.** For Task statuses, Run icons, Run rows and event lines, amber means only Waiting on you. In banners, the plan-usage chip and bars, amber means a warning. Red means failure or stops-work. Blue means working or queued. Grey is everything else, Paused included. (KRI-8 coordinator decision 24, KRI-54, KRI-61, KRI-64)
- **Run icons** use the Anthropic mark (Claude Code) or the OpenAI mark (Codex), monochrome, inside a ring coloured by state: blue working, amber waiting on you, grey idle or stopped, faint grey dashed Paused, red failed. 18px everywhere. The Task Lead comes first, then up to two sub-agents, then “+N”. A Task Lead waiting only on its sub-agents has a grey ring while the Task still says Working. (KRI-8 consistency pass, KRI-11, KRI-61, KRI-62)
- **Avatars:** agent messages use the agent avatar; the human uses a Person avatar (photo from Settings → General → **Profile picture**, or initials). (KRI-8 consistency pass)
- **Priority icon:** Linear-style bars. Urgent is an exclamation mark in a square; None is three dim dashes. The same icon on cards, List rows and Inbox rows. (KRI-8 coordinator decision 6)
- Small explanatory notes are a (?) with a tooltip; text the human needs to act on stays as text. (KRI-8 consistency pass)
- The Figma pages and their shared components (Sidebar, Run icon, avatars, Help, Tooltip, Priority, status chips) are the reference for colours, spacing and icons. (KRI-8 consistency pass)

### 10.2 Layout and navigation

Figma: KRI-62 Board and List (Sidebar component 26:1613), Page 1 (Inbox · three panes, 4:2).

- **Three panes:** sidebar; middle pane (the Inbox list and Task thread, a View, a Run chat, or swapped-in content); right pane (Task details). Board and List open in place of the Inbox list. Clicking a Task opens its thread and details in place, with a back link (“← Board”, “← List”, “← All Tasks”). (KRI-13, KRI-56)
- **Middle-pane navigation:** Conversations open as tabs beside **Thread**, one per opened Run, with a status dot and ×; tabs belong to each Task and persist across restarts. Diffs, App logs, the shell and Full brief replace the current tab’s content with a “← Thread” link. (KRI-63, KRI-8 coordinator decisions 2 and 3)
- **Scope:** the Inbox covers every Factory, always, with a Factory filter. The Board is one Factory. The List is one Factory or **All Tasks**. Plans, Automations and Factory settings are one Factory each. Search covers every Factory. (KRI-56)
- **Current Factory:** the Factory of whatever is on screen; with nothing open, the last one. The New Task dialog defaults to it. (KRI-56)
- **Sidebar, top to bottom:** (KRI-56, KRI-62, KRI-64)
  - A **Search ⌘K** field and a square **+** for New Task.
  - **Inbox** with the count of waiting requests.
  - **All Tasks**.
  - **Factories**: one row per Factory with chevron, name, a red dot for any Failed Task, a red ⚠ for a stops-work Factory banner, and its waiting count in amber (clicking the count opens the Inbox filtered to it). The current Factory is expanded with **Board**, **List**, **Plans**, **Automations**, **Settings** indented; the open View has a grey fill. Plans and Automations get a red dot for a Failed planning chat or a failed last Automation result; Settings gets a drift count and a red dot for problems. Other Factories are collapsed; clicking one opens its last-used View (Board the first time). Rows reorder by drag. **+ Add Factory** ends the section. There is no separate Factory switcher.
  - **Settings ⌘,**, above the footer, separate from each Factory’s Settings entry. A red dot when any section has a stops-work problem.
  - **Footer**, lines hidden when empty: “4 of 6 Runs working · 2 queued” (or “Nothing running”; click for the Working Runs popover), “1 failed” in red, “3 Runs paused” in grey, “Simulators 3 of 3 booted”, then the plan-usage chip and the update chip.
- Width: 210px. (KRI-8 polish pass)
- Developer mode doesn’t add sidebar entries; Diagnostics and the log viewer live in Settings → Developer. (KRI-57)

### 10.3 Working Runs popover

- Opens above the sidebar footer from the Runs line. Title “Working Runs · 6 of 6 slots on this Mac”. (KRI-56, KRI-62)
- **Working:** one row per slot holder (a Task with ID, title, Factory and which Runs are working; an Automation Run by name; a planning chat as “Plan” and its title), with the slot count. A Factory’s own cap shows in the row (“Marketing site 1 of 2”). (KRI-56, KRI-62)
- **Paused:** Paused Runs and Paused Queued Tasks, below Working; a Queued Task keeps its place (“3rd · resets 15:40”). (KRI-8 coordinator decision 18)
- **Queued:** everything that waits for a slot, numbered in queue order (6.5): the setup Task (“Setup”), sub-agent requests, Planning Runs, Automation Runs, then Tasks with Factory and Priority. (KRI-56, KRI-60)
- Read-only: “Read-only. Reorder the queue in the List.” with **Open in List →** (All Tasks filtered to Queued, sorted Manual). Empty: “No Runs working. Nothing queued.” (KRI-56, KRI-62)

### 10.4 Inbox

Figma: KRI-62 Board and List (Inbox with the Factory chip), Page 1 (4:2).

- The Comments waiting on the human: every non-`note` Comment that hasn’t been answered, from every Factory. (glossary, KRI-55)
- **Header:** Inbox, a (?), Factory chips with counts (“All 5 · Notebook 4 · Marketing site 1”), and an **Answered** switch that shows requests answered in the last 30 days, newest first, read-only. (KRI-56, KRI-62)
- **Order:** the Task’s Priority (Urgent first), then oldest first. Requests not on a Task count as Priority None. No grouping; one row per request. (KRI-56)
- **Row:** Priority icon, kind label, one-line headline, Task ID and title, Stage, age, and the Factory name when there is more than one Factory. Automation and planning chat rows show the Automation’s name or the chat’s title instead of the Task. (KRI-56, KRI-62)
- **Kind labels:** Question, Clarify round, Design review, Sign-off, Permission, Proposal; the Failed ask is labelled FAILED in red. Planning chat rows read “Plan · Round 1 · 5 questions” and “Plan · Proposal · 5 Tasks”. (KRI-56, KRI-60, KRI-8 polish pass)
- **Unread:** bold until opened. No “mark unread”. (KRI-56)
- **Leaving the Inbox:** there is no dismiss. A request leaves when the human answers it (in TED, or with `ted` from a terminal); when its Task is archived or deleted; when it is superseded (`ted ask --supersedes`); when it is a Gate request and the Task leaves that Stage; or when it can no longer be answered (a permission request whose Run stopped, a request from a stopped planning chat or Automation Run). Superseded and withdrawn requests stay in the thread marked so. Requests on Stopped or Failed Tasks stay; the answer is stored for the next Run. (KRI-56, KRI-61, KRI-55)
- **After answering,** the selection moves to the next row. (KRI-56)
- **Never in the Inbox:** setup notices, banners, drift, “Waiting for GitHub review”, Paused, sub-agent failures. (KRI-22, KRI-52, KRI-54, KRI-59)

### 10.5 Task thread

Figma: KRI-61 Task thread (every request card, answered states, event lines, header statuses, comment box states).

- **Header:** Task ID, source, title, the status pill (one, by precedence), the Stage track, the activity line, Run icons at the right of the meta line, and **⋯** for Task actions. A Stopped Task also shows **Resume** in the header. (KRI-13, KRI-61, KRI-63)
- **Comment kinds** (one enum; author is human, agent Run or TED): `note` (never in the Inbox), `question` (optional choice buttons; also covers looping past `max_back`, Model unavailable, FAILED and the idle ask), `round`, `review` (design review), `signoff`, `permission` (also the simulator request), `proposal` (Split it and planning chats). (KRI-55)
- **Request cards** share one layout: amber border; header “KIND · from the Task Lead · 4m ago” (or a sub-agent, or TED); title; one or two lines of summary; the kind’s content; the comment box; the buttons in a row below it (9.3). (KRI-61, KRI-8 polish pass)
  - **Design review:** screenshot tiles and a video tile, the prototype in a sandboxed frame with **Restart** and **Open full size ↗**, a Figma link row, and a “Worth your eye” box. (KRI-13, KRI-61)
  - **Clarify round:** numbered questions in one card. Each recommended answer is pre-selected or pre-filled and tagged “Recommended”; an answer the human changed is tagged “Changed · Reset”. Each question has its own small text box. Buttons: **Talk it through** on the left, then **Submit answers** (sends what is shown, including the pre-selected recommendations when unchanged). (KRI-19, KRI-61, KRI-270)
  - **Grilling sign-off:** a “Decisions so far” block, an “Open questions” line, and one line saying what each button does. (KRI-61)
  - **Permission:** the command in monospace prefixed by the repo, why the agent needs it, and “Applies to this request only.” A comment goes to the Run with either answer. (KRI-61)
  - **Re-sign-off, Merge off, Merge Gate, simulator, FAILED and idle asks:** as in 9.2, 9.3, 9.7, 9.9 and 6.18.
- **Answered requests** collapse in place into a grey card: kind, poster, age, title, **Show request** (opens the full card read-only), and one answer line: green ✓ approved or answered, red ✕ denied, grey – withdrawn or “A simulator freed up”, grey ↻ superseded. The human’s comment is quoted under it. An answered round lists each answer, tagged recommended or changed; a round closed by Talk it through reads “Answered in Talk it through · 14 messages” with **Open chat**, followed by the summary note. (KRI-61)
- **Several open requests:** one is pinned at a time, oldest first. A row above it reads “2 waiting on you” with one chip per request (kind · age); clicking a chip switches the pinned card; opening a request from the Inbox pins that one. Each open request also has an amber line in the thread at the time it was posted. A newer request never replaces an older one automatically. (KRI-61)
- **Event lines:** one line each, an 8px dot, 12.5px text, the time on the right. Text, Comments and card content start at the same x, with dots hanging in the padding. Dot colours: hollow grey for Stage moves and the human’s edits; green for created, passed, merged and Done; blue for Runs and Apps starting or continuing and TED actions under way; red for failures and send-backs; grey for Paused, continued and TED nudges; amber only for open-request lines. Some carry content: the ✓ row, a “Blocking findings” box, **Show changes** on a description edit. The KRI-61 “Event lines in the thread” frame lists every kind. (KRI-61, KRI-8 consistency pass)
- **Comment box,** always first with buttons below: (KRI-61, KRI-55)
  - Live Run: **Send**.
  - Paused: note “The Task Lead reads this when it continues.”
  - No Run (Backlog, Queued, Blocked): note “The Task Lead gets this with the brief when the Task starts.”
  - Stopped: **Send** and **Send and resume**.
  - Failed: the FAILED ask holds the box, with **Send** and **Retry**.
  - Done: typing shows **Comment only** and **Follow up**.
  - After sign-off with the merge pending: red **Send and cancel merge** (9.2).
  - Archived: no box.
- ↵ sends from the comment box, and from the answer box of a request card (Request changes at a Gate, never Approve); ⌘↵ sends too. When the box has two buttons, ↵ presses the primary one (**Send and resume**, **Follow up**). ⇧↵ adds a new line. Nothing sends while an input method is composing, or when the box holds no text and no files. Boxes that hold a document (Edit description, New Task description, Automation prompt, Factory notes, Stage files, a Clarify round’s answers) keep ↵ as a new line. (KRI-56, KRI-204)
- **Attachments in Comments:** images, and HTML in a sandboxed frame. No artifacts gallery. (KRI-20)
- **The human attaches files** to any Comment by dragging them onto the comment box or pasting, as in the New Task dialog. A sent Comment can’t be edited or deleted, because it goes into the live Run at once; the human corrects it with another Comment. (GAP-63, Nabha’s review)

### 10.6 Run chat and steering a Run

Figma: KRI-63 Task details (Run chat in a Conversation tab; “Steering · message while working” 44:5104; “Steering · after redirect” 45:1181).

- A **Run bar** above the chat: Run name, agent · model · effort · credential · tokens · start time, **Restart** (greyed while working), and **Stop Task** for the Task Lead or **Stop Run** for a sub-agent. (KRI-63)
- **Chat content:** TED’s instructions as a collapsed first row, then the prompt (collapsed); agent messages; tool calls as collapsible rows, Edit rows expanding to a diff; the human’s messages in a tinted bubble labelled “to this Run only”; permission rows inline (“You approved · 9m ago”, or Approve and Deny); a running command with its elapsed time; the streaming message marked “writing…”. (KRI-63, KRI-53)
- **Steering a working Run** (the Task Lead’s or a sub-agent’s): (KRI-8 consistency pass, steering)
  - **Send ↵** queues the message for the agent’s next step. It shows at once, marked “Queued”.
  - **Interrupt and send ⌘↵** stops the current turn, not the Run, then sends.
  - ⇧↵ adds a new line. Planning chats and Automation Run chats send with ↵ the same way. (KRI-204)
  - **■** stops the turn without sending. Messages queued before it stay queued, with Send now and Delete, until the human sends them or sends another message, which delivers them first. (KRI-108)
  - Hovering a queued message shows **Send now** (interrupts the turn and delivers it) and **Delete**, with a (?) “Only until the agent has read it.” (KRI-63 note from Nabha’s review, KRI-80)
  - **TED holds queued messages**, not the CLI. Both CLIs take a message the moment it is written to them and offer no way to remove one, so TED keeps it in its own store and delivers it at the agent’s next tool-call boundary, where it lands in the same turn. Once delivered, the message is no longer “Queued” and Delete goes away. (KRI-80, `docs/research/kri-80/`)
  - **Codex** (`codex app-server`): on `item/completed` for a tool item, TED sends the message with `turn/steer` (`expectedTurnId` set). If `turn/completed` comes first, or the steer is refused because the turn ended, it uses `turn/start`. Interrupt: `turn/interrupt`, wait for `turn/completed` with status `interrupted`, then `turn/start`.
  - **Claude Code** (stream-json or PTY): a `PostToolUse` hook in the per-Run `--settings` asks the daemon whether a message is queued. If one is, the hook waits while TED writes it as a normal user message (stdin, or typed into the PTY) and sees it accepted (the replayed user message, or the `UserPromptSubmit` hook); the CLI then gives it to Claude at that boundary. With no tool call before the turn ends, TED sends it after the `result` event or `Stop` hook. Interrupt: the `interrupt` control request in stream-json (or a message with `priority: "now"`), Esc in a PTY.
  - Never deliver a queued message as a hook’s `additionalContext`: Claude Code shows it to the model as a system note, and the model may ignore it as not coming from the human.
- When the human messages the Task Lead in its Conversation, the thread gets the event line “You steered the Task Lead in its Conversation · View message”. (KRI-8 consistency pass)
- Runs outside a Task (Automation Runs, planning chats) use the same chat, with their Comments as cards in the chat, the open request pinned above a message box, and the right pane listing what the Run created (12.5, 13.5). (KRI-60, KRI-66)

### 10.7 Task details

Figma: KRI-63 Task details; Page 1 (Apps section 13:3, Full brief 14:204).

- Order, top to bottom; each heading collapses its section to a one-line summary (“Apps · 3 running”): (KRI-63, KRI-8 coordinator decision 4)
  1. A **Setup Task** note, on setup Tasks only (5.3).
  2. **Fields:** Priority, Task Lead (the setting as written, “Claude · opus · high”), Clarify depth (“Few · by the Task Lead”), Repos (multi-repo only), Blocked by, Blocks.
  3. **Code:** per repo, the pull request, branch, worktree path, **Shell**, **Open in editor** (9.8).
  4. **Changes** (9.5).
  5. **Runs:** a summary line (7.7); live Runs first, the Task Lead with its sub-agents indented under it; stopped Runs under a collapsible “3 stopped Runs” line, newest first. Each row, flush left: Run icon, Run name, state; agent · model · effort as the CLI reported at Run start (an unset model shows the real name; unreported effort shows “default effort”); Subscription or API key · tokens, plus dollars for API-key Runs. Hover shows Restart and Stop; Stop on the Task Lead is Stop Task. Clicking opens the Conversation tab. Run state words are lower case.
  6. **Apps** (9.6), including a hosted preview row.
  7. **Task brief:** Goal and Next step, plus **Full brief**.
- **Original request** is a collapsed row at the end of the Task brief section, with a link to the description’s history. (KRI-19)
- **Task actions menu** (⋯ in the header, or right-click a Board card, List row or Task header): the first item by status (Backlog **Start**, Queued **Move to Backlog**, Stopped **Resume**, Failed **Retry**, Done **Follow up…**, Working **Stop Task** with “Stops all 3 Runs. Worktree and Apps stay.”), then Priority ▸, Task Lead ▸, Clarify depth ▸ (greyed after Clarify), Blocked by…, Edit title and description…, Copy Task ID, Open source in Linear, Archive… (⌘⌫) and Delete… in red. An archived Task has **Unarchive**, **Copy Task ID** and Delete. Opening or using the menu does not trigger the enclosing Task’s navigation. (KRI-63, KRI-284)
- **Context menus:** right-clicking a selected List row applies common actions to every selected Task; the heading names the selected count. An unselected row has that Task’s actions. Selection stays intact when a menu opens. Bulk Archive and Delete confirm the group and retain pull-request and blocker choices; operations stop on a failure and identify the Task, with earlier successes retained. Files and Changes entries offer **View file** or **View changes**, and **Copy path** (repo-relative, with the repo in the heading). Inbox entries offer **Open request** and **Copy message text** for Task requests, planning requests and Automation questions; answers and approvals stay in the full request. ⇧F10 or the Context Menu key opens a focused object’s menu; arrow keys navigate, Enter chooses, Escape closes and restores focus, and outside clicks or Tab dismiss. Menus fit the viewport and support scrolling when necessary. (KRI-284)

### 10.8 Board

Figma: KRI-62 Board and List.

- **Columns:** Backlog, the Factory’s enabled Stages in `order`, then Done. 248px wide; the Board scrolls sideways. Header: Stage name, count, a lock icon with “Gate” on Gated Stages. A Stage turned off while Tasks are in it keeps its column, dashed and labelled “Turned off”, until empty; other turned-off Stages are hidden. (KRI-56, KRI-62)
- **Cards:** Priority icon, ID, then the Start button (Backlog, not when blocked) or Run icons; title up to two lines; one status chip; markers; one activity line cut off with “…”. Queued cards sit at the top of Intake with “Queued · 2nd”. A Failed card offers **Retry** on hover and in its menu. (KRI-56, KRI-62, KRI-8 coordinator decision 14)
- **Done column:** Tasks that reached Done in the last 7 days, newest first, as compact cards (grey title, “NB-28 · Merged 2h ago”), ending with **Show all N** (the Factory’s List filtered to Done). Its column menu has **Archive all in Done**, with a confirm naming the count. Archived Tasks never show on the Board. (KRI-56, KRI-62)
- **Order** in a column: Priority, then rank. (KRI-15)
- **Drag rules:** vertical reordering changes rank; dropping among Tasks of another Priority changes Priority. The only moves between columns are Backlog → Intake (Start) and Queued → Backlog (un-start). While dragging, the picked-up card leaves a dashed placeholder, the valid column is outlined blue with a drop slot (“Drop to Start · Joins the queue as Queued · 4th”), and other columns dim to 35% with “Can’t drop here”. (KRI-15, KRI-62)
- **Header:** Factory name and View, **Filter**, **Plan**, **New Task**, and “4 of 4 working” when the Factory’s cap is full. Order down the middle pane: app-wide banners, page header, Factory banners. (KRI-56, KRI-62)
- **Filter:** the List’s filters except Stage and Archived. No grouping. (KRI-56)

### 10.9 List

Figma: KRI-62 Board and List.

- **Scope:** one Factory, or All Tasks. All Tasks adds a Factory column and has no Plan button. (KRI-56, KRI-62)
- **Columns** by default: Priority, ID, Title, Stage, Status (chip plus markers; “—” when empty), Updated. Optional through **Display**: Factory (on in All Tasks), Blocked by, Created, Created by, Tokens. Title can’t be hidden. (KRI-56, KRI-62)
- **Sort:** Manual (Priority, then rank: the queue order; default), Priority, Updated, Created, Stage, Title. **Group:** Stage (default for one Factory; the Done group starts collapsed), Factory (default for All Tasks), Status, Priority, None. (KRI-56, KRI-62)
- **Filters:** Factory (All Tasks only), Stage, Status (each status plus “No status”), Priority, Needs planning, Created by (you, an Automation, a planning chat, a split, a Follow-up), and **Archived**: Hidden (default), Included, Only. The Status filter matches every status a Task has right now, not only the one it shows; its **Blocked** option matches both the marker and the status. A text box (`/`) matches ID and title. Active filters show as chips. (KRI-56, KRI-62, KRI-8 coordinator decision 15)
- **Reordering** with sort Manual: drag rows with the Board’s rules, including Start and un-start between Backlog and Queued groups. With Status = Queued, Sort = Manual and Group = None, a **Queue** column (1st, 2nd …) and drag grips appear. This is how Queued Tasks of different Factories are ordered against each other. (KRI-56, KRI-62)
- **Multi-select** (⇧-click, ⌘-click, ⇧↓): Start, set Priority, Archive. (KRI-56)
- The List remembers filters, grouping, sort and columns per scope on this machine. Saved views are later (KRI-68). (KRI-56)
- **Archived rows** have a grey title, an “Archived” chip, and how the Task ended in Status (“Never started”, “Pull request closed on GitHub”, “Merged 2 Oct”). (KRI-62)

### 10.10 Search (⌘K)

- One box for search and commands over every Factory on this machine, current Factory first. (KRI-56)
- **Covers:** Task ID, title, description (all versions, including Original request), current brief; Comment text from humans, agents and TED; planning chat titles; Automation names; Factory names; commands. Includes Done and archived Tasks, labelled, ranked below open ones. Doesn’t cover Run Conversations (KRI-69), App logs, diffs or file contents (KRI-35). (KRI-56)
- **Results** grouped: Commands, Tasks, Comments, Plans, Automations, Factories. An exact ID (“NB-41”) puts that Task first. (KRI-56)
- **Commands:** New Task, Go to Inbox, Go to All Tasks, Open a Factory, Plan, New Automation, Settings, Add Factory, and the open Task’s actions (Start, Resume, Stop, Archive, Delete, Follow up, Set Priority, Set Clarify depth). (KRI-56)
- **No results:** “No results for ‘…’” and **Create Task “…”**. (KRI-56)
- ⌘F finds text inside the current pane. (KRI-56)

### 10.11 Keyboard shortcuts

Fixed; rebinding is later (KRI-35). KRI-56’s map wins over shortcuts the prototypes invented. (KRI-56, KRI-8 coordinator decision 25)

- **Global:** ⌘K search and commands; ⌘N or `C` New Task; `G` `I` Inbox, `G` `A` All Tasks, `G` `B` Board, `G` `L` List, `G` `P` Plans; ⌘1–⌘9 Factory 1–9; ⌘[ / ⌘] back and forward; Esc closes an open Task back to where it came from, and leaves Settings; ⌘, Settings; `?` or ⌘/ shortcut sheet; ⌘Q quit.
- **Moving:** `J`/`K` or ↓/↑ next and previous; on the Board `H`/`L` or ←/→ change column; Enter opens.
- **Answering:** `R` reply; `A` Approve; ⇧`R` Request changes; ↵ sends from a comment box or chat and ⇧↵ adds a new line; ⌘↵ also sends, interrupts and sends in a working Run’s chat, and presses the primary button of any dialog. `A` takes two keystrokes: the key highlights the button with “↵ to confirm”, Enter sends, Esc cancels.
- **Task actions:** `S` Start, Resume or Retry; `P` Priority menu; `B` Blocked by; `E` Edit title and description; ⌥↑/⌥↓ move in rank (Manual only); ⌘⌫ Archive; ⌃` open the Task’s shell. Stop and Delete have no shortcut.
- **Filter:** `/` focuses the Board or List filter box.
- Plain number keys stay free for answering choices later (KRI-46).

### 10.12 Empty states

Each names the next action; no illustrations. (KRI-56, KRI-57, KRI-62, KRI-66)

- **No Factories:** “No Factories yet”, “A Factory carries Tasks from request to merge for one product”, **Add Factory**. The sidebar shows Inbox, All Tasks, an empty Factories section with + Add Factory, Settings ⌘, and “Nothing running”.
- **Empty Inbox:** “Nothing waiting on you” and **Show answered**; **New Task** instead if no Factory has any Task. Filtered to one Factory: “Nothing waiting in Notebook” and **Show all Factories**.
- **Board with no Tasks:** the columns stay drawn, with “No Tasks yet”, **New Task** and **Plan** in the middle.
- **List or All Tasks with no Tasks:** “No Tasks yet”, **New Task**, **Plan** (Factory only).
- **Filters with no matches:** “No Tasks match these filters”, **Clear filters**. Archived Only with none: “No archived Tasks”.
- **Plans:** “No planning chats yet. Plan a piece of work too big for one Task. You and an agent talk it through, then it proposes Tasks for you to approve.” and **Plan**.
- **Automations:** “No Automations yet”, one line on what an Automation is, and four cards: the three templates and Blank, each with **Use template** or **Start blank**.
- **Search:** Create Task “…”. **Working Runs popover:** “No Runs working. Nothing queued.”

---

## 11. First launch and Settings

Figma: KRI-64 First launch and Settings.

### 11.1 First launch

- A full-window **Set up TED** screen with no sidebar, shown once per machine, even when every row is already green. Subtitle: “TED runs Claude Code and Codex with your own logins. It never sees your passwords or tokens.” (KRI-57)
- Four rows, each with a status chip, the version and account line, the binary path, and one action: (KRI-57, KRI-64)
  1. **Claude Code:** Ready (“2.1.319 · Claude Max · subscription”); Not installed (install command, **Copy**, **Open Terminal**); Signed out (**Sign in**, then “Opened claude auth login in Terminal. Checking again every 5 seconds…” with **Copy command**); Too old (**Update**); Signed in with an API key (amber: **Use API-key billing** or **Sign in with a subscription instead**).
  2. **Codex:** the same states.
  3. **GitHub:** Ready (“Signed in as forjoyilive · github.com”); GitHub CLI not installed (`brew install gh`, or the apt or dnf command); Signed out (**Sign in**); Missing `workflow` scope (amber, **Add permission**). While not ready, the row says “Needed to add a Factory”. First launch checks only `github.com`.
  4. **Git:** Ready (“2.47 · Nabha Cosley <email>”); Not installed (`xcode-select --install` on macOS, the package command on Linux); No name or email set (amber, with the two `git config --global` commands to copy).
- **Continue** is enabled when Git (including name and email) and at least one agent are ready. A grey line explains: “Continue needs Git and at least one agent ready. Skip for now lets you in; Runs stay Paused until an agent is ready.” GitHub isn’t required here. **Skip for now** is always there. (KRI-57, KRI-64)
- An agent signed in with an API key doesn’t block Continue. If the user continues without choosing, billing stays on Subscription and that kind’s first Run pauses with “Using an API key, not your subscription”. (KRI-64)
- Below the rows: **Start TED in the background when you log in**, checked. (KRI-57)
- **Continue** opens the Add Factory form with **Show the tutorial** on. Closing it leads to the No Factories state (10.12). (KRI-57)
- First launch doesn’t ask for the Linear key, notification permission, the editor, the `ted` command, or `lead`, `reviewer` and `planner` (TED’s defaults choose from the installed agents). (KRI-57)
- After first launch, the same rows live in Settings → Agents and Settings → Integrations. (KRI-57)

### 11.2 Machine settings and Workflow settings

- **Machine settings** are about this computer: limits, Stay Awake, login, editor, appearance, notifications, billing per agent kind, credentials, storage. Global, stored in `~/.ted/`, never synced, never committed. No Factory overrides them. (KRI-57)
- **Workflow settings** follow the three layers: TED defaults → Library (Settings → Library and Agents, written straight to `~/.ted/library/`) → Factory (Factory settings, saved as a pull request). (KRI-57)

### 11.3 App Settings

- Opens from **Settings ⌘,** and replaces the whole window, sidebar included. Its own sidebar has **← Back** (Esc) with the Inbox count beside it, the eight sections, then **Factories**; each Factory row (↗) leaves Settings and opens that Factory’s settings page. Content is one 720-wide column. App-wide banners stay above it. (KRI-57, KRI-64, KRI-8 coordinator decision 21)
- **Section dots** are red, and only for stops-work problems. (KRI-57, KRI-64)

1. **General** (KRI-57, KRI-64, KRI-59, KRI-8 consistency pass)
   - **Appearance:** System (default), Light, Dark. **Text size** (80%–200%, 5% steps, default 100%, with a Default action). **Terminal font size** (10–20, independent of Text size). **Profile picture:** avatar, **Change…**, **Remove**; initials if none.
   - **Date and time:** **Time format:** System (default), 12-hour, 24-hour. **Time zone:** System (default, follows changes on this computer) or a fixed named zone. A current-time row shows the effective zone and format. These preferences apply to TED’s timestamps and calendar dates, human-readable schedules and Automation time entry. Existing Automations adopt the app-wide zone and keep their scheduled clock times. Zone changes recalculate future firings without making up slots merely because the zone changed; queued and working Runs keep going. (KRI-222)
   - **Overnight mode across all Factories:** off by default, on this computer only. Turn it on or off in General; while it is on, the sidebar’s footer says “Overnight mode is on”. While on, TED automatically starts eligible Backlog Tasks across every Factory, including those with automatic starting off, after queued work and within the existing working Run limits. Gates set in the Workflow (TED’s defaults, the Library, the Factory) or on one Task count as off, the Merge Gate included, so a Task moves through its Stages and merges without sign-off; the saved Workflow and the Task’s own Gate choices don’t change, and Task details, Factory settings, the Library and the Board show which Gates are off for now. Each Gate skipped this way is a line in the Task’s thread. Gates TED forces stay on: a setup Task’s Design and Review Gates, and the Clarify sign-off at grilling depth. Any Task whose changes in the Factory’s primary repo touch `.ted/` keeps its Gates as saved and has its Review Gate on while the mode is on, so the human signs off before Workflow, Check or permission changes merge; if TED can’t read the Task’s changes it treats the Task the same way. The thread says why the Gate stayed on. A Gate request already open when the mode turns on stays open. Task Leads record reversible decisions in the Task brief and leave genuine blocking questions in the Inbox before ending their turn; questions and permissions still require the human. A Gate is decided when the Task Lead finishes the Stage, so turning the mode off brings Gates back from then on; a Task that TED started merging while it was on keeps merging. Idle and waiting Runs keep their conversations and free their working slots. The mode persists until turned off, including across restarts; there is no schedule or automatic end time. Turning it off leaves already started/queued work running and preserves each Factory’s own automatic starting setting. (KRI-271, ADR 0100)
   - **Startup and quitting:** **Start TED in the background when you log in** (on); Linux only, **Show tray icon** (on); **When you quit with work running** (3.1); **Stay Awake while Runs are working** (on).
   - **Editor** (9.8). **Command line:** **Install the `ted` command**. On macOS a symlink at `/usr/local/bin/ted` into the app bundle, asking for the admin password only if that folder isn’t writable. For AppImage a small `~/.local/bin/ted` script, rewritten after each update; if `~/.local/bin` isn’t on the login shell’s `PATH`, the row shows the line to add. deb and rpm show “Installed by your package”.
   - **About and updates:** version, “Update ready: TED 1.4.0. Restarting doesn’t stop Runs.”, **Check for updates**, **Restart to update**, Third-party licenses (including TED’s agent-orchestrator attribution).
2. **Notifications:** the switches in 3.8. When the OS has notifications off for TED, a red row at the top with **Open System Settings**. (KRI-59, KRI-64)
3. **Agents:** one card per agent kind with Health (chip, version against the minimum, path, account and plan, **Check again**, and **Copy command** / **Sign in** / **Update** when needed), **Billing** (Subscription / API key, naming the variables TED removes), and **Plan usage** bars (7.7). A card with a stops-work problem gets a red border and a chip such as “Signed out · 3 Runs paused”. Below the cards: **Restart idle Runs onto new agent versions** (on), and **Defaults for all Factories**: Task Lead (`lead`), Reviewer (`reviewer`), Planner (`planner`), each with agent, model, effort, a Default or Library tag, and **Reset to TED default**. (KRI-54, KRI-57, KRI-64, KRI-53)
4. **Limits:** **Max working Runs on this machine** (6), **Start fewer Runs when this computer is busy** (off), **Simulators booted at once** (3), **Checks running at once** (2, from 1 to 16; a Task’s Checks count as one, the rest wait in line and the Task reads “Waiting to run Checks · 2nd”; ADR 0103) and **Run agents and Checks at low priority** (on: agents, Checks, worktree setup and teardown, and Apps an agent starts run at the system’s utility priority on macOS and at niceness 10 on Linux; work already running keeps its priority; ADR 0102), with a live line “Now: 4 of 6 Runs working · 2 queued · 1 of 3 simulators booted”. (KRI-57, KRI-64)
5. **Integrations:** (KRI-57, KRI-64)
   - **GitHub** (through the GitHub CLI): one row per host the Factories use, with login, token source (keyring, config file, or `GH_TOKEN`), git protocol, scopes, `gh` version and path, **Fix** and **Check again**. TED checks `gh auth status --json hosts` (state `success`) at start, every 10 minutes and on any auth error; the minimum `gh` version is 2.81.0 (14). With the HTTPS protocol and no `workflow` scope, an amber row “Can’t push changes to GitHub Actions workflows” with **Add permission**; it blocks nothing else.
   - **Git:** version, name and email.
   - **Linear:** masked key (last 4), where it is stored, “Connected as Nabha · Kriya Design” (checked on Save by asking Linear who the key belongs to), **Test**, **Remove**, **Create a key ↗**.
6. **Library:** the effective Workflow table (Stage, On, Gate, Send-backs, Clarify depth, a Default or Library tag, **Override in Library** / **Reset to default**; Backlog and Done shown as holding), then Stage files. Each Stage has **Edit in Library**, which copies TED’s default to `~/.ted/library/stages/<id>.md` and opens a Markdown editor with preview and **Compare with default**; **Reset to default** deletes the copy. Edits collect until **Save**, which writes straight to `~/.ted/library/`, under the line “Applies to every Factory that doesn’t override it, from each Task’s next Stage.” Drift for Library copies is in 5.5. Not shown here: `permissions`, Checks, Apps, repos (Factory only), and the agent settings (under Agents, with a link). (KRI-57, KRI-58, KRI-64)
7. **Storage:** “62.4 GB used under ~/.ted/ · 8.2 GB free on Macintosh HD”; space by category (worktrees, clones, simulators, store, Conversations and logs, attachments, backups, Scratch worktrees); the 10 largest worktrees with **Open Task**; **Remove clones of removed Factories**; **Erase simulators not used by a running Task**; Export a Factory with Factory and format choices and a native save dialog; Backups with date, size, **Show in folder** and the `ted backup restore` hint. (KRI-59, KRI-64, KRI-71, KRI-8 coordinator decision 13)
8. **Developer:** **Developer mode** (shows Diagnostics and the log viewer here), **Show TED’s folder** (`~/.ted/`), **Copy report**. (KRI-57, KRI-64)

### 11.4 Developer mode

- A toggle, with no preview-feature flags. It shows, in Settings → Developer: **Diagnostics** (CPU and memory per Run, process table, memory pressure, token use per Run, **Copy report**) and a viewer for the daemon’s event log and each Run’s raw output. (KRI-20, KRI-17, KRI-57)
- No Sentry crash reporting and no telemetry. (KRI-20, KRI-59)

---

## 12. Automations

Figma: KRI-66 Automations and Plans.

### 12.1 What an Automation is

- A schedule in a Factory that starts a Run each time it fires, outside any Task, usually to bring new work in as Tasks. Time triggers only; event triggers are later (KRI-25). (glossary, KRI-20)
- Stored in TED’s store, per machine, never committed. Sharing through the repo is later (KRI-70). An Automation belongs to one Factory and is deleted with it. (KRI-60)
- Trade-off accepted: each firing costs tokens, an agent is less reliable than a connector, and nothing syncs Linear status back. In return, any source with an MCP server or CLI works, and filters are prompts. Automations that read Linear use the agent’s own MCP or CLI login, not TED’s Linear key. (KRI-20, KRI-57)
- Templates: “Pull new Linear issues assigned to me”, “Turn new Sentry issues into Tasks”, “Daily GitHub issue triage”. (KRI-20)

### 12.2 Automations page and view

- **Page** (the Factory’s Automations entry): header “Notebook / Automations 7” with **New Automation**. Columns: on/off toggle; name with the schedule in words under it (clock-time schedules always show the zone: “Weekdays at 09:00 · Europe/London”); Next firing (“in 3h”, or “Off”); Last result, which is the last finished Run (“Created NB-51, NB-52 · 2h ago”, “No new Tasks”, “Failed · 5h ago” with **Retry**, “Skipped”); Now, the open Run’s state (Working, Waiting on you, Queued · 1st, Paused · reason); Agent · model. An Automation that is off is dimmed. (KRI-60, KRI-66)
- A failed last result puts a red dot on the Factory’s Automations sidebar entry, not on the Factory row. Three failures in a row raise the Factory banner. No notification of its own. (KRI-60, KRI-66, KRI-59)
- **Automation view:** header “← Automations”, toggle, name, **Run now**, **Edit**, ⋯ (Open Automation, Edit, Run now, Turn on/off, Duplicate, Delete; also available by right-clicking the Automation row or header), and one line with schedule · next firing · agent · model · effort. **History** columns: Started, Trigger (Scheduled; Made up, with “for Wed 5 Nov 09:00” under it; Run now; Retry, with “of 09:00”), Duration, Result (Tasks created, linked; “No new Tasks”; “Failed: <last error line>”; “Skipped: previous Run still working”; “Stopped by you”), each with the first line of the Run’s final message under it. **Retry** shows only on the newest failed row that hasn’t been retried; the retried row reads “Retried at 09:21”. Right pane: schedule, the next three firings, agent with billing kind, the prompt (collapsed), totals, created. Clicking a history row opens that Run’s view with “← Automation”. (KRI-60, KRI-66)
- **Duplicate** creates the copy turned off. **Delete** asks to confirm; history goes with it; Tasks it created stay. (KRI-60, KRI-8 coordinator decision 8)

### 12.3 Automation form and commands

- A dialog: “New Automation in Notebook”, or “Edit Automation” without Template. (KRI-60, KRI-66)
  - **Template** (create only): Blank and the three templates as radio cards with their default schedules; picking one fills name, prompt and schedule.
  - **Name** (required). **Prompt** (required, Markdown, monospace), with “Whether new Tasks start is up to the prompt (--start).”
  - **Schedule:** Every N minutes or hours, Daily at, Weekdays at, Weekly on (day chips) at, or Custom (a 5-field cron or an RRULE, repeated in words). The next three firings show under it. Shortest interval 15 minutes. Errors show inline (“The shortest interval is 15 minutes.”; “Not a valid cron or RRULE: …”).
  - **Time zone:** read-only app-wide zone from Settings → General. The schedule uses the app-wide 12-hour or 24-hour format, with AM/PM when needed; canonical clock values remain `HH:mm`. (KRI-222)
  - **Agent · model · effort**, filled from `lead`.
  - **On:** checked, “Fires on schedule once saved”.
  - **Cancel**, **Save and run now**, **Save ⌘↵**.
- **`ted automation`:** `list`, `show <id>`, `history <id>`, `create --name <n> --schedule "<cron|RRULE>" --prompt-file <file> [--template <name>] [--agent] [--model] [--effort] [--off]`, `edit <id>` (same flags), `enable <id>`, `disable <id>`, `run <id>`, `delete <id>`. Every subcommand takes `--factory`, defaulting to the current Run’s Factory. Inside a Run only `list`, `show` and `history` work; the rest are refused with “Ask the human to change Automations”. (KRI-60)

### 12.4 Firing, overlap and duplicates

- Each firing starts one Run with the stored prompt, agent, model and effort. A full limit makes it wait as Queued, after Planning Runs and before Tasks (6.5). A Paused agent pauses it like any Run. (KRI-20, KRI-60)
- **Overlap:** a firing is skipped only while the previous Run is Working, Queued or Paused, and logged as “Skipped”. While the previous Run is **Waiting on you**, the new firing starts its own Run, and the open question stays in the Inbox. Skipped firings aren’t made up. (KRI-60 change from Nabha’s review)
- **Missed firings** (TED not running) are made up once on start, however many slots were missed, shown as “Made up”. (KRI-59, KRI-60, KRI-66)
- **No duplicate Tasks.** Every Task an Automation creates takes the URL of the item it came from (Sentry issue, Linear issue, GitHub issue) as its source. What `ted task create --source <url>` does depends on the Task in the Factory that already has that source (deleted Tasks don’t count): (KRI-60, KRI-55, Nabha’s review)
  - **Open:** refuses and returns it: “Already tracked as NB-51”, with its Stage.
  - **Archived without merging:** refuses. The human dropped it on purpose.
  - **Done:** refuses, and returns the merge facts: “NB-51 is Done: merged 3 Nov, commit abc123. Use --follow-up NB-51 if it isn’t fixed.”
  - `--follow-up NB-51` creates a Follow-up Task (9.10) that links to NB-51, shares its source, and starts with NB-51’s brief and pull requests as context. Because it shares the source, only one can be open at a time.
- **Whether a fix held is the Automation agent’s judgement, not TED’s.** TED never reads Sentry; it hands over the merge commit and date. The Sentry template’s prompt tells the agent:
  - Create a Follow-up only when the issue has events from a release that contains the merge commit, or when Sentry marks it regressed. Events from older releases are old builds still in use, not a failed fix. This matters most for mobile apps, where a fix can take weeks to reach users.
  - Fall back to “events after the merge date” only for projects that don’t report releases, such as a web app deployed on every merge.
  - Pull requests for Sentry-sourced Tasks carry `Fixes <SENTRY-SHORT-ID>` in the body, so Sentry resolves the issue in the release that ships the fix and flags it as regressed if events come back from that release or a later one.
- At start, TED gives the Run the Tasks this Automation has created, with their sources and states. A firing that adds nothing new shows “No new Tasks”.
- Created Tasks land in Backlog unless the prompt passes `--start`; each gets its own Task Lead. (KRI-15, KRI-20)
- **Turning an Automation off** while its Run is open lets that Run finish; nothing more fires. (KRI-8 coordinator decision 8)
- **Failure:** the usual resume, then Failed in history with Retry. No further automatic retry; the next firing goes ahead as scheduled. (KRI-60)

### 12.5 Automation Runs

- **Lifetime:** the Run stays open while it works or waits on a Comment. When it goes idle with nothing open, it is finished: TED stops it and keeps it as history; its final message is the first line of the history row. The idle nudge is only for Task Leads. (KRI-60)
- **Replies:** the human’s answer goes into the Run’s live input. Its Comments show in the Inbox under the Automation’s name. (KRI-60, KRI-20)
- **Run view:** header “← Sentry crash intake”, “Sentry crash intake · Run of 12:20”, its status pill and **Stop**, and one line with trigger · start · agent · model · effort. The chat shows TED’s instructions collapsed, tool calls collapsed with their result on the right (“NB-51”), messages authored by the Automation’s name. A Comment from the Run shows as a one-line card in the chat and as the full card pinned at the bottom, with a “Message this Run…” box under it. Right pane: Tasks created (with Stage and status), the Run (agent, full model name, effort, billing, tokens, trigger), and the Automation. (KRI-60, KRI-66)

---

## 13. Plans (Planning Runs)

Figma: KRI-66 Automations and Plans.

### 13.1 What a Planning Run is

- A Run in a Factory, not on any Task, where the human and an agent work out a piece of work too big for one Task. The UI calls it a **planning chat**. It ends by proposing Tasks, with which block which, for the human to approve. (glossary, KRI-19)
- Started from **Plan** (the Factory header, the Plans list, the Factory row menu, the palette) or **Plan in chat** on a too-big Task in Clarify. (KRI-19, KRI-56, KRI-58)
- Agent, model and effort come from `planner`, changeable in the header until the first message is sent. (KRI-53, KRI-60)
- The agent can read the repos, start research sub-agents, and ask questions in the round format. (KRI-19)
- An active Planning Run counts as one working Run; waiting on the human, it uses no slot and stays open with no time limit. When the limit is full, the first message is kept and the chat shows “Queued · 2nd”. (KRI-19, KRI-60)

### 13.2 Checkout

- At start, each of the Factory’s repos gets its own detached worktree at the freshly fetched `base_branch`, under `~/.ted/`. In a multi-repo Factory the chat runs in a folder with one subfolder per repo, named after `name`. Planning worktrees get the `copy` files and `env` but don’t run `setup`. Anything the agent writes is never pushed and is thrown away when the Run ends; the worktrees count toward the disk rules. The user’s clone is never touched. (KRI-60, KRI-58)
- Plan is disabled while a new Factory is still cloning. (KRI-65)

### 13.3 How one ends

- **Create N Tasks** on the proposal: TED creates the Tasks, posts “Created 4 Tasks”, and stops the Run. Status: Finished. (KRI-60)
- **Request changes:** the text goes into the Run, shown in the chat labelled “Request changes”. The agent posts a new proposal and the old one is marked “Superseded”. (KRI-60, KRI-66)
- **Stop**, at any time: Stopped, and no Tasks are created. (KRI-60)
- A Finished or Stopped chat is read-only history, with a bar “This planning chat is finished. It stays as history.” and **Plan more from here**, which starts a new Planning Run that gets the old one’s rounds, answers, proposal and created Tasks. (KRI-60, KRI-66)
- **Failed:** the usual resume, then Failed with **Retry** in the Plans list and a red dot on the Plans sidebar entry. (KRI-54, KRI-66)

### 13.4 Proposal

- Posted with `ted task propose --file <file>` as a `proposal` Comment: title, one-line scope, Priority and blocked-by (by row number) per Task. Split it uses the same card. (KRI-60, KRI-55)
- The card: a one-line title; numbered rows, each with a checkbox (all checked), title, scope, Priority and “blocked by 2”; **Start the unblocked ones** (off by default) with which rows that would start; a comment box; **Request changes** · **Create N Tasks**. (KRI-60, KRI-66)
- **Started from a Task:** row 1 reads “NB-41 (this Task) becomes the first piece: Local note cache”, locked on. (KRI-60, KRI-66)
- **Unchecking a row others are blocked by:** each dependent row warns “⚠ Blocked by row 3, which won’t be created. This Task will have no blocker.” and strikes through its “blocked by 3”. The Task is created with no blocker; it doesn’t take on row 3’s blockers. The button count drops. (KRI-66)
- Created Tasks land in Backlog and link back to the planning chat. Blocked ones start when their blockers merge; unblocked ones start only if **Start the unblocked ones** was ticked. (KRI-19, KRI-60)
- **Approved** card: green, “approved by you at 14:06”, with Task IDs on each row and blockers named by ID, followed by event lines (“TED created 4 Tasks in Backlog: NB-54, …. NB-41 narrowed to Local note cache.”, “TED told NB-41’s Task Lead; it carries on with Clarify.”, “Planning Run finished”). (KRI-66)

### 13.5 Plans list and planning chat

- **Plans list** (the Factory’s Plans entry), header with **Plan**. Columns: Title (with “from NB-41” when started from a Task), Status, Started, Tasks (“5 proposed”, “Created 2 Tasks”, “No Tasks”, “—”), Agent, ⋯. Status is a pill plus a detail: Waiting on you (“Round 2 · 3 questions”, “Proposal · 5 Tasks”), Working (the activity line), Idle (“Your turn to write”), Queued · 2nd, Paused · reason, Failed (with **Retry**), Finished, Stopped. Groups: **Open**, then **Past** (Finished, Stopped), collapsed, with a count. No filter in v1; ⌘K finds plans. (KRI-60, KRI-66, KRI-8 coordinator decision 10)
- **Planning chat** in the middle pane: the Run’s live chat, not a Task-thread layout. Header: “← Plans”, the title (click to rename) with its status pill, Run icons (the planner, then research sub-agents smaller and grey), agent · model · effort, **Stop** and ⋯ (Rename, Delete), and a line “Planning chat · started by you Mon 10 Nov 10:05” or “started from NB-41 …”. (KRI-60, KRI-66)
- Answered rounds and superseded proposals collapse to one-line grey cards. The open round or proposal shows as a one-line amber card in the chat (“pinned below”) and as the full card pinned between the chat and the message box. Typing in the chat while a round is open is talking it through; planning chats have no Talk it through button. A round card shows each question’s choices as chips, the recommended one pre-selected and tagged, with an “Or your own answer…” field, “Typing below talks it through with the planner.”, and **Submit answers**. (KRI-60, KRI-66, KRI-270)
- **Right pane:** Started from (the Task with Stage and status, or “Plan, by you”); Proposed Tasks (latest proposal), becoming Created Tasks after approval; Runs; tokens. (KRI-60, KRI-66)
- **New chat:** greyed title placeholder “New planning chat”; agent, model and effort as three selects in the header; two lines on what the planner does; input focused with “What do you want to plan?”. (KRI-60, KRI-66)
- **Name:** the first line of the human’s first message (cut at 60 characters), or “Plan: <Task title>” from a Task. The human renames it; agents don’t. (KRI-60)
- **Delete** (⋯) asks to confirm, stops the Run if active, and removes the chat and its Conversation. Tasks it created stay, linked as “From a deleted planning chat”. (KRI-60)
- **Inbox rows:** “Plan · Round 1 · 5 questions”, “Plan · Proposal · 5 Tasks”, under the chat’s title. (KRI-60)

### 13.6 Plan in chat from a Task

- The Task stays in Clarify, and its Task Lead Run waits, idle. The thread gets a link line, “Planning in chat: <title>”. (KRI-60)
- On approval, the Task becomes the first piece (narrowed title and description), and TED tells its Task Lead, which carries on with Clarify. (KRI-60)
- If the chat is stopped without approval, the Task Lead is told and asks its size question again. (KRI-60)
- If the Task is archived or deleted mid-plan, the chat carries on as a standalone plan: the “this Task becomes the first piece” row becomes an ordinary, unlocked row, and the chat gets a note saying why. (KRI-8 coordinator decision 9)

---

## 14. Release work

Build tasks with no product decision left open, or with the decision recorded here.

- **Start at login:** a LaunchAgent through `SMAppService` on macOS; an XDG autostart entry on Linux (3.2). (KRI-57)
- **macOS code signing and notarization.** Signing is required for auto-update on macOS, and keeps the Keychain from prompting the daemon. (KRI-59, KRI-57)
- **Packaging** (KRI-122, ADR 0032): electron-builder from a staged JavaScript copy, no asar. `pnpm package` builds locally; `.github/workflows/release.yml` builds the macOS dmg and zip (x64 and arm64) and the Linux AppImage, deb and rpm (x64 and arm64) on `v*` tags or by hand and uploads them as workflow artifacts. App ID `design.kriya.ted`; Linux executable `ted-app`. The macOS build is signed and notarized when these repository secrets exist, and unsigned otherwise: `MAC_CERTIFICATE_P12_BASE64` and `MAC_CERTIFICATE_PASSWORD` (a Developer ID Application certificate), and `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (an App Store Connect API key for notarization). The release repository and the Download URL both come from `releaseRepo` (`forjoyilive/ted`).
- **The `ted` command** (KRI-122): every package has `resources/bin/ted`. macOS links `/usr/local/bin/ted` to it; deb and rpm link `/usr/bin/ted` to it after install and remove the link on uninstall; an AppImage writes `~/.local/bin/ted`, which the daemon rewrites at each start. `ted open` starts the installed app when it isn’t open.
- **Linux packages:** AppImage, deb and rpm, for x64 and arm64. All three update through TED’s own updater (electron-updater). AppImage replaces itself with no password; deb and rpm install with `dpkg`/`rpm` and the restart chip reads “Restart to update (asks for your password)”. Hosted apt and dnf repositories are later (KRI-74). (KRI-59, KRI-64)
- Bundled fonts: Geist Variable and Geist Mono Variable, built into the window by Vite from `@fontsource-variable`. (KRI-14)
- Preserve applicable upstream notices for adapted agent-orchestrator code and mark changed files. (ADR 0003) `packages/app/third-party/agent-orchestrator/` holds an explicitly TED-authored attribution and the complete upstream Apache-2.0 license; these appear in **Third-party licenses**, which lists every shipped package with its license text. (KRI-122, KRI-167)
- **Minimum supported versions:** `claude` 2.1.111 (`--permission-mode auto` without the hidden `--enable-auto-mode` flag), `codex` 0.128.0 (`codex update`), `gh` 2.81.0 (`gh auth status --json`). Below these, the agent pauses with “Too old” and the GitHub row shows as needing an update. Sources in `docs/research/kri-81-min-versions.md`. (KRI-54, KRI-57, KRI-81)
- Before shipping to other people: KRI-44 (OpenAI terms), the Anthropic “third-party harness” recheck and the Codex app-server line (7.11). (ADR 0004)

---

## 15. Out of scope for v1

From the map (KRI-8) and every issue labelled `later`:

- Multiplayer: [KRI-36](https://linear.app/kriyadesign/issue/KRI-36)
- Phone access to the Inbox: [KRI-38](https://linear.app/kriyadesign/issue/KRI-38)
- Windows: [KRI-39](https://linear.app/kriyadesign/issue/KRI-39)
- Several machines: [KRI-40](https://linear.app/kriyadesign/issue/KRI-40)
- More agents than Claude Code and Codex: [KRI-41](https://linear.app/kriyadesign/issue/KRI-41)
- Wayfinder inside TED: [KRI-48](https://linear.app/kriyadesign/issue/KRI-48)
- Library sharing and versioning: [KRI-49](https://linear.app/kriyadesign/issue/KRI-49)
- Custom Stages beyond the built-in set: [KRI-50](https://linear.app/kriyadesign/issue/KRI-50)
- Text-size setting: [KRI-51](https://linear.app/kriyadesign/issue/KRI-51)
- Switching a Run between chat and the agent’s TUI: [KRI-24](https://linear.app/kriyadesign/issue/KRI-24)
- Event triggers for Automations: [KRI-25](https://linear.app/kriyadesign/issue/KRI-25)
- Built-in Linear connector with two-way sync: [KRI-26](https://linear.app/kriyadesign/issue/KRI-26)
- Auto-delete archived Tasks: [KRI-27](https://linear.app/kriyadesign/issue/KRI-27)
- Several subscription accounts per agent: [KRI-28](https://linear.app/kriyadesign/issue/KRI-28)
- Side chats for other Run types, multiple side chats per Run and a CLI entry point (the Task Lead Run version is in 7.3): [KRI-29](https://linear.app/kriyadesign/issue/KRI-29)
- Cues: [KRI-30](https://linear.app/kriyadesign/issue/KRI-30)
- GitLab: [KRI-31](https://linear.app/kriyadesign/issue/KRI-31)
- Terminal split panes: [KRI-32](https://linear.app/kriyadesign/issue/KRI-32)
- File tree and quick open: [KRI-33](https://linear.app/kriyadesign/issue/KRI-33)
- Persistent browser profiles, DevTools, tabs and general web browsing (the local Task browser is implemented): [KRI-34](https://linear.app/kriyadesign/issue/KRI-34)
- Rebinding shortcuts and searching file contents: [KRI-35](https://linear.app/kriyadesign/issue/KRI-35)
- S3-compatible attachment storage: [KRI-37](https://linear.app/kriyadesign/issue/KRI-37)
- Revisiting the one-long-Run design: [KRI-43](https://linear.app/kriyadesign/issue/KRI-43)
- Reading OpenAI’s Terms of Use by hand: [KRI-44](https://linear.app/kriyadesign/issue/KRI-44)
- Watching for `--bare` becoming the default: [KRI-45](https://linear.app/kriyadesign/issue/KRI-45)
- Inbox ideas from the rejected layouts, including number keys for choices: [KRI-46](https://linear.app/kriyadesign/issue/KRI-46)
- Android emulator Apps: [KRI-47](https://linear.app/kriyadesign/issue/KRI-47)
- Saved List views: [KRI-68](https://linear.app/kriyadesign/issue/KRI-68)
- Searching Run Conversations: [KRI-69](https://linear.app/kriyadesign/issue/KRI-69)
- Sharing Automations through the repo: [KRI-70](https://linear.app/kriyadesign/issue/KRI-70)
- Posting line comments to GitHub as a review: [KRI-72](https://linear.app/kriyadesign/issue/KRI-72)
- Compacting the event log: [KRI-73](https://linear.app/kriyadesign/issue/KRI-73)
- apt and dnf repositories: [KRI-74](https://linear.app/kriyadesign/issue/KRI-74)
- Changing a Factory’s key or primary repo: [KRI-75](https://linear.app/kriyadesign/issue/KRI-75)
- Repos the user can only fork: [KRI-76](https://linear.app/kriyadesign/issue/KRI-76)
- Linear keys for several workspaces: [KRI-77](https://linear.app/kriyadesign/issue/KRI-77)
- Choosing the terminal app for sign-in: [KRI-78](https://linear.app/kriyadesign/issue/KRI-78)

Also out of scope, with no issue: open-sourcing and licensing; an archived-Factory state; a “hold new work” toggle; “always allow” for permission requests; budgets and spend warnings; reply threads on line comments. (KRI-8, KRI-58, KRI-59, KRI-53, KRI-54, KRI-60)

Never (KRI-20): rolling back a session; workers outside a Factory; Sentry crash reporting and telemetry; translucency; the `html_preview` and computer-use MCP tools.
