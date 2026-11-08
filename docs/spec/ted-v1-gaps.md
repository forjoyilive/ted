# TED v1: open product decisions

Companion to `ted-v1-spec.md`. Each gap is a place where a builder would have to make something up. Grouped by area, large ones first in each group.

Sizes: **S** one line in the spec once answered; **M** a few related questions; **L** needs its own grilling or prototype.

Totals: 75 gaps. 6 large, 26 medium, 43 small. Plus 2 proposals to confirm and 6 unsettled contradictions (end of file).

---

## 1. First run, settings and preferences

### GAP-1: How does the human choose the model and effort level for each kind of Run? (L)
- **Area:** Agents and Runs; Settings. Spec 3.3, 5.1, 5.2, 6.4, 6.5, 8.8, 8.9, 9.1.
- **Why open:** Only fragments are decided. `lead` may be `{agent: claude, model: opus}` [KRI-12], with no effort key. Automations store “agent, model and effort” per Automation [KRI-20], with no default and no form. `reviewer` is a kind only (`codex | claude | same`) [KRI-16]. Sub-agents are started with `--agent <kind>` and no model flag; “the Task Lead picks agents for sub-agents” [KRI-11, KRI-20]. The loop-check sub-agent is “of the reviewer kind” [KRI-16]. Planning Runs, the drift “Merge with an agent” Task [KRI-22], and Talk it through [KRI-19] say nothing. No ticket says whether model and effort live in `workflow.yaml` (committed, shared) or app Settings (per machine), or both, nor what happens when a named model isn’t available on the user’s plan.
- **Screen:** yes (Settings, Automation form, maybe New Task dialog).
- **Suggested answer:** Allow `{agent, model, effort}` wherever an agent kind is named: `lead`, `reviewer`, and a new `planner` key, each in any layer. Add `--model` and `--effort` to `ted run start`, with the Task Lead choosing from the Stage file’s guidance. Loop check inherits `reviewer`. Automations default to `lead`’s values. App Settings edits the Library values. Unset means the CLI’s own default.
- **Size:** L

### GAP-2: What does first launch look like? (L)
- **Area:** UI, Agents. Spec 5.8, 8.13, 3.7.
- **Why open:** KRI-22 says checking `claude` / `codex` installed and signed in “belongs to TED’s first launch”. ADR 0004 says TED “checks this and explains how” and opens the CLI’s login in a terminal [KRI-21]. Nothing defines the screens: order of checks, what if only one CLI is installed, whether GitHub (`gh`) is checked here or only in the Add Factory form [KRI-22], when the Add Factory form appears, the tutorial checkbox [KRI-22], the notification permission timing [KRI-20], and whether starting at login is offered (GAP-6).
- **Screen:** yes.
- **Suggested answer:** A short checklist screen: Claude Code, Codex (at least one required), GitHub; each row with status and a Fix button that opens the CLI login in a terminal; then the Add Factory form with the tutorial on.
- **Size:** L

### GAP-3: What is in app Settings, how is it laid out, and which settings are global versus per Factory? (L)
- **Area:** Settings. Spec 8.9.
- **Why open:** Settings are scattered across tickets: max working Runs [KRI-15], simulator cap [KRI-18], auto restart [KRI-20], Stay Awake [KRI-20], theme, sound, Developer mode, Linear key [KRI-20], Library `reviewer` [KRI-16], terminal size [KRI-14], the remembered Quit choice [KRI-11]. No inventory, grouping or screen exists. Library editing in Settings writes to `~/.ted/library/` [KRI-22], but which Library keys Settings exposes (Gates? order? Stage files? Clarify depth?) is not said. Per-Factory overrides of machine settings (e.g. Stay Awake per Factory) aren’t addressed.
- **Screen:** yes.
- **Suggested answer:** Sections: General (theme, sound, Stay Awake, start at login, editor), Agents (health, billing mode, model/effort defaults, auto restart), Limits (working Runs, simulators), Integrations (GitHub status, Linear key), Library (the same editor as the Factory settings panel, without the PR step), Developer.
- **Size:** L

### GAP-4: How does the user choose API-key billing, and where does TED show which credential a Run uses? (M)
- **Area:** Agents, Settings. Spec 5.8.
- **Why open:** ADR 0004 strips API-key variables “unless the user has chosen API-key billing”, and KRI-21 says “show which credential each Run uses”. No ticket says where the choice is made, whether it is per agent kind, or how the key reaches the CLI given TED never stores keys (the daemon’s environment differs when started at login vs from a shell).
- **Screen:** yes.
- **Suggested answer:** Per agent kind in Settings → Agents: “Subscription login” (default) or “API key from my environment”. Run rows in Task details show a small “Subscription” / “API key” label.
- **Size:** M

### GAP-5: Which editor does Open in editor use? (S)
- **Area:** Review. Spec 7.6.
- **Why open:** Open in editor appears in KRI-18 and KRI-20; no editor choice is named.
- **Screen:** yes (one setting).
- **Suggested answer:** A Settings picker of detected editors (VS Code, Cursor, Zed, …), default the system handler for folders.
- **Size:** S

### GAP-6: Does the daemon start at login by default, and is it a setting? (S)
- **Area:** Release, Architecture. Spec 2.3, 10.
- **Why open:** The map lists starting at login as release work “with no product decision behind it” [KRI-8], but on/off default and whether the user can turn it off are product choices. It also interacts with “a daemon started by `ted` exits after a minute” [KRI-11].
- **Screen:** yes (one setting).
- **Suggested answer:** Offered on first launch, on by default, toggle in Settings → General. A login-started daemon stays up.
- **Size:** S

