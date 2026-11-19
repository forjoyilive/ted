# Ted

Ted (“Totally Excellent Development”) runs software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments.

## Language

These terms are common English words, so they are written in lowercase in running text and take a capital only at the start of a sentence or label: check (with check run, scheduled check and Affected tests check), comment, line comment, finding, failure case, gate, sign-off, follow-up, sub-agent, reviewer, conversation, source, priority, preview, banner and sandbox opening. The other terms keep their capital everywhere (Task, Factory, Workflow, Stage, Run, App, Automation, Task Lead, and the rest).

**Controller**:
The Mac that owns the authoritative Tasks, Inbox, queue and Workflow decisions when Ted uses several machines.
_Avoid_: Primary server, master

**Execution machine**:
_Shelved: remote execution is on hold. The code is kept but hidden; don’t build new work on it._
The machine assigned to carry out a Task’s work, including its Runs, sub-agents and checks.
_Avoid_: Worker node, remote host

**Execution operation**:
_Shelved: remote execution is on hold. The code is kept but hidden; don’t build new work on it._
One piece of work the controller asks an execution machine to do for a Task, identified by an operation ID and journaled on both machines so it runs once.
_Avoid_: Job, remote command

**Task assignment**:
The durable ownership of a Task’s execution by one machine; losing contact does not move that ownership elsewhere.
_Avoid_: Lease, placement hint

**Factory**:
A largely automated process that carries software development tasks from creation to merge for one product, which may span several repos.
_Avoid_: Project (when meaning the whole pipeline), pipeline

**Factory group**:
A named heading in the sidebar that holds some of the user’s Factories, such as one per client or Personal and Work; a Factory is in at most one group, and groups are kept on this Mac only. The Inbox and All Tasks can filter and group by it.
_Avoid_: Folder, workspace, tag

**Primary repo**:
The first repo of a Factory, which holds the Factory’s own Workflow files and Factory notes; a repo can be the primary repo of only one Factory.
_Avoid_: Main repo, root repo, home repo

**Local folder**:
The user’s own clone of a repo on one machine, which Ted reads only as the source of files copied into new worktrees; saved per machine, never in the Workflow.
_Avoid_: Local path, working copy, checkout

**Factory key**:
The short code at the start of a Factory’s Task IDs, such as NB in NB-41; unique on the machine and fixed once the Factory is added.
_Avoid_: Prefix, project key

**Sandbox opening**:
A setting that widens what sandboxed commands can reach or allows something to run outside the sandbox, listed in Factory settings → Sandbox. An opening that widens access keeps commands in the sandbox; one marked Unsandboxed allows commands outside it.
_Avoid_: Escape hatch, sandbox bypass (when meaning any opening)

**Workflow**:
The ordered list of Stages a Factory runs Tasks through, with each Stage’s settings.
_Avoid_: Process, flow

**Stage**:
One step of a Workflow (for example Clarify or Validate), defined by a Stage file and settings such as whether it needs a human. A holding Stage, such as Backlog, has no Stage file: no agent works on a Task while it sits there.
_Avoid_: Step, phase, column

**Custom Stage**:
A Stage a Factory or the Library adds by hand: an id in `order`, a Stage file with that id and optional settings, including a display name. The Task Lead follows its Stage file and ends it with an advance or a send-back like any working Stage; Ted gives it no special work of its own.
_Avoid_: Plugin Stage, extra step

**Backlog**:
The holding Stage at the start of a Workflow where Tasks wait to be started by the human, an Automation, or automatic Backlog starts (Settings → General → Backlog starts). Nothing runs on a Task in Backlog.
_Avoid_: Icebox, queue

**Cleanup**:
An optional Stage between Merge and Done, where the Task Lead carries out the Factory’s Cleanup steps after every pull request has merged. A Task in Cleanup counts as merged but not Done.
_Avoid_: Post-merge, wrap-up

**Cleanup step**:
One named step in a Factory’s Cleanup, such as posting the merged pull request to an Asana task or shutting down a test environment. An instruction step is carried out by the Task Lead, who reports it as done, skipped or failed; a command step is a shell command Ted runs itself before the Task Lead acts, and passes or fails.
_Avoid_: Hook, after-merge action

**Done**:
The holding Stage at the end of a Workflow where a Task sits once all of its pull requests have merged and any Cleanup has ended. Nothing runs on a Task in Done.
_Avoid_: Closed, complete, shipped

