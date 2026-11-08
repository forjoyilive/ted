# TED v1: open product decisions

Companion to `ted-v1-spec.md`. The first draft of the spec found 75 gaps (GAP-n), 2 proposals (P-n) and 6 contradictions between tickets (C-n). KRI-53 to KRI-66 settled almost all of them. This file lists what is still open first, then where each original item was settled.

Updated 2026-11-08.

## Settled after the spec rewrite (decided by Claude; pending Nabha’s review)

- **NEW-1** Which Tasks start when their last blocker merges: a Task starts on merge if it was created to start (`--start`, Start now checked) or had already been started. Otherwise it stays in Backlog. Blocked Split and planning pieces start on merge. Spec 6.5, 6.16.
- **NEW-2** Duplicate-source check: covers open, Done and archived Tasks in the Factory (KRI-55’s rule). This replaces the narrower wording in KRI-60’s review change. Spec 12.4.
- **NEW-4** Original request: a collapsed row at the end of the Task brief section, with a link to the description’s history. Spec 10.7.
- **GAP-63** Comments: the human attaches files by drag and drop or paste; a sent Comment can’t be edited or deleted (Nabha’s review). Spec 10.5.
- **Revisiting a Done Task’s source:** `--follow-up` creates a Follow-up Task; the Automation agent judges whether the fix held, by release for mobile apps (Nabha’s review). Spec 12.4.
- **Nudge event dots** are grey (KRI-61 follow-up), not blue.

---

## Still open

### NEW-3: Can a queued message in a Run chat be deleted? (S)
- **Status:** open until build.
- **Delete** on a Queued message works only if TED, not the CLI, holds queued messages until the agent’s next step. Check this at build time; if the CLI holds them, drop Delete and keep **Send now** (KRI-63, note from Nabha’s review).
- **Spec:** 10.6.

### NEW-5: Minimum supported versions (S)
- **Status:** open until build.
- The minimum versions of `claude`, `codex` and `gh` are set at build (KRI-54, KRI-57).
- **Spec:** 14.

### NEW-6: Before shipping to other people (S)
- **Status:** open, not needed for a solo v1.
- Recheck Anthropic’s “third-party harness” rule and the Codex app-server line on commercial use, and read OpenAI’s Terms of Use by hand (KRI-44, ADR 0004, KRI-54).
- **Spec:** 7.11, 14.

### Pending review
Most of the KRI-54 to KRI-66 resolutions, their follow-ups and the KRI-8 Figma consistency pass were decided by Claude on Nabha’s behalf and are marked “pending review” in Linear. The spec states them as decided. Items with a “Change from Nabha’s review” or “Note from Nabha’s review” reply have been reviewed.

---

## Resolved gaps

### 1. First run, settings and preferences
- **GAP-1** Model and effort per kind of Run. Resolved by KRI-53: `{agent, model, effort}` on `lead`, `reviewer`, `planner`; the Task Lead picks for sub-agents; unset means the CLI default. KRI-60 narrowed `planner` to Planning Runs.
- **GAP-2** First launch. Resolved by KRI-57 and KRI-64: a full-window Set up TED screen with Claude Code, Codex, GitHub and Git rows; Continue needs Git and one agent.
- **GAP-3** App Settings and the global/per-Factory split. Resolved by KRI-57 and KRI-64: eight sections; machine settings are global, Workflow settings follow the layers.
- **GAP-4** API-key billing and showing the credential. Resolved by KRI-54: Subscription or API key per agent kind in Settings → Agents; each Run row shows the credential it reported; a mismatch pauses.
- **GAP-5** Editor. Resolved by KRI-57: Settings → General → Editor, picked on first use.
- **GAP-6** Start at login. Resolved by KRI-57: on by default, offered on first launch, toggle in General; starts the app in the background.