---

## 2. Agents and Runs

### GAP-7: What happens when an agent hits a usage limit or rate limit? (L)
- **Area:** Agents, queue, UI. Spec 4.4, 5.8.
- **Why open:** ADR 0004 says TED “shows when an agent reports it has hit a usage limit”; KRI-21 notes parallel Runs share one five-hour and weekly allowance. Nothing says: does the queue pause for that agent kind, do working Runs show a status, does TED retry when the window resets, does the reviewer fall back to the other kind, is it an Inbox item or a banner, and what about short API rate limits (429) versus plan limits.
- **Screen:** yes.
- **Suggested answer:** A per-agent “Usage limit until 14:20” state: Runs of that kind pause with that status, no new Runs of that kind start, a banner (not an Inbox item) shows, and Runs resume on their own at reset. Short rate limits retry silently with backoff.
- **Size:** L

### GAP-8: What happens when an agent CLI is missing, signed out or outdated after first launch? (M)
- **Area:** Agents, errors. Spec 5.8.
- **Why open:** Per-agent health exists [KRI-20] and first launch checks [KRI-22]. Nothing covers a CLI that disappears or logs out mid-use: does the Run fail, wait, or post a Comment; does the queue hold; is there a minimum supported version; what if `lead` names an agent that isn’t installed.
- **Screen:** yes (banner/status).
- **Suggested answer:** TED checks before starting each Run. A missing or signed-out agent holds Runs of that kind with status “Claude Code signed out”, shows a banner with Fix (opens login), and resumes when health returns.
- **Size:** M

### GAP-9: What values does `permissions` take, and what does it cover? (M)
- **Area:** Agents, `workflow.yaml`. Spec 3.3, 5.5.
- **Why open:** KRI-20 names “one `permissions` setting” and says bypass needs an explicit Factory setting. No values, no per-agent mapping, no statement on whether it applies to sub-agents, reviewers, Automations and Planning Runs, whether it can sit in the Library, and whether a permission request can be approved “always for this Task”. No timeout for an unanswered request.
- **Screen:** no (yaml), yes if the settings panel edits it.
- **Suggested answer:** `permissions: default | ask | bypass`, mapped per agent kind (`default` = Claude `auto`, Codex `workspace-write` + `on-request`; `ask` = stricter; `bypass` = full). Factory layer only. Applies to all Runs in the Factory. Approve/Deny only, no “always”.
- **Size:** M

### GAP-10: Where does the human see cost and plan usage? (M)
- **Area:** UI, Agents. Spec 5.3, 8.5, 8.10.
- **Why open:** Cost is estimated per Run and totalled per Task [KRI-20]; token use shows in Diagnostics [KRI-17]; KRI-21 says “show plan usage”. Not said: whether cost shows outside Developer mode, Factory or daily totals, a cost column in List, budget warnings, how cost reads for subscription users (estimated dollars vs tokens), where the price list comes from and how it updates.
- **Screen:** yes.
- **Suggested answer:** Task details Runs section shows tokens and estimated cost per Run and a Task total. List can show a cost column. Factory totals in Diagnostics. No budgets in v1.
- **Size:** M

### GAP-11: Does a restart onto a new agent version resume the same conversation or start a fresh Run from the brief? (M)
- **Area:** Runs. Spec 5.3. Also a contradiction (C-1).
- **Why open:** KRI-20 and the glossary: restart resumes the same conversation and stays the same Run. KRI-11: TED never resumes an old agent session (session files depend on the working directory and expire after about 30 days). KRI-17 (later) and the map: a version restart starts a fresh Run from the brief. The later-wins rule points to KRI-17, but the glossary (current in the repo) follows KRI-20.
- **Screen:** no.
- **Suggested answer:** Resume when the session file exists (manual restart and version restart of a recently idle Run); fall back to a fresh Run from the brief otherwise. Update whichever doc loses.
- **Size:** M

### GAP-12: What makes a Run “failed”, and does TED retry? (S)
- **Area:** Runs, statuses. Spec 4.4, 5.3.
- **Why open:** KRI-11 lists Failed as a status and a Run icon state, and says a crash starts a fresh Run from the brief. No definition of failure (process exit, hook error, repeated crash), no retry count, no point at which the human is asked.
- **Screen:** no.
- **Suggested answer:** A Run fails when its process exits without a finished state. TED starts one fresh Run from the brief; a second failure within 10 minutes marks the Task Failed and posts an ask Comment with Retry.
- **Size:** S

### GAP-13: Can the human change a Task’s agent or model, on one Task or mid-Run? (S)
- **Area:** Agents, Tasks. Spec 5.1.
- **Why open:** `lead` is Workflow-wide [KRI-12]. No per-Task override exists, unlike Clarify depth, which has one [KRI-19].
- **Screen:** yes (Task field).
- **Suggested answer:** A Task Lead field in the New Task dialog and Task details, editable until the Task starts. No switching mid-Run.
- **Size:** S

### GAP-14: Is there a cap on sub-agents per Task? (S)
- **Area:** Agents. Spec 5.2.
- **Why open:** Sub-agents count toward the limit [KRI-15]; icons collapse past three [KRI-11]. One Task could still fill every slot.
- **Screen:** no.
- **Suggested answer:** No per-Task cap; the machine and Factory limits cover it.
- **Size:** S