**Sign-off**:
A setting on a Stage that makes the Task wait for the human’s sign-off at the end of that Stage before it moves on; a Stage that skips itself skips its sign-off. Set in Ted’s defaults, the user’s Library, or a Factory, with optional choices for one Task. The configuration key remains `gate`. Autopilot turns these sign-offs off while it is on; Sign-offs Ted forces stay.
_Avoid_: Approval step, checkpoint

**Autopilot**:
A mode in which the Task Lead makes routine decisions and carries a Task through Merge without routine questions or sign-offs, while protected decisions still wait for the user. Each Task follows the global setting or explicitly turns Autopilot on or off; the user can change a selected set together. A Task that changes Ted’s settings in `.ted/`, and, while the setting for it is on, a Task an Automation made or whose GitHub issue has text from outsiders, keeps its sign-offs, with the Review sign-off forced on.
_Avoid_: Overnight mode, auto mode

**Stage file**:
The Markdown instructions an agent follows while a Task is in that Stage.
_Avoid_: Prompt, playbook

**Clarify depth**:
How much questioning Clarify does on a Task: none, a few simple questions in one round, or a grilling session of several rounds. The Stage’s Sign-off setting applies at every depth. The Task Lead picks it unless the human or the Workflow sets it.
_Avoid_: Tier, level

**Check**:
A command or an instruction a Factory lists for Validate, which Ted runs itself as Validate’s first step, every time a Task enters Validate. A command Check passes when the command exits cleanly; an Instruction Check passes when its agent reports a pass. A failure is a return to Work, and Ted tries to merge the latest base branch on the way. Before treating a failure as outside the Task or filing a repair Task, the Task Lead checks the latest base branch and searches open Tasks and recent base commits for an existing fix. It waits for an open Task that covers the failure, otherwise fixes it here when the fix is small and clear or creates a repair Task when it is too big. It asks the user when the fix changes what the Task delivers, needs something only the user has, or two attempts have failed. The machine runs the command Checks of only so many Tasks at once; the others wait their turn.
_Avoid_: Test (when meaning the command), CI job

**Instruction Check**:
A Check written as a plain-language instruction, which a fresh agent Ted starts carries out on the Task’s changes and reports as pass or fail. One that may fix what it finds edits and commits on the Task’s branch and runs before the command Checks; the others only report and run after them. A passed one runs again only when the Task’s own changes have changed. When its agent gives no result, Ted asks the human to try again or count it as failed.
_Avoid_: Agent check, AI check, review step

**Finding**:
Something Validate found wrong with a Task’s work. A blocking finding sends the Task back to Work; a note carries forward to Review.
_Avoid_: Issue, bug, comment

**Return to Work**:
A Task going back from Validate to Work, for a failed check, a blocking finding or a conflict with the base branch. Every one counts toward Validate’s limit, and the Task’s header shows the count. At the limit Ted asks the user to keep going or stop the Task.
_Avoid_: Bounce, retry, round (when meaning the return itself)

**P1**:
The highest severity of a finding: the change loses or corrupts data, opens a security hole, or breaks behaviour the Task’s description asks for. From Validate’s second round a new finding about code the fixes didn’t touch is blocking only if it is P1, and a Factory can set a round from which a new finding sends a Task back only if it is P1.
_Avoid_: Critical, blocker, severity 1

**Failure case**:
A record of one failure, its evidence, the Task Lead’s assessment and any choice to fix it or decision by the user. Only the user can accept a failure case, allowing that failure in its tested context; the original result stays failed.
_Avoid_: Passed failure, ignored check

**Factory setup**:
The first Task of a new Factory, which carries the proposed Workflow for that product through the Workflow itself: it reads the repos, asks the human how they work, and proposes checks, Apps and Stage settings for the human to approve.
_Avoid_: Onboarding, init

**Factory notes**:
Facts about a Factory’s product, such as how to run it, its conventions and its risky areas, given to every Run in that Factory. They never hold instructions for a Stage; those belong in Stage files.
_Avoid_: Context file, product brief

**App**:
A program a Factory declares for running a Task’s work, such as a dev server, a desktop Electron app, an iOS simulator build or an Android emulator build; each Task has at most one running instance of each App, shared by the human and agents.
_Avoid_: preview server, environment

**Preview**:
The one place to look at a Task’s work: the hosted preview its pull request reports, or else its running App.
_Avoid_: Demo, staging