### 2. Agents and Runs
- **GAP-7** Usage and rate limits. Resolved by KRI-54: Paused · reason for the whole agent kind until reset; CLIs retry 429s; banner, no Inbox item.
- **GAP-8** CLI missing, signed out or outdated. Resolved by KRI-54: Paused with the reason; health checks before each Run and every 10 minutes; Fix opens the user’s terminal.
- **GAP-9** `permissions`. Resolved by KRI-53: `auto` or `bypass`, Factory only, every Run.
- **GAP-10** Cost and plan usage. Resolved by KRI-54 and KRI-63: tokens everywhere, dollars for API-key Runs only, plan-usage bars in Settings and a footer chip at 85%.
- **GAP-11** Restart: resume or fresh Run. Resolved by KRI-53: resume and stay the same Run; a fresh Run only if the resume fails.
- **GAP-12** What makes a Run Failed. Resolved by KRI-54: exits without finishing or 30 minutes with no output; resume, then a fresh Run; a second failure within 30 minutes marks the Task Failed.
- **GAP-13** Changing a Task’s agent or model. Resolved by KRI-53: the Task Lead field.
- **GAP-14** Sub-agent cap. Resolved by KRI-53: none.
- **GAP-15** Touching the user’s agent config; the preamble. Resolved by KRI-53: per-Run flags only; preamble as a collapsed first row.

### 3. Architecture, daemon and storage
- **GAP-16** Daemon crash. Resolved by KRI-59: the app restarts it; Reconnecting bar; stops after 3 crashes in 10 minutes.
- **GAP-17** Automations and the daemon quitting. Resolved by KRI-59 and KRI-64: an enabled Automation counts as work running; missed firings made up once.
- **GAP-18** Disk use and a full disk. Resolved by KRI-59: Settings → Storage; warn under 10 GB, hold new work under 2 GB.
- **GAP-19** Migrations, backup, export. Resolved by KRI-59: versioned events, backups before schema changes and daily; no export (KRI-71).
- **GAP-20** Retention. Resolved by KRI-59.
- **GAP-21** Updates with Runs always active. Resolved by KRI-59: restarting never stops Runs.
- **GAP-22** Loopback auth. Resolved by KRI-59: a token in `~/.ted/daemon.json` (0600), plus per-Run tokens.

### 4. Factory and Workflow
- **GAP-23** Shape of `repos`. Resolved by KRI-58: a list holding every per-repo setting; optional for single-repo Factories.
- **GAP-24** Add Factory form; clone or user’s folder. Resolved by KRI-58, KRI-65 and ADR 0006: TED always clones; a folder becomes the repo’s local folder for copy files.
- **GAP-25** Worktree key names. Resolved by KRI-58: `worktree.setup`, `teardown`, `env`, `copy`.
- **GAP-26** Invalid `workflow.yaml`. Resolved by KRI-58 and KRI-65: last valid version, warning banner and amber notice.
- **GAP-27** Rename or remove a Factory or repo. Resolved by KRI-58, KRI-65 and coordinator decision 12.
- **GAP-28** Custom Stages. Resolved by KRI-58: built-in Stages only (KRI-50).
- **GAP-29** Editing Library Stage files. Resolved by KRI-58 §14 and KRI-64: Settings → Library.
- **GAP-30** Task IDs. Resolved by KRI-58: Factory key plus a counter, `NB-41`.
- **GAP-31** The drift merge Task. Resolved by KRI-58 §15.
- **GAP-32** Backlog and Done in `order`. Resolved by KRI-58 §11: neither is listed; Backlog can be turned off, Done can’t.
- **GAP-33** Default `max_back`. Resolved by KRI-58 §12: 3 everywhere except Validate’s 5.