### GAP-15: Does TED touch the user’s agent configuration, and does the human see the Run preamble? (S)
- **Area:** Agents. Spec 5.3, 5.7.
- **Why open:** TED relies on agent hooks [KRI-20] and passes `--mcp-config` and `--settings` on resume [KRI-20], implying per-Run config, but no ticket rules out writing to `~/.claude` or `~/.codex`. Whether the preamble and Factory notes show in the Conversation is not said.
- **Screen:** no.
- **Suggested answer:** Per-Run flags only; never write to the user’s agent config. The preamble shows as a collapsed first row in the chat.
- **Size:** S

---

## 3. Architecture, daemon and storage

### GAP-16: What does the app show when the daemon crashes, and does it restart itself? (M)
- **Area:** Architecture, errors. Spec 2.4.
- **Why open:** Agents run in detached hosts [KRI-10] and Runs survive app restarts [KRI-20], but no ticket covers a daemon crash: auto-restart, reattaching to detached Runs, what the window shows meanwhile.
- **Screen:** yes (disconnected state).
- **Suggested answer:** The app shows a “Reconnecting to TED…” bar and restarts the daemon; the daemon reattaches to running hosts; Copy report from Diagnostics.
- **Size:** M

### GAP-17: Do scheduled Automations keep the daemon running? (M)
- **Area:** Architecture, Automations. Spec 2.3, 2.4, 9.1.
- **Why open:** Quit with nothing running quits the daemon [KRI-11]; a `ted`-started daemon exits after a minute idle [KRI-11]. Automations need a running daemon to fire; “missed runs made up” [KRI-20] suggests catch-up after downtime, but doesn’t say whether Quit should warn about pending Automations.
- **Screen:** maybe (Quit dialog wording).
- **Suggested answer:** An enabled Automation counts as activity: Quit offers the same keep-running choice, and a login-started daemon stays up. Missed firings make up once, not once per missed slot.
- **Size:** M

### GAP-18: How does TED handle disk use and a full disk? (M)
- **Area:** Storage, errors. Spec 2.2.
- **Why open:** Clones, worktrees per Task, simulators per Task, attachments and Conversations all live under `~/.ted/` [KRI-8, KRI-18]. Nothing about showing disk use, cleaning clones of removed Factories, or what fails (and how) when the disk fills.
- **Screen:** yes (Diagnostics row, error banner).
- **Suggested answer:** Diagnostics shows `~/.ted/` size by category. Below a free-space threshold, TED stops starting Runs and shows a banner.
- **Size:** M

### GAP-19: How are store migrations, backup and export handled? (S)
- **Area:** Storage. Spec 2.2.
- **Why open:** LiveStore is beta [KRI-9]. App updates may change the event schema. No ticket covers backups or exporting Tasks.
- **Screen:** no.
- **Suggested answer:** TED snapshots the store before each migration and keeps the last three. No export in v1.
- **Size:** S

### GAP-20: How long are Conversations, raw Run output, App logs and the event log kept? (S)
- **Area:** Storage. Spec 2.2.
- **Why open:** Stopped Runs are kept as history [Glossary]; auto-delete of archived Tasks is later [KRI-27]. No retention or size caps for logs.
- **Screen:** no.
- **Suggested answer:** Keep Conversations with their Task. Cap App logs and raw output per Run (e.g. last 10 MB).
- **Size:** S

### GAP-21: How do updates install when Runs are always active? (S)
- **Area:** Architecture. Spec 2.4.
- **Why open:** Updates restart the daemon only with no active Runs [KRI-11]. With Automations and long Runs, that may never happen. No update prompt is defined.
- **Screen:** yes (small).
- **Suggested answer:** Install the app at once; show “Restart TED to finish updating (3 Runs active)” in the menu-bar menu and Settings.
- **Size:** S

### GAP-22: How do local clients authenticate to the daemon’s loopback API? (S)
- **Area:** Architecture. Spec 2.1.
- **Why open:** The daemon listens on loopback [KRI-10]. Any local process could drive it. Not discussed.
- **Screen:** no.
- **Suggested answer:** A per-user token file in `~/.ted/` with 0600 permissions; the app, CLI and MCP server read it.
- **Size:** S

---

## 4. Factory and Workflow

### GAP-23: What is the exact shape of `repos`, and where do per-repo settings go in a single-repo Factory? (M)
- **Area:** `workflow.yaml`. Spec 3.3. Also contradiction C-2.
- **Why open:** KRI-12: a list of `{name, remote}`, left out for single-repo Factories. KRI-18: a map keyed by repo name with `apps` under it. KRI-20 and KRI-52 add per-repo settings (`merge_method`, worktree settings). A single-repo Factory with `apps` has nowhere to put them if `repos` is left out.
- **Screen:** no.
- **Suggested answer:** A list of objects with `name`, `remote`, `apps`, `merge_method` and worktree keys. A single-repo Factory may list one entry; `remote` defaults to the repo’s own.
- **Size:** M

### GAP-24: What does the Add Factory form ask, and does TED clone repos or use the user’s existing clone? (M)
- **Area:** Factory setup. Spec 2.5, 3.7. Also contradiction C-3.
- **Why open:** KRI-12: `repos` has no local paths; clones live in `~/.ted/`. KRI-20: TED asks for protected-folder access “when a repo is added from one”, which implies picking a local folder. KRI-22 names repo order and the tutorial checkbox only. Factory name, key, and how a repo is picked (GitHub list, URL, folder) are open.
- **Screen:** yes.
- **Suggested answer:** Pick a local folder or paste a URL; TED reads the remote and clones into `~/.ted/` either way, so worktrees never touch the user’s clone. Fields: name (from the primary repo), repos (ordered), tutorial.
- **Size:** M