**Library**:
A user’s own Stage files and Workflow settings, which apply to all of that user’s Factories; they override Ted’s defaults and are overridden by a Factory’s own files.
_Avoid_: Templates, presets

**Task**:
A unit of work moving through a Workflow; once code exists it has one pull request in each repo it changes. A Task too big for one pull request per repo is split into several child Tasks, and the original becomes their parent.
_Avoid_: Ticket, issue, card, session, epic

**Task folder**:
The folder `~/.ted/worktrees/<TASK-ID>/` holding one worktree per repo of a Task, each named after the repo’s `name`. In a Factory with several repos, the Task’s Runs work in it; in a one-repo Factory they work in the repo’s worktree.
_Avoid_: Workspace, Task directory

**Task shell**:
The human’s own login shell in one repo’s worktree of a Task, shown in place of the thread; Ted’s daemon keeps it running until the worktree is removed, and `ted` commands in it act as the human.
_Avoid_: Terminal, console, Run

**Parent Task**:
A Task with child Tasks under it. It waits while a child that isn’t archived is unmerged, then does only the work that brings its children’s work together and the final work no child owns. A parent Ted made from Split it or a plan moves to Done by itself once its children have merged, if it has no work of its own. Archive, delete and unarchive act on it and every Task under it unless the user detaches the children.
_Avoid_: Epic, group, umbrella

**Child Task**:
A normal Task, with its own Workflow, Task Lead and pull requests, that is part of a parent Task’s work until the user detaches it.
_Avoid_: Subtask, sub-issue (except when naming the Linear, Asana or GitHub item it came from)

**Detach**:
Remove a Task from its parent so it carries on as a separate Task; its own children stay under it.
_Avoid_: Unparent, unlink

**Follow-up**:
A Task created from a Done Task for a further change, linked to it and starting from its Task brief; the Done Task is never reopened.
_Avoid_: Reopen, amendment, revision

**Reset**:
The human’s choice to throw away what a started Task has done (its worktree, branch, pull request, thread and Runs) and start the same Task again from its first Stage with its Original request. The Task keeps its ID, title, source, priority, rank and blockers.
_Avoid_: Restart, retry, redo

**Source**:
The URL of the item a Task was created from, such as a Linear, Sentry or GitHub issue. A Linear source also fills in the Task’s title, priority and branch when Ted has a Linear API key. A GitHub issue in one of the Factory’s repos fills in the title, a copy of the issue and its comments with each author marked maintainer or outsider, and its files, read through the user’s `gh` login.
_Avoid_: Origin, link, ticket

**Tracker sync**:
Ted keeping a Task’s source item (a Linear issue, an Asana item or a GitHub issue) up to date: it moves the item forward as the Task goes on, links its pull requests and notices when the item is closed outside Ted. For Linear and Asana it runs only for a Task the human allowed, one by one or for a whole group (a Linear team or an Asana project) in one Factory; for GitHub issues one machine setting, off by default, turns it on for every Task whose GitHub issue Ted imported (a source that kept only the link doesn’t sync). Each tracker plugs in through a connector.
_Avoid_: Integration sync, two-way sync

**Task Sync**:
What the app calls Tracker sync for an Asana item: Ted comments on the item with each pull request it opens and completes it once every pull request of the Task merged. A Task imported in the app has it from the start unless the user unticks it in the import dialog; any other Task gets it from **Sync with Asana** in the Task menu, or from an Asana project the Factory allows. It belongs to the Asana account connected when it was allowed, and the Task shows its Task Sync state.
_Avoid_: Asana sync, auto-complete

**Original request**:
The first version of a Task’s description, kept as written when the Task was created. The human can edit the description at any time; each edit is a new version, and the Original request never changes.
_Avoid_: First draft, initial description

**Priority**:
How urgent a Task or Automation is (Urgent, High, Medium, Low, or None); it orders queued Tasks and Automation Runs after Stage queue priority and Task Lead continuation order. An Automation Run goes ahead of a new Task start with the same priority; a Task’s place in its column breaks ties among Tasks.
_Avoid_: Severity, importance

**Queued**:
The status of a started Task, or of a new Automation Run, waiting for a free slot under the machine’s or Factory’s limit on working Runs, or for this computer to be less busy (high CPU use or low memory) when **Wait to start new work when this computer is busy** is on; a newly started queued Task waits at the start of Intake, an answered Task can wait in its current Stage before its Run continues, and a Task can wait for a sub-agent even after its Task Lead ends. A status, not a Stage.
_Avoid_: Pending, ready