### 5. Tasks and Stages
- **GAP-34** Status model. Resolved by KRI-55, its follow-up, KRI-61, KRI-62 and coordinator decision 24.
- **GAP-35** New Task dialog. Resolved by KRI-55 and KRI-63.
- **GAP-36** Editing a Task. Resolved by KRI-55.
- **GAP-37** Blockers. Resolved by KRI-55. (See NEW-1 for which blocked Tasks start on merge.)
- **GAP-38** Pause, stop, cancel. Resolved by KRI-55: Stop and Resume; Archive is the only exit.
- **GAP-39** Start now unchecked. Resolved by KRI-55: Backlog.
- **GAP-40** Unarchiving a Done Task. Resolved by KRI-55: back to Done, no Run.
- **GAP-41** Which repos a Task touches; when worktrees exist. Resolved by KRI-58 and its addendum: the Repos field; the primary worktree at start.
- **GAP-42** Branch names. Resolved by KRI-58.
- **GAP-43** Comments with no live Run. Resolved by KRI-55: stored for the next Run.
- **GAP-44** Setup Task and the limit. Resolved by KRI-55: front of the queue, waits for a slot.
- **GAP-45** Duplicate-source check and Done Tasks. Resolved by KRI-55 (includes Done). KRI-60’s later change reads narrower; see NEW-2.

### 6. Validation
- **GAP-46** How Checks run. Resolved by KRI-60, changed by Nabha’s review: in order, stop at the first failure, 10-minute default timeout.
- **GAP-47** Reviewer not available. Resolved by KRI-54: explicit pauses; unset picks one that can run.
- **GAP-48** Checks for unchanged repos. Resolved by KRI-60: skipped.

### 7. Review and Merge
- **GAP-49** GitHub auth. Resolved by KRI-57 and ADR 0007: `gh`’s login for everything; no token stored.
- **GAP-50** Line comments. Resolved by KRI-60, KRI-63 and coordinator decision 7: drafts sent with the next Comment, never with Approve.
- **GAP-51** Sign-off labels. Resolved by KRI-60.
- **GAP-52** No CI or CI that never reports. Resolved by KRI-60, changed by Nabha’s review: TED detects CI at push; no CI merges at once.
- **GAP-53** Merge Gate card. Resolved by KRI-60.
- **GAP-54** Task shell. Resolved by KRI-60 and KRI-63: Shell in the Code section, opens in the middle pane.

### 8. UI
- **GAP-55** Scope of Inbox, Board and List; the Factory page. Resolved by KRI-56.
- **GAP-56** Empty states. Resolved by KRI-56, KRI-62 and KRI-66.
- **GAP-57** Keyboard shortcuts. Resolved by KRI-56 and coordinator decision 25.
- **GAP-58** Search. Resolved by KRI-56.
- **GAP-59** List columns, groupings and filters. Resolved by KRI-56, KRI-62 and coordinator decision 15.
- **GAP-60** System errors and alerts. Resolved by KRI-59 (banner addendum) and KRI-65.
- **GAP-61** Inbox order and clearing. Resolved by KRI-56 and KRI-61.
- **GAP-62** Board: disabled Stages, Done, archived. Resolved by KRI-56 and KRI-62.
- **GAP-63** Editing Comments and attachments. Still open; see above.
- **GAP-64** Notifications beyond Inbox items. Resolved by KRI-59.
- **GAP-65** Archived Tasks. Resolved by KRI-56: the List’s Archived filter.
- **GAP-66** Menu-bar menu and Linux without a tray. Resolved by KRI-59 and coordinator decision 19.
- **GAP-67** Comment kinds. Resolved by KRI-55 and its follow-up: `note`, `question`, `round`, `review`, `signoff`, `permission`, `proposal`.

### 9. Automations and intake
- **GAP-68** Automations page, form and commands. Resolved by KRI-60 and KRI-66.
- **GAP-69** Automation Run lifetime and replies. Resolved by KRI-60.
- **GAP-70** Overlapping firings and a full limit. Resolved by KRI-60, changed by Nabha’s review: skip only while the previous Run is Working, Queued or Paused.
- **GAP-71** Where Automations are stored. Resolved by KRI-60: TED’s store, per machine.
- **GAP-72** Linear URL with no key. Resolved by KRI-60 and KRI-57.

### 10. Planning Runs
- **GAP-73** Ending, renaming, deleting; checkout. Resolved by KRI-60, KRI-66 and coordinator decisions 9 and 10.

### 11. Release
- **GAP-74** Linux packages. Resolved by KRI-59: AppImage, deb and rpm, all through TED’s updater.
- **GAP-75** Secrets on Linux without a Secret Service. Resolved by KRI-57: a 0600 file with consent.