### GAP-25: What are the key names for per-repo worktree settings? (M)
- **Area:** `workflow.yaml`. Spec 3.3.
- **Why open:** KRI-20 lists default branch, env vars, symlinked files and setup/teardown scripts but gives no keys, formats, or when setup/teardown run (worktree create/remove? each Run?). Whether env vars may hold secrets in a committed file is not said.
- **Screen:** yes if the settings panel edits them.
- **Suggested answer:** `default_branch`, `env` (map, no secrets), `link` (list of files symlinked from the user’s clone), `setup` and `teardown` (commands run on worktree create and remove).
- **Size:** M

### GAP-26: What happens when `workflow.yaml` or a Stage file is invalid? (M)
- **Area:** Workflow, errors. Spec 3.8.
- **Why open:** Layers resolve at each Stage entry [ADR 0002]. Nothing covers invalid YAML, an unknown Stage id in `order`, a missing Stage file for an id, or a bad key, on the default branch or in the Library.
- **Screen:** yes.
- **Suggested answer:** TED validates on load. On error it keeps using the last valid resolution, flags the Factory settings panel and the Factory page with the error, and blocks Save in the panel until fixed.
- **Size:** M

### GAP-27: How does the human rename or remove a Factory, or remove a repo from one? (M)
- **Area:** Factory. Spec 3.1.
- **Why open:** Only adding is specified [KRI-22]. Removing a Factory with open Tasks, clones and Automations, and removing a repo that open Tasks touch, are not covered.
- **Screen:** yes.
- **Suggested answer:** Remove Factory requires no working Runs; it archives all Tasks, disables Automations, deletes clones after a confirm, and leaves `.ted/` in the repo.
- **Size:** M

### GAP-28: Can a user add a custom Stage in v1? (S)
- **Area:** Workflow. Spec 3.4. Also contradiction C-4.
- **Why open:** KRI-12: “A custom Stage is a new file plus an entry in `order`.” KRI-50 (later): v1 ships the built-in set only. KRI-50 may mean new Stage *types* (holding, Gate behaviour) rather than new agent Stages from a Stage file.
- **Screen:** no.
- **Suggested answer:** Allow new agent Stages via a Stage file and `order`; new Stage types (with special behaviour like holding) are KRI-50.
- **Size:** S

### GAP-29: How does the human edit Library Stage files in the UI? (S)
- **Area:** Library, Settings. Spec 3.5.
- **Why open:** Library edits “write straight to `~/.ted/library/`” [KRI-22] but there’s no screen for Stage files there.
- **Screen:** yes.
- **Suggested answer:** Settings → Library reuses the Factory settings panel with Markdown editing, writing files directly.
- **Size:** S

### GAP-30: What is a Task’s ID, and is there a per-Factory key? (S)
- **Area:** Factory, Tasks. Spec 3.1, 8.4.
- **Why open:** Prototypes show “NB-44” [KRI-23]; no ticket defines the prefix or numbering.
- **Screen:** yes (Add Factory form).
- **Suggested answer:** A 2–4 letter key per Factory, chosen in the Add Factory form, then a counter.
- **Size:** S

### GAP-31: What Workflow does the drift “Merge with an agent” Task go through? (S)
- **Area:** Factory settings. Spec 3.8.
- **Why open:** KRI-22 calls it “a small Task that opens a pull request” but not which Stages run or whether it merges like a settings Save.
- **Screen:** no.
- **Suggested answer:** Work, Validate (Checks only), Review sign-off, Merge.
- **Size:** S

### GAP-32: How do Backlog and Done appear in `order`, and what can be changed about them? (S)
- **Area:** `workflow.yaml`. Spec 3.3.
- **Why open:** Backlog is “first in `order`” and can be turned off [KRI-15]; Done is “at the end” [KRI-52]. Whether they must be listed, can be moved, or Done can be disabled is not said.
- **Screen:** no.
- **Suggested answer:** Both are implicit and fixed; `order` lists only agent Stages. Backlog can be disabled; Done cannot.
- **Size:** S

### GAP-33: Do other Stages have a default `max_back`? (S)
- **Area:** `workflow.yaml`. Spec 3.3.
- **Why open:** Defaults exist for Validate (5) and Merge (3) [KRI-16, KRI-52]. Review sends back via Request changes from the human, and Clarify grilling rounds have no limit.
- **Screen:** no.
- **Suggested answer:** Only Validate and Merge send back on their own; others have none.
- **Size:** S

---

## 5. Tasks and Stages

### GAP-34: What is the complete status model, and how does each status look? (L)
- **Area:** Tasks, UI. Spec 4.4.
- **Why open:** Statuses come from several tickets: Working, Waiting on you, Idle, Queued, Failed, Done [KRI-11]; Blocked badge [KRI-15]; Needs planning [KRI-19]; Waiting for merge, Partly merged, Waiting for GitHub review [KRI-52]; Done became a Stage [KRI-52]. Missing: precedence when several apply (Blocked and Waiting on you?), states for usage limit (GAP-7), agent signed out (GAP-8), CI running at Merge, Archived; and how each renders on cards, rows and the header.
- **Screen:** yes.
- **Suggested answer:** One primary status per Task with a fixed precedence (Waiting on you > Failed > Blocked > Working > Queued > Idle), plus markers (Needs planning, Partly merged). Prototype the card and row.
- **Size:** L