**Paused**:
The status of a Run, or of a Queued Task, whose Provider can’t run right now because it hit a usage limit, is signed out, missing, outdated or using the wrong credential, or the machine is offline; it carries on by itself once the Provider can run again. A status, not a Stage, and not a failure.
_Avoid_: Blocked, limited, stalled

**Failed**:
The status of a Task whose Task Lead Run ended without finishing or waiting, twice in a short time, for a reason other than its Provider being Paused; the human decides whether to retry.
_Avoid_: Errored, crashed

**Stopped**:
The status of a Task whose Runs the human stopped; it stays in its Stage with its worktree until the human resumes it, which starts a fresh Task Lead Run from the Task brief. A status, not a Stage.
_Avoid_: Paused (which is for Providers that can’t run), canceled, on hold

**Task Lead**:
The one agent in charge of a Task; it carries the Task through its Stages and may start sub-agents.
_Avoid_: Orchestrator, manager agent

**Coordinator**:
The conversational agent for one Factory. It compares current Tasks, briefs and comments and carries out the human’s requests in its chat to create Tasks, start Backlog Tasks, reorder waiting Tasks, resume stopped Tasks, send a Task Lead a message, or answer a Task’s open requests, sign-offs included. It never answers a permission prompt, a simulator ask or the Linear team ask. It works only when messaged; each Task keeps its own Task Lead. A Factory can have any number of Coordinator chats running at once; an archived chat stays readable and can be unarchived.
_Avoid_: Foreman, manager, supervisor

**Agent**:
A kind of helper for a Factory that works outside any one Task, with powers of its own: the built-in Coordinator and Planner, which runs planning chats, and Agents a layer defines. An Agent is defined by its Agent files: its settings in `agents.yaml` and its instructions in `agents/<id>.md`, in Ted’s defaults, the Library or `.ted/`. Its powers come from a fixed list: Ask the user, Manage Tasks, Manage Automations, Propose Tasks, Read the code, Manage Agents, Run commands in the copy and Run outside commands, and it can list Agent commands and outside commands. The Planner runs in planning chats and every other Agent in Coordinator chats. A chat keeps the Agent as it was when the chat started, so editing or removing an Agent changes only later chats. Each Factory’s Agents screen lists every chat with them. Lowercase “agent” still means a Run or its role (see Provider).
_Avoid_: Assistant, bot

**Power**:
One thing an Agent’s chat may do through Ted: Ask the user (questions and rounds in the Inbox), Manage Tasks (the Coordinator’s Task actions), Manage Automations (reading the Factory’s Automations and drafting new ones, changes and deletes that the user carries out from a card), Propose Tasks (a proposal that creates Tasks when approved), Read the code (a fresh checkout of the Factory’s repos), Manage Agents (drafts of Agents the user creates from a card) Run commands in the copy (the Agent’s commands, which needs Read the code) or Run outside commands (the Agent’s outside commands, only in Coordinator chats). Ted checks every power but Read the code on every request; Read the code only decides whether the chat gets a checkout.
_Avoid_: Permission, capability, tool

**Agent command**:
A command with a name that an Agent’s settings list in `agents.yaml`. A chat whose Agent has Run commands in the copy asks for one by name with `ted agent run <name>`; Ted runs the listed command itself in the chat’s copy of the code, in the sandbox, like a check, and returns its output and exit status. The agent can’t change the command or add arguments.
_Avoid_: Tool, script, task

**Outside command**:
A command with a name that an Agent’s settings list under `outside_commands` in `agents.yaml`, written as plain words with at most one argument slot such as `<version>`. A chat whose Agent has Run outside commands asks for one with `ted agent run-outside <name> [argument]`; Ted runs it on this Mac, outside the sandbox, in the repo’s local folder, only after the user clicks Run on its card, or at once when the user ticked Always allow for that exact command and folder.
_Avoid_: Escape hatch, unsandboxed command

**Sandbox access group**:
A named set of extra things the sandbox lets one command reach, defined only in Ted’s code and listed by `ted sandbox groups`. The Factory’s Workflow names groups under `sandbox_access` on an App, a command Check, or a repo’s worktree setup or teardown. `ios-xcode` is the first: it opens what Xcode writes outside its temp folder, which is shared access on the user’s Mac.
_Avoid_: Sandbox permission, allowance, entitlement