---

## Proposals

- **P-1** Visual detail, the Plans list and planning chat. Resolved by KRI-56 (Plans under each Factory), KRI-60 (the planning chat is a live chat, not a Task-thread layout), KRI-66 and the KRI-8 Figma consistency pass. Visual detail lives in the Figma pages.
- **P-2** Agent needs a simulator with all slots booted. Confirmed by KRI-60 and drawn in KRI-61: a `permission` Comment with **Deny** and **Shut down NB-40’s and run**.

---

## Contradictions between tickets

- **C-1** Version restart: resume or fresh Run. Resolved by KRI-53.
- **C-2** Shape of `repos`. Resolved by KRI-58: a list.
- **C-3** Local folder or TED clone. Resolved by KRI-58 and ADR 0006: TED’s clone; the folder is only a source of copy files.
- **C-4** Custom Stages. Resolved by KRI-58: not in v1.
- **C-5** Setup Task and the limit. Resolved by KRI-55: waits at the front of the queue.
- **C-6** GitHub credentials. Resolved by KRI-57 and ADR 0007: `gh`’s login.

### Settled earlier by “later wins”
- Validate `max_back` 3 (KRI-12) → 5 with `loop_check: 3` (KRI-16).
- `ted run handoff` (KRI-11) → dropped (KRI-17).
- Factory setup as a Run outside any Task (KRI-16) → a Task (KRI-22).
- Simulator: TED silently shuts down the oldest (KRI-18) → asks first (KRI-23).
- Task Lead merges (KRI-12) → TED merges (KRI-52).
- Request changes at Review keeps the Task in the Stage (KRI-12) → the Task Lead picks Work or Design (KRI-18).
- Override and Reset write at once (KRI-12) → collect until Save (KRI-22).
- Claude Code through the Agent SDK (KRI-20) → CLI for subscriptions (KRI-21, ADR 0004).
- “Done” as a status (KRI-11) → a holding Stage (KRI-52).
- Windows installers (KRI-10) → macOS and Linux only (KRI-14).

### Settled by KRI-53 to KRI-66
- Talk it through with `planner` (KRI-53) → in the Task Lead’s own Run (KRI-60).
- Symlinked worktree files (KRI-20) → copied (KRI-58).
- Agents open pull requests at Review (KRI-58) → TED pushes and opens draft pull requests at Validate (KRI-58 follow-up).
- Removing a secondary repo while Tasks use it (KRI-58) → refused (coordinator decision 12).
- All Checks run after a failure (KRI-60) → stop at the first failure (Nabha’s review).
- No CI after a 2-minute wait (KRI-60) → detected at push (Nabha’s review).
- Automation firing skipped while the Run waits on the human (KRI-60) → fires again (Nabha’s review).
- Approve with unsent line comments asks or sends them (KRI-60, KRI-63) → never asks, never sends (coordinator decision 7).
- Restart the daemon for updates only with no Runs (KRI-11) → restarting never stops Runs (KRI-59).
- A systemd unit for start at login → the app in the background via LaunchAgent or XDG autostart (KRI-57).
- Amber sidebar dot for stops-work Factory banners (KRI-59) → red ⚠ (KRI-56 follow-up).
- Missing local folder stops work (KRI-59) → warning (KRI-65).
- Invalid file with no valid version stops work (KRI-59) → warning (KRI-65).
- Theme setting “Light, Dark, Follow system” (KRI-57) → Appearance: System, Light, Dark, dark mode in v1 (KRI-64, Nabha’s review).
- Run icons with C and X letters (coordinator decision 5) → Anthropic and OpenAI marks (KRI-8 consistency pass, Nabha’s review).
- Stage history section in Task details (KRI-13) → filter the thread from the Stage track (coordinator decision 4).
- Factory switcher at the top of the sidebar (KRI-13) → the Factories section is the switcher (KRI-56).
- Badges count unread (KRI-20) → count waiting requests (KRI-56).