### GAP-35: What does the New Task dialog contain? (M)
- **Area:** Tasks. Spec 4.1, 8.13.
- **Why open:** Only the Start now checkbox [KRI-15] and Linear URL paste [KRI-20] are decided. Not decided: Factory choice, title/description, Priority, Clarify depth [KRI-19], blocked-by, repos, attachments, where it opens from, shortcut.
- **Screen:** yes.
- **Suggested answer:** Title, description (paste a Linear URL to fill), Factory, Priority, Clarify depth (Auto), blocked by, Start now.
- **Size:** M

### GAP-36: What can the human edit on a Task after creation? (M)
- **Area:** Tasks. Spec 4.1.
- **Why open:** Priority and rank by drag [KRI-15], Clarify depth by field or Comment [KRI-19]. Title and description are versioned [KRI-19] but not said to be human-editable. Changing anything after the Task Lead started, and whether edits reach the live Run, are open.
- **Screen:** yes.
- **Suggested answer:** Title, description, Priority, blockers editable any time; a description edit after start creates a version and is sent to the Task Lead as an event.
- **Size:** M

### GAP-37: How are blockers added, removed and resolved in edge cases? (M)
- **Area:** Tasks. Spec 4.15.
- **Why open:** `--blocked-by` on create [KRI-15], agents add links mid-flow [KRI-15], Splits and Planning Runs create them [KRI-19]. No UI for the human, no `ted` command for an agent adding one to an existing Task, no rule for cycles, cross-Factory blockers, or a blocker that is archived or deleted (it never merges).
- **Screen:** yes.
- **Suggested answer:** A Blocked by field in Task details; `ted task block <id> --by <id>`; cycles refused; an archived or deleted blocker clears the link and posts an event.
- **Size:** M

### GAP-38: Can the human pause, stop or cancel a Task without archiving it? (M)
- **Area:** Tasks. Spec 4.18.
- **Why open:** The human can Stop a sub-agent [KRI-11] and stop Runs in general [KRI-20], and can’t move a started Task back to Backlog [KRI-15]. Stopping the Task Lead leaves the Task in an undefined state. No “won’t do” or cancel; archive is the only exit. Archiving a Task with an open pull request doesn’t say whether the PR is closed.
- **Screen:** yes.
- **Suggested answer:** Stop on the Task Lead leaves the Task Idle in its Stage with a Resume action (fresh Run from brief). Archive is the cancel and leaves the PR open with an optional “Close pull request” checkbox.
- **Size:** M

### GAP-39: Where does a hand-created Task go when Start now is unchecked? (S)
- **Area:** Tasks. Spec 4.2.
- **Why open:** KRI-15 says hand-created Tasks land in Intake with Start now on by default, but not where unchecked goes.
- **Screen:** no.
- **Suggested answer:** Backlog.
- **Size:** S

### GAP-40: What happens when a Done Task is unarchived? (S)
- **Area:** Tasks. Spec 4.18.
- **Why open:** Unarchive starts a fresh Task Lead from the brief [KRI-11], but a Done Task has no work to do and is never reopened [KRI-52].
- **Screen:** no.
- **Suggested answer:** It returns to Done with no Run and no worktree.
- **Size:** S

### GAP-41: Who decides which repos a Task touches, and when are worktrees created? (S)
- **Area:** Tasks. Spec 4.1.
- **Why open:** Intake guesses repos [KRI-12]; one PR per repo [KRI-13]. Nothing says if the human can set repos, or whether worktrees exist for all Factory repos or only touched ones.
- **Screen:** maybe (Task field).
- **Suggested answer:** Worktrees for every repo the Task Lead declares; Intake sets the initial list; the human can edit it.
- **Size:** S

### GAP-42: How are branch names formed and collisions handled? (S)
- **Area:** Tasks. Spec 4.1.
- **Why open:** Linear’s name or a title slug [KRI-20]. No prefix, no rule for an existing branch, Follow-up branch names.
- **Screen:** no.
- **Suggested answer:** `ted/<task-id>-<slug>` unless Linear supplies one; append `-2` on collision.
- **Size:** S

### GAP-43: What happens to a Comment on a Task with no live Run? (S)
- **Area:** Comments. Spec 8.4.
- **Why open:** Comments go into the Task Lead’s live Run [KRI-11]. Backlog, Queued, Blocked mid-flow, archived and Needs planning Tasks have none. Done offers Follow up [KRI-52].
- **Screen:** no.
- **Suggested answer:** Stored and handed to the next Run with the brief; no Run is started by the Comment alone.
- **Size:** S

### GAP-44: Does the setup Task wait for a free slot? (S)
- **Area:** Factory setup, queue. Spec 3.7. Also contradiction C-5.
- **Why open:** KRI-22: starts “at once … ahead of the queue, and counts toward the limit.” “At once” and “counts toward the limit” conflict when the limit is full.
- **Screen:** no.
- **Suggested answer:** It goes to the front of the queue and takes the next free slot.
- **Size:** S

### GAP-45: Does the duplicate-source check include Done Tasks? (S)
- **Area:** Automations. Spec 5.4, 9.1.
- **Why open:** KRI-20 refuses a second “open or archived” Task with the same source; Done (added later by KRI-52) isn’t mentioned.
- **Screen:** no.
- **Suggested answer:** Yes; any existing Task with that source, not deleted.
- **Size:** S

---

## 6. Validation

### GAP-46: How are Checks run: order, parallelism, default timeout, environment, output kept? (S)
- **Area:** Validation. Spec 6.1.
- **Why open:** KRI-16 gives `name`, `run`, `repo`, `timeout`. Not said: sequential or parallel, stop at first failure, default timeout, whether Apps or env from GAP-25 apply, how much output goes back to Work.
- **Screen:** no.
- **Suggested answer:** In listed order, stop at first failure, default timeout 10 minutes, worktree env applied, last 200 lines of output sent with the send-back.
- **Size:** S