**Chat**:
One conversation with an Agent, from its first message until it is deleted: a Coordinator chat or a planning chat. A Factory can have several at once, each with its own title, status, Run and requests. A chat stays open until the user archives it; an archived chat is read only, listed under Archived, and can be unarchived or deleted.
_Avoid_: Session, thread, conversation (a Run’s exchange with its Provider)

**Sub-agent**:
A Run the Task Lead starts on its Task for one piece of work, such as exploring or reviewing; it reports back to the Task Lead with its final message and may post only plain comments.
_Avoid_: Worker, helper, child agent

**Reviewer**:
The sub-agent that reviews a Task’s diff at Validate with no Work context. Ted picks its Provider from the `reviewer` setting, by default an installed Provider other than the Task Lead’s and other than Pi, or the Task Lead’s own Provider when there is none. Each Validate visit gets one. From the second round Ted limits it to the earlier findings and the changes since the last reviewed commit, and after a send-back for a conflict with the base branch to the conflict resolution.

**Loop check**:
A sub-agent Ted starts itself at Validate’s fifth return to Work (by default; `stages.validate.loop_check`) to read the rounds of findings and say whether they are converging or looping.

**Run**:
One agent conversation, on a Task (the Task Lead’s or a sub-agent’s), for an Automation, for planning, or for a Coordinator, from when Ted starts it until it is stopped. Ted may restart the Provider underneath it, for example onto a new Provider version, and it is still the same Run. A stopped Run is kept as history and never resumed; work continues in a fresh Run.
_Avoid_: Session, job

**Asleep**:
Said of an idle Task Lead Run whose Provider process Ted has ended to free memory. The Run, its conversation and its place on the Task stay as they are, and Ted starts the Provider again in the same session when there is a message for it.
_Avoid_: Suspended, hibernated, paused (a paused Provider is something else)

**Provider**:
The AI coding tool a Run uses: Claude Code, Codex, Antigravity or Pi. It is chosen for each Task Lead, reviewer, Planning Run, Automation and sub-agent, and set up on Settings → Providers. “Agent” means a Run or its role (Task Lead, sub-agent, agent Run), never the tool.
_Avoid_: Agent, agent kind

**Planning Run**:
A Run in a Factory, not on any Task, where the human and an agent work out a piece of work too big for one Task; it ends by proposing Tasks, with which ones block which, for the human to approve. The UI calls it a planning chat.
_Avoid_: Planning session, epic, map

**Conversation**:
A Run’s full exchange with its agent, including tool calls and messages the human types directly into it; kept with the Run and separate from the Task’s comments.
_Avoid_: Transcript, chat log

**Side chat**:
A separate conversation for asking questions about a Task Lead Run, using the conversation as it was when the side chat started, while the Run continues its work. Its answers stay in the side chat.
_Avoid_: Fork, sub-agent, steering thread

**Task brief**:
The Task Lead’s own summary of where a Task stands, kept with the Task, so a fresh Run can pick up the work.
_Avoid_: Handoff, context file

**Comment**:
A message on a Task, or from an Automation’s or Planning Run, written by the human or an agent; a comment can ask for the human’s answer, review, sign-off, approval of proposed Tasks, or permission. Each comment has one kind: note, question, round, review, sign-off, permission or proposal.
_Avoid_: Message, note

**Line comment**:
A note the human attaches to one line of a Task’s diff; it stays a draft until it is sent to the Task Lead with the human’s next comment on the Task. Approving doesn’t send it.
_Avoid_: Inline comment, review comment, diff comment

**Automation**:
A schedule in a Factory that starts a Run each time it fires, outside any Task, usually to bring new work in as Tasks; one of several ways Tasks are created, alongside the human creating them by hand. Each Automation has a priority, High unless the user changes it, which places its Runs among queued Tasks; the **Automation Runs** screen lists every Factory’s Runs that are running, queued or ended in the last day. With **Run in a copy of the code** on, each of its Runs works in a fresh copy of the default branch and can start the Factory’s Apps there and drive its web Apps in a headless browser; Ted removes them when the Run ends.
_Avoid_: Cron job, trigger

