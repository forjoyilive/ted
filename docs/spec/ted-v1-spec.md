# TED v1 spec (draft)

Status: draft for review, 2026-11-08. Built from the map [KRI-8](https://linear.app/kriyadesign/issue/KRI-8), the resolution comments on KRI-9 to KRI-23 and KRI-52, `GLOSSARY.md`, and ADRs 0001–0005.

How to read it:

- Each decision ends with its source in brackets, e.g. [KRI-18, changed by KRI-23]. When a later ticket changed an earlier one, the later one is what this spec states.
- “GAP-n” marks a product decision nobody has made yet. Each is logged in `ted-v1-gaps.md` with a suggested answer.
- “PROPOSAL” marks the two items the map left for the spec to settle. The human must confirm them.
- Terms are the glossary’s. Capitalized words (Task, Run, Stage, Gate, …) mean exactly what `GLOSSARY.md` says.

---

## 1. Overview and scope

TED (“Totally Excellent Development”) is a desktop app for running software factories. Agents carry development Tasks through a configurable Workflow of Stages. The human steers through the Inbox and Comments. [KRI-8]

- **Solo.** One user per machine. [KRI-8]
- **Desktop only.** macOS and Linux. No Windows, no phone. [KRI-14, KRI-8]
- **Multiplayer is not built, only not locked out.** The store is built for sync from day one, so adding a sync backend later needs no change to the data model. [KRI-8, KRI-9]
- **One machine.** Each machine has its own daemon, limit on working Runs and queue. Nothing in v1 may assume there is only one machine. [KRI-15]
- **Agents in v1:** Claude Code and Codex, run through the user’s own installed CLIs. [KRI-14, KRI-21]
- **Code host:** GitHub only. [KRI-20]
- **Language:** English only. [KRI-20]
- TED is built standalone. It ports logic from agent-orchestrator (agent launch flags, PTY handling, worktree setup, sending CI failures and review comments to agents) and copies React UI code under Apache-2.0, keeping its NOTICE and marking changed files. [KRI-14, ADR 0003]

---

## 2. Architecture

### 2.1 Processes

- **Daemon.** A headless TypeScript process on Node. It owns agent processes, PTYs, the store, Apps, simulators, GitHub watching, Automations, and the CLI/MCP server. It listens on loopback only (HTTP + SSE + WebSocket). [KRI-10] (GAP-22: how local clients authenticate to it.)
- The daemon ships inside the Electron app and runs with `ELECTRON_RUN_AS_NODE`, so there is one runtime to sign and update. [KRI-10]
- Agents run in detached per-Run hosts, so closing the window or updating the daemon does not stop them. [KRI-10]
- **Electron app.** A client only. It talks to the daemon and nothing else. It renders the Inbox, Views, chats (xterm.js for shells), and diffs. Web Apps open in the default browser in v1. [KRI-10, KRI-18]
- Tauri 2 is the runner-up. Because the app is only a client, switching later is a contained change. [KRI-10]

### 2.2 Store

- **LiveStore**: an event log in SQLite, offline-first, with a swappable sync backend. Version 0.5.0, beta. PowerSync is the fallback if LiveStore hits blockers. [KRI-9]
- One process must own the store: the daemon. The app, CLI and MCP server read and write through the daemon. [KRI-9]
- Attachments: file metadata in the store; bytes on disk, addressed by content hash. [KRI-9]
- Tasks, Comments, the Inbox, Runs, Automations and Planning Runs live in the store. Neither Tasks nor the Workflow need to work without the app. [KRI-8]
- Worktrees, clones, the store and logs live under `~/.ted/`, outside the repos. [KRI-8, KRI-12]
- GAP-19 (migrations, backup, export). GAP-20 (retention of transcripts and logs). GAP-18 (disk usage and disk full).

### 2.3 The `ted` CLI and MCP server

- The `ted` CLI is the contract between agents and TED. An MCP server mirrors it one to one. Both send requests to the daemon. [KRI-11]
- If the daemon isn’t running, `ted` starts it. A daemon started this way exits after a minute with nothing to do. [KRI-11] (GAP-6, GAP-17: how this interacts with starting at login and with Automations.)
- TED sets `TED_TASK` and `TED_RUN` in each Run’s environment, so commands need no IDs. Outside a Run, commands take `--task`. [KRI-11]
- The full command set is in section 5.4.

### 2.4 Quitting, closing and updates

- Closing the window keeps Runs going behind a menu-bar icon (tray on Linux). [KRI-11]
- **Quit** with active Runs asks: **Keep running in the background** (default, can be remembered) / **Stop them and quit** / **Cancel**. [KRI-11]
- Quit with nothing running quits the daemon too. [KRI-11] (GAP-17: scheduled Automations.)
- The menu-bar icon has **Quit TED completely**. [KRI-11] (GAP-66: the rest of its menu.)
- Runs survive restarting or updating the app, because the daemon owns them. [KRI-20]
- App updates restart the daemon only when no Runs are active. [KRI-11] (GAP-21.)
- One stable auto-update channel. [KRI-20]
- **Stay Awake** while any Run is active, on by default (`caffeinate` on macOS, `systemd-inhibit` on Linux). [KRI-20]
- Daemon crash: GAP-16.

### 2.5 OS permissions

Asked for only when needed. [KRI-20]

- Notifications: when the first Inbox item arrives.
- Protected macOS folders (Documents, Desktop, Downloads, iCloud Drive): when a repo is added from one. (See GAP-24: the tickets disagree on whether repos are added from local folders.)
- Secrets (Linear API key, GitHub token): in the macOS Keychain or the Linux Secret Service. (GAP-49: GitHub may use `gh`’s login instead. GAP-75: no Secret Service on Linux.)
- Never requested: Accessibility, Screen Recording, Full Disk Access, microphone, camera.

---

## 3. Factory and Workflow

### 3.1 Factory

- A **Factory** is a largely automated process that carries Tasks from creation to merge for one product. It may span several repos. [KRI-8]
- The first repo is the **primary repo**. The Factory’s overrides live in its `.ted/` folder, so they are versioned and reviewable. [KRI-8, KRI-12]
- A repo can be the primary repo of only one Factory, matched by remote URL. The Add Factory form refuses a second. A repo can be a secondary repo in any number of Factories, shown with an “also used by Factory X” note. [KRI-22]
- A Factory with one repo and no overrides needs no `.ted/` folder. Its identity lives in TED’s store. [KRI-12]
- Running the Workflow without TED is not a goal. TED never writes to `AGENTS.md`. [ADR 0001, KRI-12]
- Agents read the repo’s own `AGENTS.md` / `CLAUDE.md`. TED has no rules-file feature. [KRI-20]
- Renaming, removing a Factory, removing a repo: GAP-27. Task ID prefix (prototypes show “NB-44”): GAP-30.

### 3.2 Layers

Three layers, each with the same layout (`workflow.yaml` + `stages/*.md`): [KRI-12, ADR 0002]

1. **TED defaults**, shipped inside the app. Readable in settings, not editable.
2. **Library**, in `~/.ted/library/`. Applies to all of the user’s Factories.
3. **Factory**, in `.ted/` in the primary repo.

Rules:

- The more specific layer wins. [KRI-12]
- TED resolves the layers each time a Task enters a Stage. A Library edit or a TED update can change a running Task, starting at its next Stage. TED records which file and layer each Stage entry used, and shows it in the Task’s history. [ADR 0002, KRI-12]
- `order` is all or nothing: the most specific layer that has one wins outright. [KRI-12]
- `stages.<id>` settings merge key by key across layers. [KRI-12]
- A Stage file in a more specific layer replaces the one with the same id as a whole. [KRI-12]
- Every setting, including Gates and whether Design is on at all, can be changed in the Library and per Factory. [KRI-12] Exception: a setup Task always has the Design and Review Gates on. [KRI-22]

### 3.3 `workflow.yaml`

Every key that has been decided:

| Key | Where | Meaning | Source |
|---|---|---|---|
| `version` | any layer | Schema version, `1`. | KRI-12 |
| `lead` | any layer | The Task Lead’s agent: `claude` or `codex`, or an object `{agent: claude, model: opus}`. One Task Lead Run spans all Stages; there is no agent per Stage. | KRI-12 |
| `reviewer` | any layer, “next to `lead`” | `codex`, `claude` or `same`. Default: the other kind when both are installed, else `same`. | KRI-16 |
| `repos` | Factory layer only | The Factory’s repos; first is the primary repo. `name` and `remote`, no local paths. Leave it out for a single-repo Factory. Multi-repo Factories keep it in `.ted/workflow.yaml`. | KRI-12 |
| `repos.*.apps` | Factory | Apps for that repo (see 7.3). | KRI-18 |
| `repos.*.merge_method` | Factory | `squash` (default), `merge` or `rebase`. | KRI-52 |
| per-repo worktree settings | Factory | Default branch, env vars, symlinked files (e.g. `.env`), setup and teardown scripts. Key names not decided: GAP-25. | KRI-20 |
| `order` | any layer | Ordered list of Stage ids. | KRI-12 |
| `max_working_runs` | any layer, merged | Optional per-Factory cap on working Runs. Unset by default. | KRI-15 |
| `permissions` | Factory | One setting that changes the agents’ permission mode. Bypass only when set here explicitly. Values not decided: GAP-9. | KRI-20 |
| `stages.<id>.enabled` | any layer | `false` turns a Stage off without editing `order`. The settings toggle writes it. | KRI-12 |
| `stages.<id>.gate` | any layer | `true` puts a Gate at the end of the Stage. | KRI-12 |
| `stages.<id>.max_back` | any layer | Limit on send-backs from this Stage. Going over turns `back` into `ask`; the count resets when the human answers. | KRI-12 |
| `stages.<id>.based_on` | Factory | Hash of the inherited Stage file an override was copied from (see 3.8). | KRI-22 |
| `stages.clarify.depth` | any layer | `auto` (default), `none`, `few`, `grilling`. | KRI-19 |
| `stages.validate.checks` | any layer | List of Checks (see 6.1). | KRI-16 |
| `stages.validate.loop_check` | any layer | Send-back count at which the loop check runs; default `3`; `false` turns it off. | KRI-16 |
| `stages.merge.gate` | any layer | Off by default. | KRI-52 |
| `stages.merge.enabled` | any layer | On by default. | KRI-52 |

Defaults: Gates on Design and Review; Validate `max_back: 5`, `loop_check: 3`; Merge `max_back: 3`. [KRI-12, KRI-16 changed KRI-12’s 3 to 5, KRI-52] Other Stages: GAP-33.

Not in `workflow.yaml`: the machine’s limit on working Runs, because the file is committed and shared. [KRI-15] Model and effort for Runs other than the Task Lead: GAP-1.

**Open contradiction on the shape of `repos`.** KRI-12 shows `repos` as a list of `{name, remote}`. KRI-18 shows it as a map keyed by repo name with `apps` under each. KRI-12 also says to leave `repos` out for a single-repo Factory, which leaves no place for that repo’s `apps` and `merge_method`. GAP-23. The example below uses the list form and is not final.

Example (shape of `repos` pending GAP-23; per-repo worktree keys pending GAP-25):

```yaml
version: 1
lead: { agent: claude, model: opus }
reviewer: codex
max_working_runs: 3
repos:
  - name: app
    remote: git@github.com:kriya/app.git
    merge_method: squash
    apps:
      - name: Web
        run: "npm run dev -- --port ${PORT}"
        url: "http://localhost:${PORT}"
        ready: url
      - name: iPhone
        kind: ios-simulator
        device: "iPhone 17"
        run: "npx expo run:ios --device ${TED_SIMULATOR_UDID}"
  - name: api
    remote: git@github.com:kriya/api.git
order: [backlog, intake, clarify, design, work, validate, review, merge, done]
stages:
  clarify:  { depth: auto }
  design:   { gate: true }
  validate:
    max_back: 5
    loop_check: 3
    checks:
      - { name: Typecheck, run: "npm run typecheck" }
      - { name: Tests, run: "npm test", repo: api, timeout: 10m }
  review:   { gate: true, based_on: 3f9c2e1 }
  merge:    { enabled: true, gate: false, max_back: 3 }
```

Whether `backlog` and `done` appear in `order`, and whether they can move or be turned off beyond `backlog: {enabled: false}`, is GAP-32. [Backlog is “first in `order`” per KRI-15; Done is “at the end of the Workflow” per KRI-52.]

### 3.4 Stage files

- `stages/<id>.md`. The Stage id is the filename, title-cased for display. [KRI-12]
- Plain Markdown, no frontmatter. Suggested headings, not checked by TED: Goal, Skip when, Steps, Done when, Send back when, Ask the human when. [KRI-12]
- Stage files hold plain instructions (“ask the human”, “report the outcome”). At Run start TED adds a preamble that maps these intents to `ted` commands and points to `ted help`. Nothing needs installing. [KRI-11, ADR 0001]
- On every Stage change, TED hands the live Task Lead Run the next Stage file. [KRI-11]
- The human never sees Stage file names or `workflow.yaml` outside the Factory’s settings. The thread shows plain events such as “You approved · Task moved to Design.” [KRI-11]
- Holding Stages (Backlog, Done) have no Stage file. [Glossary]
- v1 ships the built-in Stages only: Backlog, Intake, Clarify, Design, Work, Validate, Review, Merge, Done. Custom Stage types are later (KRI-50). KRI-12 said a custom Stage is a new file plus an entry in `order`; KRI-50 says v1 ships the built-in set only. GAP-28.

### 3.5 Library

- The user’s own Stage files and Workflow settings in `~/.ted/library/`. Overrides TED’s defaults; overridden by a Factory. [Glossary, KRI-12]
- Library edits in app Settings write straight to `~/.ted/library/`, with no pull request. [KRI-22]
- The app Settings screen edits the Library’s `reviewer`. [KRI-16]
- Library sharing and versioning are later (KRI-49).
- How Library Stage files are edited in the UI: GAP-29.

### 3.6 Factory notes

- `.ted/notes.md`. Facts about the product only: how to run it, conventions, risky areas. Suggested headings: Product, Repos, Running locally, Conventions, Risky areas. [KRI-22]
- Given to every Run in the Factory. [KRI-22]
- Never instructions for a Stage; those belong in Stage files. [KRI-22]

### 3.7 Factory setup

Factory setup is a Task: the Factory’s first Task, run through the inherited Workflow. [KRI-22, ADR 0005; replaces the setup Run outside any Task from KRI-16]

**Add Factory form** (fields beyond these: GAP-24)

- The human picks the repos (first = primary). Setup does not propose repos; it may note a sign that one is missing. [KRI-22]
- **Show the tutorial** checkbox, on by default only for the user’s first Factory. [KRI-22]
- Before setup starts, TED itself (no agent) checks clone and GitHub access. Problems show in the form. [KRI-22]
- Checking that `claude` / `codex` are installed and signed in belongs to TED’s first launch, not this form. [KRI-22] (GAP-2.)

**The setup Task**

- Starts at once with Priority Urgent, ahead of the queue, and counts toward the limit on working Runs. [KRI-22] (GAP-44: whether it waits for a free slot.)
- Design and Review Gates are always on, even if the Library turns them off. [KRI-22]
- **Intake:** filled in by TED.
- **Clarify** at grilling depth: asks how the human works: which Stages, where Gates go, merge habits.
- **Design:** the full proposal as the Design brief. Changes go through Request changes at the Design Gate. No per-item checkboxes.
- **Work:** writes the files on a branch.
- **Validate:** runs the proposed Checks and starts the Apps on that branch.
- **Review:** sign-off. **Merge** follows. [KRI-22]
- Setup tries each proposed Check on the default branch and tries to start each App. It reports pass or fail and how long each took, and proposes failures unticked with the reason. [KRI-22]
- **Tutorial:** when on, the Task Lead posts a short Comment as each Stage starts: what the Stage does, what it will do here, and where to change it. [KRI-22]

**What setup writes**

- Factory notes (`.ted/notes.md`). [KRI-22]
- Stage overrides (`.ted/stages/<id>.md`): full copies edited for this product, only for Stages whose steps really change. Always `validate.md`, plus others when setup finds a reason or the human asks (e.g. `merge.md` for merge habits). [KRI-22]
- `workflow.yaml`: Checks, `apps`, Stage settings (on/off, Gate, `max_back`, Clarify depth). [KRI-22]

**Around setup**

- The Factory can be used during setup. Tasks use the inherited layers until setup merges. [KRI-22, ADR 0005]
- While a setup Task is open, every Task created or started shows “Setup isn’t finished. This Task will use TED’s defaults”, with **Start anyway** and **Open setup Task**. [KRI-22]
- If setup never finished and no setup Task is open, the first Task started shows “This Factory hasn’t been set up”, with **Start anyway** and **New setup Task**. [KRI-22]
- These notices never block and are never Inbox items. [KRI-22]
- A repo that already has `.ted/` gets its setup Task in Backlog, not started. [KRI-22]
- No Checks: Validate runs on judgment alone. “No Checks” shows in settings and on the Validate row, with a **New setup Task** link. Never an Inbox item. [KRI-22]
- **New setup Task** is always in the Factory’s settings. A banner on the Factory page suggests one when `repos` changes or a Check’s command isn’t found (exit 127). A later setup Task proposes changes to the current files, shown as a diff. [KRI-22] (GAP-55: what the “Factory page” is.)

### 3.8 Factory settings panel

- Shows the effective Workflow: each Stage in order with its Gate, on/off state, `max_back`, and Clarify depth, each tagged **Default**, **Library** or **Factory**. [KRI-12, KRI-22]
- Edits Stages (order, on/off, Gate, `max_back`, Clarify depth), Checks (rows with **Run now**), Apps, Factory notes (Markdown editor) and repos. [KRI-22]
- Each Stage entry has **Override for this Factory** (copies the file into `.ted/`) and **Reset to inherited** (deletes the Factory copy). [KRI-12] These collect with other edits until Save. [KRI-22 changed KRI-12, where they acted at once]
- The files on the default branch stay the source of truth. [KRI-22]
- Edits collect until **Save**, which commits them on a branch and opens one pull request, “Update TED settings”: **Save and merge** (default) or **Save as pull request**. [KRI-22]
- **Save and merge** merges through the same GitHub path as Task merges (7.5), with no Task and no Validate. **Save** leaves the pull request open. [KRI-52]
- With the Review Gate off, the panel warns that Merge runs right after Validate. [KRI-52]
- **Drift:** when TED creates an override it writes `based_on: <hash>` under that Stage. When the inherited file changes, the Stage’s row shows **Inherited version changed** with a diff and three choices: **Keep mine** (updates `based_on`), **Use inherited** (Reset), **Merge with an agent** (a small Task that opens a pull request). Never in the Inbox. [KRI-22] (GAP-31.)
- Invalid `workflow.yaml` or a broken Stage file: GAP-26.

---

## 4. Tasks and Stages

### 4.1 Task basics

- A Task is a unit of work moving through a Workflow. Once code exists, it corresponds to one pull request per repo it touches. [Glossary, KRI-8, KRI-13]
- Fields decided: title, description (versioned, with the first version kept as **Original request**), Priority, hand-set rank, Clarify depth (Auto, None, Few, Grill), source URL, blocked-by links, Task brief (versioned), Stage history. [KRI-15, KRI-19, KRI-20, KRI-11]
- Branch: Linear’s suggested branch name when created from a Linear URL, else a slug of the title. [KRI-20] (GAP-42.)
- Which repos a Task touches: Intake guesses. [KRI-12] (GAP-41.)
- Creating a Task: by hand (typing, or pasting a Linear URL), by an Automation, by Split it, by a Planning Run, or as a Follow-up. The human creating Tasks by hand is the main way work enters. [KRI-20, KRI-19, KRI-52] New Task dialog: GAP-35. Editing a Task after creation: GAP-36.

### 4.2 Where Tasks land and how they start

- **Created by hand:** Intake, with a **Start now** checkbox in the create dialog, on by default. [KRI-15] (GAP-39: where it lands when unchecked.)
- **Created by an Automation:** Backlog, unless it passes `ted task create --start`. The Automation’s prompt holds the rule. [KRI-15]
- `--blocked-by` always puts the Task in Backlog. [KRI-15]
- **Follow-up:** skips Backlog; still subject to the limit on working Runs. [KRI-52]
- **Start** (leaves Backlog): play button on the card, dragging the card to Intake, `ted task start <id>`, or an Automation. [KRI-15]
- A Task also leaves Backlog on its own when every Task blocking it has merged. [KRI-15]
- **Un-start:** dragging a Queued card back to Backlog. A Task that has started can’t go back to Backlog. [KRI-15]
- No snooze-until-a-date in v1 (KRI-42).

### 4.3 Limits, queue and order

- **Queued** is a status, not a Stage: a started Task waiting at the start of Intake for a free slot, with no Run. [KRI-15]
- **Max working Runs** per machine, in app Settings, default 6. [KRI-15]
- Optional per-Factory `max_working_runs` in `workflow.yaml`. A Task starts only when both limits have room. [KRI-15]
- Both limits count working Runs: Task Leads, sub-agents, Automation Runs and active Planning Runs. They don’t count Runs waiting on the human, or a Task Lead that is only waiting for its sub-agents. Apps don’t count. [KRI-15, KRI-19, KRI-18]
- When a slot frees, waiting sub-agent requests start before new Tasks. [KRI-15]
- The limit on working Runs per machine always stays on (plan limits). [ADR 0004]
- Order: Priority (Urgent, High, Medium, Low, None), then hand-set rank. The queue is shared across all Factories on the machine. A new Task goes to the bottom of its Priority group. [KRI-15]
- Priority is set by hand, copied from Linear, or passed by an Automation with `--priority`. [KRI-15]

### 4.4 Statuses

A status is shown alongside the Stage; it is not a Stage. Decided statuses and markers:

| Status / marker | Meaning | Source |
|---|---|---|
| Working | A Run on the Task is working. | KRI-11 |
| Waiting on you | An Inbox item on this Task is unanswered. | KRI-11 |
| Idle | No Run is working and nothing waits on the human. | KRI-11 |
| Queued | Started, waiting for a slot. Badge “Queued · 2nd” at the top of Intake. | KRI-11, KRI-15 |
| Failed | A Run failed. Trigger not defined: GAP-12. | KRI-11 |
| Blocked (badge) | Waiting on another Task to merge; names the blocking Task, clickable. | KRI-15 |
| Needs planning (marker) | Returned to Backlog by Plan it outside TED; filterable; clears on start. | KRI-19 |
| Waiting for merge | Signed off with Merge turned off; the human merges on GitHub. | KRI-52 |
| Partly merged | Multi-repo merge failed partway; Task stays in Merge. | KRI-52 |
| Waiting for GitHub review | A required teammate review on GitHub. Not an Inbox item. | KRI-52 |
| Activity line | One line of free text set by the agent with `ted status "…"`. | KRI-11 |

KRI-11 also listed “Done” as a status. KRI-52 later made Done a holding Stage; this spec treats Done as a Stage only. The full status model (precedence when several apply, how each looks on cards, rows and the header, usage-limit and blocked-by-permission states): GAP-34.

Run icons: one icon per Run (Task Lead first, then sub-agents, “+N” past three), each working, idle, stopped or failed. [KRI-11]

### 4.5 Gates, outcomes and send-backs (all Stages)

- The Task Lead reports the end of a Stage with `ted outcome advance | back --to <Stage> | ask`. TED picks the next Stage from `workflow.yaml`. `back` goes only to an earlier Stage. Agents cannot skip a Gate. [KRI-11]
- Every `ted outcome back` needs `--findings <file>` (Markdown). [KRI-16]
- A Gate comes at the end of its Stage: the Task Lead writes the Task brief and posts a sign-off. **Approve** moves the Task on. **Request changes** keeps it in the Stage. [KRI-12] At Review, Request changes goes to the Task Lead, who picks Work or Design (4.12). [KRI-18 changed KRI-12 for Review]
- A Stage that skips itself skips its Gate. [KRI-12]
- `max_back` sits on the Stage that sends back. Going over turns `back` into `ask`; the count resets when the human answers. [KRI-12]
- The Task brief is written at every Gate. [KRI-11, KRI-17]
- Stage history in Task details shows past Stages with time spent, the current Stage, skipped Stages struck through, and future Stages greyed. [KRI-13]

### 4.6 Backlog

- Built-in holding Stage, first in `order`. No Stage file, no Run, no tokens. [KRI-15]
- Can be turned off with `enabled: false`; then every new Task starts at Intake. [KRI-15]
- For Tasks that are blocked or not wanted yet. “Not clear yet” is not a reason; Clarify handles that. [KRI-15]

### 4.7 Intake

- Turns what came in into a Task with a clear title and description: restates the request, links sources, guesses which repos it touches. [KRI-12]
- Queued Tasks wait at the start of Intake. [KRI-15]
- For a setup Task, TED fills Intake in. [KRI-22]

### 4.8 Clarify

- Removes ambiguity before Design. [KRI-12]
- **Size check first.** Clarify’s first step checks whether the Task fits one pull request. If not, it asks with choices: **Plan in chat**, **Split it**, **Plan it outside TED**, **Grill anyway**. Nothing else checks size; turning Clarify off turns the check off. [KRI-19]
- **Depth:** none, few, grilling. The Task Lead picks by default and posts its pick and why as a one-line event. The human can set it on the Task (Auto, None, Few, Grill) beforehand or change it by Comment. `stages.clarify.depth` sets a default. [KRI-19]
- **Rounds.** A round is one Comment holding all its questions, answered in one go. Each question has its recommended answer pre-filled, optional choice buttons and a text box. The round has **Accept all recommended**. Agents post rounds with `ted ask --round <file>`; TED renders them. In the Inbox a round is one item, e.g. “Clarify · Round 2 · 4 questions”. [KRI-19]
- **Talk it through** on an unanswered round opens a live chat with the Task Lead. When it ends, the Task Lead posts a Comment summarizing the questions and decisions. [KRI-19]
- **Few:** one round, no sign-off; the Task moves on when answered. The Task Lead may switch to grilling (one-line event) if answers raise something bigger. [KRI-19]
- **Grilling** ends with a sign-off Comment summarizing what was decided. Approve moves on; Request changes starts another round. It acts as a Gate that is on only at grilling depth. Decisions go under the brief’s Decisions so far. [KRI-19]
- Wayfinder is not part of Clarify in v1 (KRI-48). [KRI-19]

**Split it** [KRI-19]

- The Task Lead proposes the pieces (title, one-line scope, which block which) as a sign-off. Approve creates them; Request changes revises the list.
- The original Task becomes the first piece. It keeps its thread and history, narrows its title and description, and continues through the Workflow.
- Other pieces start in Backlog. Blocked pieces start when their blockers merge; the rest wait for the human. Each links back to the original.
- Task details shows a collapsed **Original request** and links to the description history. The Task Lead gets the original next to the current description at Run start.

**Plan in chat** opens a Planning Run from this Task (8.8). [KRI-19]

**Plan it outside TED** [KRI-19]

- The Task returns to Backlog with a **Needs planning** marker. The Task Lead posts why it judged the Task too big and what a plan needs to settle, then its Run stops.
- On restart, Clarify runs as usual and reads whatever the plan left in the description. The marker clears on start.

### 4.9 Design

- Decides how to build it. Writes the approach in the brief, with a prototype or Figma link for UI work. Skips itself for small, obvious changes. Gate on by default. [KRI-12]
- A design review shows screenshots, video, an embedded interactive prototype and a Figma link inside the request card. [KRI-13]
- Request changes keeps the Task in Design. [KRI-12]

### 4.10 Work

- Builds on the Task’s branch, with tests, and sub-agents for parallel pieces where useful. [KRI-12]
- Work can run `ted checks` early. [KRI-16]
- CI failures, review comments and merge conflicts from GitHub go to the Task Lead’s open Run, or to a fresh Run started from the Task brief. [KRI-20]

### 4.11 Validate

See section 6. Sends back to Work with Findings. `max_back: 5`, loop check at 3. [KRI-16]

### 4.12 Review

- The Task Lead opens or updates the pull request(s) and writes the brief: what changed, how it was checked, what to try. [KRI-12]
- Gate on by default. The sign-off card is described in 7.1. [KRI-12, KRI-18]
- **Request changes:** the human’s text plus any diff line comments drafted in the Changes panel go to the Task Lead’s open Run as one Comment. The Task Lead decides whether the Task goes back to Work or to Design. The fix always passes through Validate again and returns with a new sign-off request. A send-back from Review resets Validate’s `max_back` count. [KRI-18]
- Default Review Stage file tells the Task Lead to start reviewer sub-agents, with two or three of agent-orchestrator’s reviewer prompts as suggestions. No separate reviewer catalog. [KRI-20]
- TED never posts a GitHub approval. [KRI-18, KRI-52]

### 4.13 Merge

See 7.5. TED merges, not the Task Lead. [KRI-52, changed KRI-12’s outline where the Task Lead merged]

### 4.14 Done

- Holding Stage at the end of the Workflow. Nothing runs there. [KRI-52]
- On merge of every pull request: TED moves the Task to Done, stops the Task Lead’s Run (kept as history), stops the Apps, removes the worktree, and releases Tasks blocked on this one. [KRI-52]
- Done Tasks stay until archived by hand. Auto-archive is later (KRI-27). [KRI-52]
- A Done Task is never reopened. **Follow up** (4.17). [KRI-52]

### 4.15 Blockers

- Blocked-by links between Tasks. `--blocked-by` on create puts the Task in Backlog. [KRI-15]
- A Task leaves Backlog when every Task blocking it has merged. [KRI-15]
- **Blocked mid-flow:** when the Task Lead finds another Task must merge first, it adds the blocked-by link, writes the brief and stops its Run. The Task stays in its Stage with a Blocked badge. When the blocker merges, a fresh Run starts from the brief. [KRI-15]
- A Task counts as merged only when every pull request has merged. [KRI-52]
- How the human adds or removes blockers, cycles, and blockers that are archived or deleted: GAP-37.

### 4.16 Splits

Covered in 4.8. Planning Runs split the same way (8.8). [KRI-19]

### 4.17 Follow-ups

- **Follow up** on a Done Task (also offered when typing a Comment on a Done Task) creates a new Task linked to the original, starting from its Task brief. It skips Backlog and is still subject to the limit on working Runs. The Task Lead may skip Clarify and Design. [KRI-52]
- After sign-off but before merge, a Comment cancels the pending merge and counts as Request changes. [KRI-52]

### 4.18 Archive and delete

- **Archive** stops all Runs, keeps Comments, brief, branch and Conversations, removes the worktree, stops Apps, and deletes the Task’s simulator device. [KRI-11, KRI-18]
- **Unarchive** recreates the worktree from the branch and starts a fresh Task Lead Run from the brief. [KRI-11, KRI-17] (GAP-40: unarchiving a Done Task.)
- **Delete** removes the Task, its Runs and Conversations after a confirm. It leaves the branch and pull request alone. [KRI-11]
- Auto-delete of archived Tasks is later (KRI-27).
- Pausing or canceling a Task without archiving: GAP-38. Where archived Tasks are found: GAP-65.

---

## 5. Agents and Runs

### 5.1 Task Lead

- One Task Lead per Task. It carries the Task through its Stages, may start sub-agents, and writes the Task brief at each Gate. [Glossary, KRI-8]
- Its agent comes from `lead`. [KRI-12] Model and effort: GAP-1. Changing it on one Task: GAP-13.
- **One long Run** is the default; no fresh agent per Stage. Context-heavy work (exploration, implementation, review) goes to sub-agents, and the Task Lead keeps only their final messages. [KRI-17]
- The agents’ own compaction handles long context. `ted run handoff` is dropped from v1. [KRI-17, changed KRI-11]
- The Run stays open and idle while it waits for the human. It does not exit after asking. [KRI-11]
- Only the Task Lead reports outcomes, posts questions, reviews or sign-offs, and writes the brief. Sub-agents may post plain Comments. [KRI-11]

### 5.2 Sub-agents

- Started by the Task Lead: `ted run start --agent <kind> --prompt-file <file>`. The Task Lead picks the agent kind. [KRI-11, KRI-20] Model and effort: GAP-1. Cap per Task: GAP-14.
- Share the Task’s worktree by default; `--own-worktree` separates. [KRI-11]
- `ted run wait <id>` returns the final message. `ted run send <id>` sends follow-ups. [KRI-11]
- Don’t receive the human’s Comments. [KRI-11]
- The human can Stop a sub-agent. [KRI-11]

### 5.3 Runs

- A Run is one agent conversation: on a Task (Task Lead or sub-agent), for an Automation, or for planning. [Glossary]
- **Live chat** is the only view of a Run in v1: streaming messages, collapsible tool-call rows, edits expandable to diffs, send and interrupt. Port agent-orchestrator’s chat host (`adapters/chatdriver/`) and React chat components. No TUI. [KRI-20]
- Transport: Codex through `codex app-server`. Claude Code with a subscription through the CLI (an interactive PTY or `claude -p --output-format stream-json`); the Agent SDK only with an API key. [KRI-21 / ADR 0004, changed KRI-20 which said “Agent SDK / stream-json”]
- The Task thread (Comments) and a Run’s Conversation are separate views. Clicking a Run in Task details, or a Conversation tab, opens its chat in the middle pane. A message typed into a Run goes only to that Run and is not a Comment. [KRI-20]
- **Comments into Runs:** the human’s Comments go straight into the Task Lead’s live Run, queued in the agent’s own input if it is mid-turn. A Comment counts as read once the agent has started a turn with it. Agents’ Comments count as read when the human opens them. [KRI-11]
- **Stop** a Run. A stopped Run is read-only history, never resumed; work continues in a fresh Run. [KRI-11, Glossary]
- **Restart:** a manual action on an idle or waiting Run, plus an automatic restart of idle Runs onto a new Claude Code or Codex version (setting, on by default). [KRI-20]
  - **Open contradiction:** KRI-20 and the glossary say a restart resumes the same conversation (`claude --resume`, `codex resume` / `thread/resume`) and is still the same Run; TED passes `--mcp-config`, `--settings` and `--add-dir` again because Claude Code doesn’t restore them. KRI-11 says TED never resumes an old agent session, and KRI-17 and the map say a version restart starts a fresh Run from the brief. GAP-11.
- **Fresh Task Lead Run from the brief** (plus Comments since) when there is no live session to continue: after a crash or reboot, on unarchive, when a blocker merges for a Task blocked mid-flow, on restart after Plan it outside TED, and when GitHub events arrive with no open Run. [KRI-17, KRI-15, KRI-19, KRI-20] (Version restart: GAP-11.)
- Agent hooks for Claude Code and Codex tell TED whether a Run is working, idle, waiting or finished. [KRI-20] (GAP-15: whether TED touches the user’s agent config.)
- What makes a Run “failed”, and automatic retries: GAP-12.
- Cost and tokens are estimated from Conversations and a price list, per Run and totalled per Task. [KRI-20] Where they show: GAP-10. Token use per Run shows in Diagnostics. [KRI-17]

### 5.4 The `ted` command set

All commands decided so far. The MCP server mirrors them. [KRI-11 unless noted]

| Command | Purpose | Source |
|---|---|---|
| `ted help` | Command reference, named in the Run preamble. | KRI-11 |
| `ted outcome advance` | End the Stage and move on. | KRI-11 |
| `ted outcome back --to <Stage> --findings <file>` | Send back to an earlier Stage. | KRI-11, KRI-16 |
| `ted outcome ask` | Ask the human instead of moving. | KRI-11 |
| `ted comment [--attach <path>]` | Post a Comment, optionally with files copied into TED’s store. Kinds: question (with `--choice "…"` buttons), review, sign-off. | KRI-11 |
| `ted ask --round <file>` | Post a Clarify or planning round of structured questions. | KRI-19 |
| `ted brief write` | Write a new version of the Task brief. | KRI-11 |
| `ted status "…"` | Set the one-line activity text. | KRI-11 |
| `ted run start --agent <kind> --prompt-file <file> [--own-worktree]` | Start a sub-agent. | KRI-11 |
| `ted run wait <id>` | Wait for a sub-agent’s final message. | KRI-11 |
| `ted run send <id>` | Send a follow-up to a sub-agent. | KRI-11 |
| `ted task create [--start] [--priority <p>] [--source <url>] [--blocked-by <id>]` | Create a Task. `--source` refuses a second open or archived Task with the same source and returns the existing one. | KRI-15, KRI-20 |
| `ted task start <id>` | Start a Task from Backlog. | KRI-15 |
| `ted checks` | Run the Factory’s Checks now. | KRI-16 |
| `ted run-app` | Start an App or reuse the running instance. | KRI-18 |
| `ted app screenshot <app>` | Capture the simulator; saves a file to the Task. | KRI-18 |
| `ted app record <app> --start / --stop` | Record the simulator. | KRI-18 |
| `ted automation …` | Manage Automations. Subcommands not decided (GAP-68). | KRI-20 |
| `ted doctor` | Health checks. | KRI-20 |
| `ted status` | Daemon status (no argument). | KRI-20 |

`ted run handoff` is dropped. [KRI-17] Commands for blockers by an agent mid-flow (“adds the blocked-by link”, KRI-15) and for a sub-agent model or effort have no syntax yet: GAP-37, GAP-1.

Also: the daemon serves `/healthz`. [KRI-20]

### 5.5 Permission modes

- Default: Claude Code `auto` mode; Codex `workspace-write` sandbox with `on-request` approvals. [KRI-20]
- A Factory can change this with one `permissions` setting in `.ted/workflow.yaml`. Bypass only as an explicit Factory setting, never by default. [KRI-20] (GAP-9.)
- A permission request is a Comment from the Run with **Approve** / **Deny**. It shows in the Task thread, the Inbox, and as a row in the chat. A Run waiting on one shows as waiting. [KRI-20]

### 5.6 Task brief

- The Task Lead’s own summary of where a Task stands, stored with the Task, versioned, written with `ted brief write`, written at every Gate. [KRI-11, KRI-17]
- Fixed headings: Goal, Decisions so far, Current state (branch, what’s done, Checks status), Open questions, Next step. [KRI-17]
- Task details shows Goal and Next step, plus **Full brief**, which opens the whole brief in the middle pane. [KRI-23]

### 5.7 Run start

At Run start TED gives the agent:

- the preamble mapping plain intents to `ted` commands [KRI-11]
- the current Stage file [KRI-11]
- Factory notes [KRI-22]
- the original request next to the current description [KRI-19]
- the Task brief and Comments since, for a fresh Run [KRI-11]

Whether the human sees the preamble in the Conversation: GAP-15.

### 5.8 Terms of service (ADR 0004)

- Start the user’s installed, unmodified `claude` and `codex` binaries, as live sessions or headless. Never bundle, patch or wrap them. [ADR 0004, KRI-21]
- Sign-in is left to the CLIs (`claude login`, `codex login`) or the user’s own API key. TED has no sign-in screen and never reads, copies or stores tokens or keys. For sign-in, TED opens the CLI’s own login in a terminal. [ADR 0004, KRI-21]
- With a Claude subscription, use the CLI, not the Agent SDK. [ADR 0004]
- Remove `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` from child environments unless the user has chosen API-key billing. [ADR 0004, KRI-21] (GAP-4: how the user chooses.)
- Show which credential each Run uses. [KRI-21] (GAP-4.)
- Never pass `--bare`; opt out if it becomes the default for `-p` (KRI-45). [ADR 0004]
- Keep the limit on working Runs on, and show when an agent reports a usage limit. [ADR 0004] (GAP-7.)
- Keep each agent kind’s sign-in and start code behind one replaceable module. [ADR 0004]
- Before shipping to others: recheck Anthropic’s “third-party harness” rule, read OpenAI’s Terms of Use by hand (KRI-44), say “runs Claude Code” in plain text only, never resell usage. [ADR 0004, KRI-21]
- Users install and sign in to each CLI themselves; TED checks and explains how. Per-agent health shows installed, signed in, version. [ADR 0004, KRI-20] (GAP-2, GAP-8.)

---

## 6. Validation

### 6.1 Checks

- Optional commands in `stages.validate.checks`. Each has `name` and `run`, plus optional `repo` (default: primary repo) and `timeout`. Exit code 0 passes. [KRI-16]
- TED runs them itself in the worktree when a Task enters Validate, before the judgment steps. Any failure sends the Task straight back to Work with the output. A failed Check counts toward `max_back`. [KRI-16]
- Work can run `ted checks` early. [KRI-16]
- Settings panel rows have **Run now**. [KRI-22]
- No Checks: Validate runs on judgment alone, with a “No Checks” notice (3.7). [KRI-22]
- Exit 127 (command not found) triggers the New setup Task banner. [KRI-22]
- Order, parallelism, default timeout and environment: GAP-46. Checks for repos the Task didn’t change: GAP-48.

### 6.2 `validate.md`

- Suggested headings only. The default covers: run the project’s tests (and end-to-end tests where they exist); have the reviewer agent review the diff with no Work context; check against the description and the Design brief; for UI changes, take screenshots, judge them against what was wanted, and attach them as evidence. The goal is as much automated validation as possible. [KRI-16]
- Factory setup always writes a Factory `validate.md`: how to start the app, which flows to run, what “looks right” means here. [KRI-16, KRI-22]
- For web Apps, agents use their own browser tools in v1. [KRI-18]
- Pass = no blocking Findings. [KRI-16]

### 6.3 Findings

- A Finding is blocking or a note. Only blocking Findings send the Task back. Notes carry into the Review brief. [KRI-16]
- The thread shows “Validate sent this back to Work (round n of 5)” with the Findings under it. [KRI-16]

### 6.4 Reviewer

- `reviewer: codex | claude | same`. App Settings edits the Library value; a Factory can override. Default: the other kind when both are installed, else `same`. [KRI-16]
- The reviewer reviews the diff with no Work context. [KRI-16]
- Model and effort: GAP-1. Reviewer kind not installed or signed out: GAP-47.

### 6.5 Loop limit

- `max_back: 5`. At the third send-back (`loop_check: 3`, `false` to turn off), TED itself starts a sub-agent of the reviewer kind. It reads the three rounds of Findings and the diffs between them and says **converging** or **looping**. [KRI-16]
- Converging: back to Work with the verdict added. Looping: ask the human now. [KRI-16]
- The ask (at a looping verdict or at 5) lists each round’s blocking Findings and offers **Try again** (resets the count), **Back to Design**, **Move to Review anyway** (open Findings go in the Review brief), plus the text box. [KRI-16]

### 6.6 Confirmation row

- A compact row such as “✓ Typecheck ✓ Tests ✓ Review ✓ Visual” on each Validate event in the thread and at the top of the Review sign-off. Click to expand output or notes. Notes show as “✓ Review · 2 notes”. Nothing extra on Board cards. [KRI-16]

---

## 7. Review and Merge

### 7.1 Sign-off card (Review Gate)

- Shows the Task brief, the ✓ row, evidence from Validate (screenshots, and recordings where possible), and a “How to try it” section from the Task Lead where it applies. [KRI-18]
- Keeps its own **Preview** row: hosted, else local Web App, else **Run** / **Run again** with a Log link. [KRI-18, KRI-23]
- Buttons **Request changes** and **Approve and merge** sit in a row below the comment box, as on every request card. [KRI-13, KRI-23] (GAP-51: labels when Merge is off or has its own Gate.)
- After a conflicting rebase or a CI failure at Merge, the re-sign-off shows only “Changes since you approved.” [KRI-52]

### 7.2 Preview

- The one place to look at a Task’s work: the hosted preview its pull request reports (from GitHub Deployments and commit statuses), else its running App. When both exist, the other is a small secondary link in Task details. TED never deploys anything. [KRI-18]

### 7.3 Apps

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

- Declared per repo. Keys: `name`, `run`, `url`, `ready`, `kind`, `device`, optional fixed `port`. [KRI-18]
- `kind`: `web` (default), `command` (no URL) or `ios-simulator`. One repo can list several. React Native Web is a `web` App. [KRI-18]
- TED picks a free port per App per worktree and passes it as `${PORT}` and `PORT`. A fixed `port:` that is taken fails with a clear error. Port the `previewserver` manager logic from agent-orchestrator. [KRI-18]
- One running instance per App per Task, shared by the human and agents (`ted run-app` reuses it). Restarts show as events in the thread. [KRI-18]
- Apps run until stopped, the Task merges, or the Task is archived. They don’t count toward the limit on working Runs. [KRI-18]
- Factory setup proposes `apps`. [KRI-18, KRI-22]

**Apps section in Task details** [KRI-23]

- Grouped by repo when a Task spans several.
- Each App is a row: status dot, name, one status line (`localhost:5174`, `iPhone 17 · booted`, `Shut down 20m ago to free a slot for NB-44`, `Exited with code 1`), and icon buttons: ↗ Preview (web) or Show (brings the Task’s simulator to the front), ▶/■ Run/Stop, ↻ Restart. A `command` App has no Preview.
- Clicking a row replaces the thread in the middle pane with the App’s log, with its controls in a header and a “← Thread” link back.
- A hosted preview is its own row (“Vercel preview · Hosted · from PR #482”) with only ↗.
- Figma: [Apps section](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=13-3), [App log](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=14-2).

### 7.4 iOS simulators (macOS only)

- One simulator device per Task, cloned from the App’s `device` on first run, booted when needed, shown in Simulator.app, shut down when idle, deleted when the Task is archived. [KRI-18]
- TED manages the device. The Factory’s `run` command builds and installs using `TED_SIMULATOR_UDID`, so any build tool works. [KRI-18]
- At most 3 booted at once (setting). [KRI-18]
- **Human presses Run with all slots booted:** a popover lists the booted simulators by Task, with the one used longest ago selected, and a “Shut down NB-40’s and run” button. TED never shuts one down silently. [KRI-23, changed KRI-18] Figma: [Run iPhone with all simulators booted](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=14-404).
- **PROPOSAL (to confirm): agent needs a simulator with all slots booted.** The request becomes an Inbox Comment from the Run, like a permission request. It names the Task asking, lists the booted simulators by Task with the one used longest ago pre-selected, and offers **Shut down <Task>’s and run** and **Deny**. The Run shows as waiting until answered. [map: KRI-8 “Not yet specified”; shape copied from KRI-20 permission requests and KRI-23’s popover]
- Sidebar footer shows “Simulators 3 of 3 booted”. [KRI-23]
- `ted app screenshot` / `ted app record` capture through `simctl io`. [KRI-18]
- Hidden on Linux. Android emulators are later (KRI-47). [KRI-18]

### 7.5 Merge rules

1. **TED merges**, not the Task Lead. The daemon runs `gh pr merge` under the user’s own GitHub login. The Task Lead only fixes what stands in the way (conflicts, CI failures); `merge.md` says how. [KRI-52] (GAP-49: GitHub auth.)
2. **Approve and merge** merges automatically once CI passes (GitHub’s required checks, or all checks if none are required), the pull request is mergeable, and nothing changed since sign-off apart from a conflict-free rebase. Merge has no Gate by default; `merge: { gate: true }` adds one. (GAP-53: what its sign-off shows.) With the Review Gate off, Merge runs right after Validate. [KRI-52] (GAP-52: no CI, or CI never reports.)
3. **Merge can be turned off** (`merge: { enabled: false }`). The Task then waits after sign-off with the status “Waiting for merge”; the human merges on GitHub, and TED moves the Task to Done when it sees the merge. [KRI-52]
4. **Changes after sign-off.** Conflict-free rebase onto a moved base: TED reruns Checks, waits for CI and merges, with no new sign-off. Rebase with conflicts, or CI failing at Merge: back to Work, through Validate, to Review for a short re-sign-off. Merge `max_back: 3`; over it becomes a question for the human. [KRI-52]
5. **Merge method:** `merge_method` per repo, squash by default. If GitHub doesn’t allow the chosen method, TED uses one it does allow and notes it in the thread. The branch is deleted after merge. [KRI-52]
6. **Multi-repo:** merge in the order of `repos`. TED checks every pull request is green and mergeable before merging the first. Merged pull requests are never reverted automatically. A failure partway leaves the Task in Merge with “Partly merged” until the Task Lead fixes the rest through Work, Validate and a short re-sign-off. [KRI-52]
7. **Branch protection:** after sign-off TED turns on GitHub’s auto-merge where the repo allows it, so GitHub enforces required reviews, checks and merge queues. Otherwise TED polls and merges once GitHub reports the pull request mergeable. TED never approves a pull request. A required teammate review shows as “Waiting for GitHub review”; review comments go to the Task Lead. [KRI-52, KRI-20]
8. **After merge:** Done (4.14). [KRI-52]

### 7.6 Trying it by hand

- In the Task’s worktree, through its shell and **Open in editor**, at any Stage once a worktree exists. TED never checks a branch out into the user’s main clone. [KRI-18] (GAP-5: which editor. GAP-54: where the shell opens.)
- One shell per Task worktree (per repo) that survives app restarts, with search. [KRI-20]

### 7.7 Changes panel

- Task details has a Changes section listing changed files with +/− counts, grouped by repo. Clicking a file opens its diff in the middle pane. [KRI-20]
- **Expand all** widens the details pane into one scrolling column of every diff, with the file list as a sticky index. [KRI-20]
- Diffs are the Task branch against its merge-base with the default branch, including uncommitted work. Image diffs if they come with the ported UI. Open in editor. [KRI-20]
- Diff line comments are drafted here and sent together with Request changes, like a GitHub review. [KRI-18] (GAP-50: the drafting UI.)

---

## 8. UI

### 8.1 Visual base

- Start from agent-orchestrator’s visual style, kept calm and simple. Prototype colours are placeholders. [KRI-13]
- Raise contrast for secondary text, captions and lines, in light and dark mode. [KRI-23]
- Typography and density copy agent-orchestrator exactly: [KRI-14]
  - Fonts: Geist Variable and Geist Mono Variable (bundled); on macOS, `-apple-system` (SF Pro) and SF Mono.
  - Body 14px, line height 1.5. Dense controls 13px, captions 11px, small 12px.
  - Scale (px): 8, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 17, 21, 22, 28.
  - Line heights: 1.42, 1.5, 1.55, 1.6, 1.7; table rows 20px.
  - Terminal 12px (adjustable 10–20, saved per user), line height 1.35. Chat 14px, code in chat 12px.
  - Weights 500 and 600 only, sentence case, tabular numbers.
- Themes: light, dark, follow system. [KRI-20] No translucency. [KRI-20]
- No text-size setting (KRI-51); Electron zoom still works.
- **PROPOSAL (to confirm): visual detail beyond the above is left to build.** The spec fixes layout (this section), typography and density. Colours, icons, spacing inside components and motion are build decisions, reviewed in Figma. [map: KRI-8 “Not yet specified”]

### 8.2 Three-pane layout

[KRI-13; Figma: [Inbox · three panes](https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=4-2)]

- **Sidebar:** Factory switcher at the top, then Inbox (with a count of waiting items), Board and List, then the list of Factories. Footer: simulator count. [KRI-13, KRI-23] (GAP-55: whether the Inbox, Board and List show one Factory or all; Plans and Automations entries.)
- **Middle pane:** the Inbox list and Task thread, or a View, or a swapped-in content (Run chat, App log, Full brief, diff).
- **Right pane:** Task details.
- Board and List open in place of the Inbox list and thread. Clicking a Task opens the same thread and details, with a back link. [KRI-13]

### 8.3 Inbox

- The Comments waiting on the human: unanswered questions, rounds, design reviews, sign-offs, permission requests, and Comments from Automation and Planning Runs. [Glossary, KRI-19, KRI-20]
- One row per request: kind (Question, Design review, Sign-off, …), one-line headline, then Task ID, title and Stage. [KRI-13] Automation items show under the Automation’s name. [KRI-20]
- Never in the Inbox: setup notices, “No Checks”, drift, “Waiting for GitHub review”. [KRI-22, KRI-52]
- Order, grouping, dismissing without answering, what happens after answering: GAP-61. The full list of Comment kinds: GAP-67.

### 8.4 Task thread

- **Header:** Task ID, source, Run icons, title, status, Stage track, activity line. [KRI-13]
- **Thread:** Comments inline. Stage changes and other events are small lines (“You approved · Task moved to Design”, “Validate sent this back to Work (round 2 of 5)”, App restarts, Clarify depth pick, merge-method fallback). [KRI-13, KRI-11, KRI-16, KRI-18, KRI-19, KRI-52]
- **Pinned request:** the open request sits at the bottom with its actions: choice buttons and a text box for a question; Request changes and Approve for a review; Approve and merge for a sign-off. Buttons sit below the comment box. When nothing waits, a plain comment box. [KRI-13, KRI-23]
- Attachments: images, and HTML in a sandboxed frame. No artifacts gallery. [KRI-20]
- Editing and deleting the human’s own Comments, attaching files: GAP-63. Commenting on a Task with no live Run: GAP-43.

### 8.5 Task details

[KRI-13, KRI-23, KRI-20, KRI-19]

- Stage history (4.5).
- Task brief: Goal and Next step, plus **Full brief**.
- Original request (collapsed) and description history.
- **Code:** one pull request per repo.
- **Apps** (7.3).
- **Changes** (7.7).
- **Runs:** each Run with its icon; clicking opens its chat. Stop on sub-agents. Cost per Run and per Task (GAP-10).
- Secondary Preview link when both hosted and local exist. [KRI-18]
- Shell and Open in editor (GAP-54).

### 8.6 Board

- Each Task in a column for its current Stage. [Glossary]
- Columns and the queue sort by Priority, then rank. [KRI-15]
- **Drag rules:** vertical reordering in any column changes rank; dropping among Tasks of another Priority changes Priority. The only moves between columns are Backlog → Intake (Start) and Queued → Backlog (un-start). [KRI-15]
- When a card is picked up, only its valid drop column lights up; other columns dim and the cursor shows “not allowed.” [KRI-15]
- Queued cards sit at the top of Intake with “Queued · 2nd”. Blocked cards name the blocking Task, clickable. Needs planning marker shown. Play button on Backlog cards. [KRI-15, KRI-19]
- Nothing extra about Checks on cards. [KRI-16]
- Columns for disabled Stages, Done column growth: GAP-62.

### 8.7 List

- Tasks as rows that can be sorted, grouped and filtered, like Linear. Can sort by rank (“Manual”). Needs planning is filterable. [KRI-8, KRI-15, KRI-19]
- Columns, groupings and filters: GAP-59.

### 8.8 Planning Runs and the Plans list

Decided [KRI-19]:

- A Planning Run is a Run in a Factory, not on any Task. UI name: **planning chat**. Opened from **Plan** on the Factory or **Plan in chat** on a too-big Task.
- The agent can read the repos, start research sub-agents, and ask questions in the same round format. It ends by proposing Tasks with blocking links as a sign-off. Approve creates them in Backlog. If it started from a Task, that Task becomes the first piece, as in Split it. Created Tasks link back to the Planning Run.
- Its rounds and sign-off appear in the Inbox. Opening one shows the planning chat in the middle pane.
- Each Factory has a **Plans** list: open and finished planning chats, with status and the Tasks they created.
- An active Planning Run counts as one working Run toward both limits. Waiting on the human it sits idle. Stopped Planning Runs are history.
- Model and effort: GAP-1. Ending, renaming, deleting, and which checkout it reads: GAP-73.

**PROPOSAL (to confirm): how they look.** Following the three-pane layout and the map’s note that visual detail is left to build:

- The Factory’s **Plans** entry sits in the sidebar under that Factory, next to Board and List, and opens the Plans list in the middle pane in place of the Inbox.
- Each row: planning chat title, status (Working, Waiting on you, Idle, Stopped), when it started, and the count of Tasks it created.
- Clicking a row opens the planning chat in the middle pane, laid out like a Task thread: rounds and the proposal inline, the open request pinned at the bottom. The right pane shows the proposed or created Tasks with their blocking links, and the Run.
- **Plan** opens a new planning chat with an empty comment box for the first message.

### 8.9 Settings

- **App Settings** decided items: max working Runs (default 6); simulator cap (default 3); automatic restart onto new agent versions (on); Stay Awake (on); theme; notification sound (off); Developer mode; Linear API key; the Library’s `reviewer`; terminal font size (10–20); “keep running in the background” remembered choice; one stable update channel. [KRI-15, KRI-18, KRI-20, KRI-16, KRI-14, KRI-11]
- Library edits write straight to `~/.ted/library/`. [KRI-22]
- **Factory settings panel:** 3.8.
- Full inventory, layout, and the split between global and per-Factory: GAP-3. Model and effort settings: GAP-1. API-key billing choice: GAP-4.

### 8.10 Developer mode and Diagnostics

- A Developer mode toggle (no preview-feature flags) shows: [KRI-20]
  - **Diagnostics:** CPU and memory per Run, process table, memory pressure, token use per Run, **Copy report**. [KRI-20, KRI-17]
  - A viewer for the daemon’s event log and each Run’s raw output.
- Per-agent health (installed, signed in, version) for Claude Code and Codex, `ted doctor`, `ted status`, `/healthz`. [KRI-20]

### 8.11 Notifications

- One system notification per new Inbox item; clicking opens the Task. [KRI-20]
- Unread count on the Dock and menu-bar icons. [KRI-20]
- Sound optional, off by default. No Dock bounce, no separate feed. [KRI-20]
- Permission asked when the first Inbox item arrives. [KRI-20]
- Other events (usage limit hit, Run failed, daemon problems): GAP-64, GAP-60.

### 8.12 Keyboard and search

- Fixed shortcuts for: next Inbox item, Approve, reply, switch View, jump to Task. [KRI-20] Actual bindings: GAP-57.
- A command palette over Tasks, Comments and commands. [KRI-20] Scope and behaviour: GAP-58.
- Rebinding and file-content search are later (KRI-35).

### 8.13 Screens with open questions

First-run (GAP-2), empty states (GAP-56), errors and system alerts (GAP-60), the Factory page (GAP-55), archived Tasks (GAP-65), the Automations page (GAP-68), the New Task dialog (GAP-35), the Add Factory form (GAP-24).

---

## 9. Automations and intake

### 9.1 Automations

- A schedule in a Factory: cron or RRULE with a timezone, missed runs made up, run history with retries. Time triggers only; event triggers are later (KRI-25). [KRI-20]
- Set up in an **Automations** page and with `ted automation …`. [KRI-20] (GAP-68.)
- Each firing starts one Run outside any Task, with a stored prompt, agent, model and effort. [KRI-20] (GAP-1 for defaults and how they’re picked.)
- It creates Tasks with `ted task create`; each new Task gets its own Task Lead. Tasks land in Backlog unless `--start`. [KRI-20, KRI-15]
- If it needs the human, it posts Comments that show in the Inbox under the Automation’s name. [KRI-20] (GAP-69.)
- Automation Runs count toward the limit on working Runs. [KRI-15] (GAP-70.)
- Duplicates: `--source <url>` refuses a second open or archived Task with the same source. [KRI-20] (GAP-45.)
- Trade-off accepted: each firing costs tokens, an agent is less reliable than a connector, nothing syncs Linear status back. In return, any source with an MCP server or CLI works, and filters are prompts. [KRI-20]
- Templates shipped: “Pull new Linear issues assigned to me”, “Turn new Sentry issues into Tasks”, “Daily GitHub issue triage”. [KRI-20]
- Where Automations are stored: GAP-71. Automations and the daemon quitting: GAP-17.

### 9.2 Creating Tasks by hand and from Linear

- The human creating Tasks by hand (typing, or pasting a Linear URL) is the main way work enters. [KRI-20]
- Creating from a Linear URL fetches the issue with a Linear API key from Settings: title → Task title, description → context for the Task Lead, Linear’s suggested branch name → branch and worktree. Priority is copied. [KRI-20, KRI-15] (GAP-72.)
- No built-in connectors. A built-in Linear connector with two-way sync is later (KRI-26). [KRI-20]

---

## 10. Release work

Listed without product decisions; these are build tasks. [KRI-8]

- **Start the daemon at login:** launchd or a login item on macOS; a systemd user unit on Linux. (GAP-6: on by default or opt-in.)
- **macOS code signing and notarization.**
- **Linux packages:** which of AppImage, deb, rpm to ship. electron-updater covers macOS and Linux. [KRI-10] (GAP-74.)
- Bundled fonts: Geist Variable and Geist Mono Variable. [KRI-14]
- Keep agent-orchestrator’s NOTICE for copied UI code and mark changed files. [ADR 0003]
- Before shipping to other people: KRI-44 (OpenAI terms) and the Anthropic “third-party harness” recheck. [ADR 0004]

---

## 11. Out of scope for v1

From the map [KRI-8] and every issue labelled `later`:

- Multiplayer: [KRI-36 Multiplayer: plug a sync backend into the store](https://linear.app/kriyadesign/issue/KRI-36)
- Phone access: [KRI-38 Phone access to the Inbox](https://linear.app/kriyadesign/issue/KRI-38)
- Windows: [KRI-39 Windows support](https://linear.app/kriyadesign/issue/KRI-39)
- Several machines: [KRI-40 Run Tasks across several machines](https://linear.app/kriyadesign/issue/KRI-40)
- More agents: [KRI-41 Support more agents than Claude Code and Codex](https://linear.app/kriyadesign/issue/KRI-41)
- Wayfinder: [KRI-48 Wayfinder inside TED: lasting maps, decision tickets, frontier view](https://linear.app/kriyadesign/issue/KRI-48)
- Library sharing: [KRI-49 Share and version the Library](https://linear.app/kriyadesign/issue/KRI-49)
- Custom Stage types: [KRI-50 Custom Stage types beyond the built-in set](https://linear.app/kriyadesign/issue/KRI-50)
- Text size: [KRI-51 Text-size setting](https://linear.app/kriyadesign/issue/KRI-51)
- TUI switching: [KRI-24 Switch a Run between chat and the agent’s TUI](https://linear.app/kriyadesign/issue/KRI-24)
- Event triggers: [KRI-25 Event triggers for Automations](https://linear.app/kriyadesign/issue/KRI-25)
- Linear connector: [KRI-26 Built-in Linear connector with two-way status sync](https://linear.app/kriyadesign/issue/KRI-26)
- Auto-delete: [KRI-27 Auto-delete archived Tasks after N days](https://linear.app/kriyadesign/issue/KRI-27)
- Several accounts: [KRI-28 Several subscription accounts per agent, and moving a Run between them](https://linear.app/kriyadesign/issue/KRI-28)
- Side chats: [KRI-29 Side chats](https://linear.app/kriyadesign/issue/KRI-29)
- Cues: [KRI-30 Cues](https://linear.app/kriyadesign/issue/KRI-30)
- GitLab: [KRI-31 GitLab support](https://linear.app/kriyadesign/issue/KRI-31)
- Terminal splits: [KRI-32 Terminal split panes](https://linear.app/kriyadesign/issue/KRI-32)
- File tree: [KRI-33 File tree and quick open](https://linear.app/kriyadesign/issue/KRI-33)
- Built-in browser: [KRI-34 Built-in browser that agents drive](https://linear.app/kriyadesign/issue/KRI-34)
- Shortcuts and file search: [KRI-35 Rebind shortcuts and search file contents](https://linear.app/kriyadesign/issue/KRI-35)
- S3 attachments: [KRI-37 Move attachment files to S3-compatible storage](https://linear.app/kriyadesign/issue/KRI-37)
- Snooze: [KRI-42 Snooze a Task in Backlog until a date](https://linear.app/kriyadesign/issue/KRI-42)
- Long-Run revisit: [KRI-43 Revisit the one-long-Task-Lead-Run design using Diagnostics](https://linear.app/kriyadesign/issue/KRI-43)
- OpenAI terms: [KRI-44 Read OpenAI’s Terms of Use by hand before shipping to others](https://linear.app/kriyadesign/issue/KRI-44)
- `--bare` watch: [KRI-45 Watch for `--bare` becoming the default for `claude -p`](https://linear.app/kriyadesign/issue/KRI-45)
- Inbox ideas: [KRI-46 Inbox ideas from the rejected layouts](https://linear.app/kriyadesign/issue/KRI-46)
- Android: [KRI-47 Android emulator Apps](https://linear.app/kriyadesign/issue/KRI-47)

Also out of scope, with no issue: open-sourcing and licensing. [KRI-8]

Never (from KRI-20): rolling back a session; workers outside a Factory; Sentry crash reporting and telemetry; translucency; the `html_preview` and computer-use MCP tools.