### GAP-47: What if the reviewer kind isn’t installed or is signed out? (S)
- **Area:** Validation. Spec 6.4.
- **Why open:** Default is “the other kind when both are installed” [KRI-16], but an explicit `reviewer: codex` with Codex missing isn’t covered.
- **Screen:** no.
- **Suggested answer:** Fall back to `same` and note it on the ✓ row.
- **Size:** S

### GAP-48: Do Checks for a repo run when the Task didn’t change that repo? (S)
- **Area:** Validation. Spec 6.1.
- **Why open:** Checks have a `repo` field [KRI-16]; multi-repo Tasks may touch only some repos.
- **Screen:** no.
- **Suggested answer:** Skip Checks for repos the Task didn’t change, shown as “– skipped” on the ✓ row.
- **Size:** S

---

## 7. Review and Merge

### GAP-49: How does TED authenticate to GitHub, and what happens when it can’t? (M)
- **Area:** Merge, Factory setup, errors. Spec 2.5, 7.5. Also contradiction C-6.
- **Why open:** KRI-20 stores “GitHub token” in the Keychain. KRI-52 merges with `gh pr merge` “under the user’s own GitHub login”. KRI-22 checks “GitHub access” in the Add Factory form. Which one is it, and what does TED show when `gh` is missing, logged out, or the token expires mid-merge or while watching PRs?
- **Screen:** yes (status, banner).
- **Suggested answer:** Use `gh`’s own login for everything (matches ADR 0004’s spirit: no credentials stored). Health row in Settings; expired auth shows a banner and holds Merge with status “GitHub signed out”.
- **Size:** M

### GAP-50: How are diff line comments drafted and shown? (M)
- **Area:** Review, Changes panel. Spec 7.7.
- **Why open:** KRI-18 says line comments are drafted in the Changes panel and sent with Request changes. Not designed: how to add one, where pending ones show, whether they can be sent outside Review, whether they post to GitHub.
- **Screen:** yes.
- **Suggested answer:** Click a line to draft; a “3 pending comments” chip on the sign-off card; sent only with Request changes; TED-only, not posted to GitHub.
- **Size:** M

### GAP-51: What do the sign-off buttons say when Merge is off or has its own Gate? (S)
- **Area:** Review. Spec 7.1.
- **Why open:** “Approve and merge” assumes Merge is on with no Gate [KRI-13, KRI-52].
- **Screen:** yes.
- **Suggested answer:** “Approve” when Merge is off or gated; the Merge Gate card shows “Merge”.
- **Size:** S

### GAP-52: What happens at Merge when a repo has no CI, or CI never reports? (S)
- **Area:** Merge. Spec 7.5.
- **Why open:** KRI-52 waits for required checks or all checks. No checks at all, or a stuck check, isn’t covered.
- **Screen:** no.
- **Suggested answer:** No checks means mergeable now. A check pending over 60 minutes posts an ask Comment.
- **Size:** S

### GAP-53: What does the Merge Gate sign-off show? (S)
- **Area:** Merge. Spec 7.5.
- **Why open:** `merge: { gate: true }` exists [KRI-52] but its card content isn’t described.
- **Screen:** yes.
- **Suggested answer:** CI status per PR, merge method per repo, and a Merge button.
- **Size:** S

### GAP-54: Where does the Task shell open, and how is it reached? (S)
- **Area:** UI. Spec 7.6, 8.5.
- **Why open:** One shell per worktree per repo [KRI-20]; no placement in the three panes.
- **Screen:** yes.
- **Suggested answer:** A Shell entry in Task details opens it in the middle pane, like an App log.
- **Size:** S

---

## 8. UI

### GAP-55: Do the Inbox, Board and List show one Factory or all, and what is the “Factory page”? (L)
- **Area:** UI layout. Spec 8.2.
- **Why open:** KRI-13’s sidebar has both a Factory switcher and a list of Factories. The queue is shared across Factories [KRI-15]. KRI-22 mentions banners “on the Factory page”, and KRI-19 a per-Factory Plans list and a Plan action on “the Factory”, but no ticket defines a Factory page. Automations page placement also open.
- **Screen:** yes.
- **Suggested answer:** Inbox is across all Factories by default with a filter. Board, List, Plans and Automations are per Factory, under each Factory in the sidebar. The “Factory page” is the Board with a banner area at the top.
- **Size:** L

### GAP-56: What do empty states show? (M)
- **Area:** UI. Spec 8.13.
- **Why open:** No ticket covers: no Factories, empty Inbox, empty Board, empty Plans list, no Automations, a Task with no Runs yet.
- **Screen:** yes.
- **Suggested answer:** Each empty state names the next action: Add Factory, New Task, Plan, New Automation from a template.
- **Size:** M

### GAP-57: What are the keyboard shortcuts? (M)
- **Area:** UI. Spec 8.12.
- **Why open:** KRI-20 names actions (next Inbox item, Approve, reply, switch View, jump to Task) and a command palette, not keys. Request changes, Accept all recommended, New Task, Start and archive have no shortcut named. Number keys for choices are deferred (KRI-46).
- **Screen:** no (a shortcuts sheet, maybe).
- **Suggested answer:** `j`/`k` next/previous, `a` Approve, `r` reply, `1`/`2`/`3` Inbox/Board/List, `⌘K` palette, `c` New Task, `⌘/` shortcut sheet.
- **Size:** M