**Scheduled check**:
An Automation that runs its own command as a check in a fresh worktree on the tip of the Factory’s default branch. Its **agent step** (when the check fails, after every run, or never) then starts an agent Run in a copy of the same commit, which investigates the result and creates Tasks, adds notes to open ones and, with **Start the Tasks it creates** ticked, starts the Tasks it created. Without the agent step, or when the agent Run can’t start, fails or ends without reporting, Ted creates one Task per failing test file, and a later failure of the same test file adds a note to its open Task instead of making another.
_Avoid_: Nightly build, scheduled test run

**Asana intake**:
Ted bringing the user’s unfinished Asana work into one Factory: the user picks one Asana project, and optionally one section of it, and each run imports every task there that is assigned to them, with the unfinished tasks under it, as Tasks in Backlog. Ted checks every item with Asana itself and never imports one twice. The **Import my Asana work** Automation template runs it every 30 minutes by default.
_Avoid_: Asana sync (that is keeping imported items up to date)

**GitHub intake**:
A Factory’s choice of which GitHub issues its Automations may turn into Tasks: any open issue in its repos, or only open issues with a label the user names. Ted reads each issue itself before an Automation imports it, refuses the rest, and creates those Tasks in Backlog, where automatic Backlog starts may start them when the user includes Tasks from GitHub issues. Tasks the user creates aren’t limited.
_Avoid_: GitHub sync (that is keeping imported issues up to date)

**Daemon**:
Ted’s background process on each machine, which keeps Runs, Automations and the store going while no window is open. The UI calls it “Ted in the background”, not the daemon.
_Avoid_: Server, backend, service

**View**:
A way of displaying Tasks, such as the Board for one Factory, the List for one Factory or all of them, or the Map of one Factory’s blockers; changing Views never changes a Task’s Stage.
_Avoid_: Layout, mode

**Board**:
The View that shows one Factory’s Tasks, each in a column for its current Stage. Agents move Tasks between Stages; the human only reorders Tasks within a column and starts or un-starts them between Backlog and Queued.
_Avoid_: Kanban (as a noun for the data)

**List**:
The View that shows Tasks, of one Factory or of every Factory, as rows that can be sorted, grouped and filtered; sorted by priority and rank, the human can reorder, start and un-start Tasks as on the Board.
_Avoid_: Table

**Map**:
The View that draws one Factory’s blockers: each Task that waits for another, or is waited for, as a card, left to right in the order they can start, with a line from each blocker to the Task it blocks. The human removes a blocker from its line and adds one by dragging from one Task to another. Tasks with no blockers stay out of it.
_Avoid_: Graph, timeline, dependency chart

**Inbox**:
The comments and chat requests from every Factory waiting on the human’s answer: questions, Clarify rounds, design reviews, sign-offs, Task proposals and permission requests. A comment leaves the Inbox once it is answered or can no longer be answered. A snoozed request is hidden from the Inbox and its counts until the time the human picked, and stays open meanwhile.
_Avoid_: Notifications, feed

**Middle pane**:
The wide column in the middle of the app’s window, left of a Task’s details. On a Task it shows the Task’s thread, or in its place a Run chat, an App log, a Shell, a diff, All changes or the Full brief; `middle-pane.ts` in the renderer decides which.
_Avoid_: Main pane, content area

**Banner**:
A one-line notice of a machine or Factory problem, shown app-wide or on one Factory’s pages until the problem clears. A banner either stops work (red, can’t be dismissed) or is a warning (amber, hidden for 24 hours by ×). Banners are never Inbox items.
_Avoid_: Alert, error bar, toast

**Onboarding**:
The full-window steps a new user sees the first time Ted opens on a machine: what Ted is, how it works, Set up Ted’s checks, and the Add Factory dialog for the first Factory. Developer mode can show them again on the next start.
_Avoid_: Tutorial, welcome wizard, Factory setup

**Guide card**:
The card at the bottom of the sidebar that follows a new user’s first Factory through its setup Task, saying in fixed text what Ted is doing and what the user should do next, with at most one button. It ends when the user creates their first Task, hides it, or the setup Task is archived or deleted.
_Avoid_: Tutorial, checklist, coach marks

**Ted Dev**:
Ted run from source (`pnpm app`, `pnpm ted`), as opposed to the installed release. It has its own home folder (`~/.ted-dev`), app name, keyring entry and Factories, and never installs a command, a login item or an update, so it can run beside the release on one machine.
_Avoid_: Debug build, local Ted