### GAP-58: What does search cover? (M)
- **Area:** UI. Spec 8.12.
- **Why open:** The palette searches “Tasks, Comments and commands” [KRI-20]. Not said: across Factories, archived and Done Tasks, Conversations, full text or titles only, Planning Runs.
- **Screen:** yes.
- **Suggested answer:** All Factories; titles, descriptions and Comments full text; archived included with a label; Conversations excluded.
- **Size:** M

### GAP-59: Which columns, groupings and filters does the List offer? (M)
- **Area:** UI. Spec 8.7.
- **Why open:** “Sortable, groupable rows, like Linear” [KRI-8], sort by Manual rank [KRI-15], filter by Needs planning [KRI-19]. Nothing else.
- **Screen:** yes.
- **Suggested answer:** Columns: ID, title, Stage, status, Priority, updated, cost. Group by Stage, status, Priority, Factory. Filter by the same plus markers and archived.
- **Size:** M

### GAP-60: Where do system-level errors and alerts appear? (M)
- **Area:** UI, errors. Spec 8.11, 8.13.
- **Why open:** Several problems are not Inbox items by design (setup notices, drift, No Checks, GitHub review [KRI-22, KRI-52]), and others have no home: daemon down, agent signed out, GitHub signed out, usage limit, disk full, invalid `workflow.yaml`. KRI-22 introduces banners on the Factory page only.
- **Screen:** yes.
- **Suggested answer:** One app-wide banner area at the top of the middle pane for machine problems, Factory banners for Factory problems, and a system notification only for problems that stop all work.
- **Size:** M

### GAP-61: How does the Inbox order, group and clear items? (M)
- **Area:** Inbox. Spec 8.3.
- **Why open:** The Inbox is “the unanswered ones” [KRI-11]. Not said: sort (age, Priority, Factory), whether a Task with several requests shows several rows, dismissing without answering, what the view does after an answer (next item?), whether an answered item can be seen again.
- **Screen:** yes.
- **Suggested answer:** Oldest first within Priority; one row per request; no dismiss (answer or archive the Task); after answering, move to the next item.
- **Size:** M

### GAP-62: How does the Board treat disabled Stages, Done and archived Tasks? (S)
- **Area:** Board. Spec 8.6.
- **Why open:** Not addressed; Done grows until archived by hand [KRI-52].
- **Screen:** yes.
- **Suggested answer:** Hide disabled Stages; Done shows the last 7 days with “Show all”; archived never shown.
- **Size:** S

### GAP-63: Can the human edit or delete their own Comments, and attach files? (S)
- **Area:** Comments. Spec 8.4.
- **Why open:** Agents attach with `ted comment --attach` [KRI-11]; nothing for the human. Once a Comment reached a Run, editing it is odd.
- **Screen:** yes.
- **Suggested answer:** Drag-and-drop attachments; no edit or delete after the agent has read the Comment.
- **Size:** S

### GAP-64: Which events beyond Inbox items notify? (S)
- **Area:** Notifications. Spec 8.11.
- **Why open:** Only “one notification per Inbox item” [KRI-20]. Task Done, usage limit, Run failed, Automation failed aren’t covered; no per-Factory mute or quiet hours.
- **Screen:** yes (settings).
- **Suggested answer:** Inbox items only, plus problems that stop all work (GAP-60). Rely on the OS’s Do Not Disturb.
- **Size:** S

### GAP-65: Where does the human find archived Tasks? (S)
- **Area:** UI. Spec 4.18.
- **Why open:** Archive and unarchive exist [KRI-11]; no place to browse archived Tasks.
- **Screen:** yes.
- **Suggested answer:** An Archived filter in the List.
- **Size:** S

### GAP-66: What does the menu-bar (tray) menu contain, and what about Linux desktops without a tray? (S)
- **Area:** UI. Spec 2.4.
- **Why open:** Only “Quit TED completely” and an unread count are decided [KRI-11, KRI-20]. GNOME has no tray by default.
- **Screen:** yes.
- **Suggested answer:** Inbox count, working Runs count, Open TED, Pause new Runs, Quit TED completely. Without a tray, closing the window keeps the daemon running and reopening the app reattaches.
- **Size:** S

### GAP-67: What is the full list of Comment kinds? (S)
- **Area:** Comments, store. Spec 8.3.
- **Why open:** KRI-11 defined question, review, sign-off. Later tickets add rounds [KRI-19], permission requests [KRI-20], design reviews (an Inbox row kind) [KRI-13], ask after looping [KRI-16], and plain Comments. The store needs one enum.
- **Screen:** no.
- **Suggested answer:** plain, question, round, review (design review is a review in Design), sign-off, permission.
- **Size:** S

---

## 9. Automations and intake

### GAP-68: What does the Automations page and form look like, and what are the `ted automation` subcommands? (M)
- **Area:** Automations. Spec 9.1.
- **Why open:** KRI-20 lists the parts (cron or RRULE, timezone, missed runs, history with retries, prompt, agent, model, effort, templates) but no screen, no default timezone, no retry count, no enable/disable, no “Run now”, and no CLI syntax.
- **Screen:** yes.
- **Suggested answer:** A list with name, schedule in words, next firing, last result, on/off; a form with template picker, prompt, schedule, agent/model/effort; history rows with retry. `ted automation list | create | run | enable | disable`.
- **Size:** M

### GAP-69: How long does an Automation Run live, and where do replies to its Comments go? (S)
- **Area:** Automations. Spec 9.1.
- **Why open:** It “posts Comments that show in the Inbox” [KRI-20]. If the Run has stopped, a reply has nowhere to go. No timeout.
- **Screen:** no.
- **Suggested answer:** The Run stays open while it waits, like a Task Lead, and stops when it reports done or at the next firing.
- **Size:** S

### GAP-70: What happens when a firing overlaps the previous one or the limit is full? (S)
- **Area:** Automations, queue. Spec 9.1.
- **Why open:** Automation Runs count toward the limit [KRI-15]; queue order is for Tasks.
- **Screen:** no.
- **Suggested answer:** Skip a firing while the previous Run is still active; otherwise queue it ahead of new Tasks.
- **Size:** S

### GAP-71: Are Automations stored in TED’s store or committed to the repo? (S)
- **Area:** Automations. Spec 9.1.
- **Why open:** They’re set up in a page and with `ted automation` [KRI-20], not in `workflow.yaml`. Committing them would share them with a future team.
- **Screen:** no.
- **Suggested answer:** TED’s store (per machine), since running across machines is later.
- **Size:** S

### GAP-72: What happens when the human pastes a Linear URL with no Linear key set? (S)
- **Area:** Intake. Spec 9.2.
- **Why open:** Fetching needs a Linear API key [KRI-20]. No fallback.
- **Screen:** yes (small).
- **Suggested answer:** Create the Task with the URL as source and description, and show “Add a Linear key to fill in title and branch”.
- **Size:** S

---

## 10. Planning Runs

### GAP-73: How does a Planning Run end, and can it be renamed or deleted? Which checkout does it read? (S)
- **Area:** Planning. Spec 8.8.
- **Why open:** It ends “by proposing Tasks” [KRI-19]. Abandoning one, Request changes on its proposal, renaming, deleting from the Plans list, and whether it reads the default branch clone or a worktree aren’t said.
- **Screen:** yes (Plans list actions).
- **Suggested answer:** Stops after Approve or on Stop; title set by the agent, renamable; delete like a Task; reads a read-only checkout of the default branch.
- **Size:** S

---

## 11. Release

### GAP-74: Which Linux packages ship, and how do deb and rpm update? (S)
- **Area:** Release. Spec 10.
- **Why open:** The map lists the choice as release work [KRI-8]. electron-updater auto-updates AppImage; deb and rpm normally update through the package manager, which conflicts with “one stable auto-update channel” [KRI-20].
- **Screen:** no.
- **Suggested answer:** Ship AppImage (auto-update) and deb; deb shows “update available” with a download link.
- **Size:** S

### GAP-75: Where do secrets go on Linux without a Secret Service? (S)
- **Area:** Release, Settings. Spec 2.5.
- **Why open:** Secrets go in the Keychain or Secret Service [KRI-20]. Minimal Linux setups have neither.
- **Screen:** no.
- **Suggested answer:** Refuse to store the Linear key and explain; GitHub uses `gh`’s own storage (GAP-49).
- **Size:** S

---

## Proposals to confirm

These are the two items the map left to the spec [KRI-8, “Not yet specified”]. The spec states them as proposals.

- **P-1: Visual detail and the Plans list / planning chat.** Spec 8.1 and 8.8. Visual detail beyond layout, typography and density is left to build. Plans sits in the sidebar under each Factory; planning chat opens in the middle pane laid out like a Task thread, with proposed Tasks in the right pane.
- **P-2: Agent needs a simulator with all slots booted.** Spec 7.4. An Inbox Comment from the Run, shaped like a permission request: lists booted simulators by Task, longest-unused pre-selected, **Shut down <Task>’s and run** / **Deny**; the Run waits.

---

## Contradictions between tickets

### Not settled (need the human)

- **C-1: Version restart: resume or fresh Run.** KRI-20 and the glossary: restart resumes the same conversation and is the same Run. KRI-11: TED never resumes an old session. KRI-17 and the map: a version restart starts a fresh Run from the brief. → GAP-11.
- **C-2: Shape of `repos`.** KRI-12: list of `{name, remote}`, omitted for single-repo Factories. KRI-18: map keyed by repo name with `apps`. → GAP-23.
- **C-3: Local folder or TED clone.** KRI-12: no local paths, clones in `~/.ted/`. KRI-20: asks for macOS folder access “when a repo is added from” a protected folder. → GAP-24.
- **C-4: Custom Stages.** KRI-12: a custom Stage is a new file plus an `order` entry. KRI-50: v1 ships the built-in set only. → GAP-28.
- **C-5: Setup Task and the limit.** KRI-22: starts “at once” yet “counts toward the limit”. → GAP-44.
- **C-6: GitHub credentials.** KRI-20: GitHub token in the Keychain. KRI-52: merges with `gh` under the user’s own login. → GAP-49.

### Settled by “later wins” (recorded in the spec)

- Validate `max_back` 3 [KRI-12] → 5 with `loop_check: 3` [KRI-16].
- `ted run handoff` [KRI-11] → dropped [KRI-17].
- Factory setup as a Run outside any Task [KRI-16] → a Task [KRI-22].
- Simulator: TED silently shuts down the oldest [KRI-18] → asks first [KRI-23].
- Task Lead merges [KRI-12 outline] → TED merges [KRI-52].
- Request changes at a Gate keeps the Task in the Stage [KRI-12] → at Review the Task Lead picks Work or Design [KRI-18].
- Factory settings Override/Reset write at once [KRI-12] → collect until Save, which opens a PR [KRI-22].
- Claude Code through the Agent SDK [KRI-20] → CLI only for subscription users; SDK only with an API key [KRI-21, ADR 0004].
- “Done” as a status [KRI-11] → Done is a holding Stage [KRI-52].
- Windows and NSIS installers [KRI-10] → macOS and Linux only [KRI-14].
