# TED

TED (“Totally Excellent Development”) runs software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments.

## Language

**Controller**:
The Mac that owns the authoritative Tasks, Inbox, queue and Workflow decisions when TED uses several machines.
_Avoid_: Primary server, master

**Execution machine**:
_Shelved: remote execution is on hold. The code is kept but hidden; don’t build new work on it._
The machine assigned to carry out a Task’s work, including its Runs, sub-agents and Checks.
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

**Primary repo**:
The first repo of a Factory, which holds the Factory’s own Workflow files and Factory notes; a repo can be the primary repo of only one Factory.
_Avoid_: Main repo, root repo, home repo

**Local folder**:
The user’s own clone of a repo on one machine, which TED reads only as the source of files copied into new worktrees; saved per machine, never in the Workflow.
_Avoid_: Local path, working copy, checkout

**Factory key**:
The short code at the start of a Factory’s Task IDs, such as NB in NB-41; unique on the machine and fixed once the Factory is added.
_Avoid_: Prefix, project key

**Workflow**:
The ordered list of Stages a Factory runs Tasks through, with each Stage’s settings.
_Avoid_: Process, flow

**Stage**:
One step of a Workflow (for example Clarify or Validate), defined by a Stage file and settings such as whether it needs a human. A holding Stage, such as Backlog, has no Stage file: no agent works on a Task while it sits there.
_Avoid_: Step, phase, column

**Backlog**:
The holding Stage at the start of a Workflow where Tasks wait to be started by the human, an Automation, or the Factory’s automatic Backlog starting option. Nothing runs on a Task in Backlog.
_Avoid_: Icebox, queue

**Cleanup**:
An optional Stage between Merge and Done, where the Task Lead carries out the Factory’s Cleanup steps after every pull request has merged. A Task in Cleanup counts as merged but not Done.
_Avoid_: Post-merge, wrap-up

**Cleanup step**:
One named step in a Factory’s Cleanup, such as posting the merged pull request to an Asana task or shutting down a test environment. An instruction step is carried out by the Task Lead, who reports it as done, skipped or failed; a command step is a shell command TED runs itself before the Task Lead acts, and passes or fails.
_Avoid_: Hook, after-merge action

**Done**:
The holding Stage at the end of a Workflow where a Task sits once all of its pull requests have merged and any Cleanup has ended. Nothing runs on a Task in Done.
_Avoid_: Closed, complete, shipped

**Sign-off**:
A setting on a Stage that makes the Task wait for the human’s sign-off at the end of that Stage before it moves on; a Stage that skips itself skips its sign-off. Set in TED’s defaults, the user’s Library, or a Factory, with optional choices for one Task. The configuration key remains `gate`. Autopilot turns these sign-offs off while it is on; Sign-offs TED forces stay.
_Avoid_: Approval step, checkpoint

**Autopilot**:
A mode in which the Task Lead makes routine decisions and carries a Task through Merge without routine questions or sign-offs, while protected decisions still wait for the user. Each Task follows the global setting or explicitly turns Autopilot on or off; the user can change a selected set together.
_Avoid_: Overnight mode, auto mode

**Stage file**:
The Markdown instructions an agent follows while a Task is in that Stage.
_Avoid_: Prompt, playbook

**Clarify depth**:
How much questioning Clarify does on a Task: none, a few simple questions in one round, or a grilling session of several rounds. The Stage’s Sign-off setting applies at every depth. The Task Lead picks it unless the human or the Workflow sets it.
_Avoid_: Tier, level

**Check**:
A command a Factory lists for Validate, which TED runs itself before the Task leaves Work, or at Validate entry when the Task comes from another Stage; it passes when the command exits cleanly. A failure before leaving Work keeps the Task in Work. A failure at Validate entry stays in Validate for diagnosis; an evidenced regression or the human’s Fix decision sends the Task back to Work. The machine runs the Checks of only so many Tasks at once; the others wait their turn.
_Avoid_: Test (when meaning the command), CI job

**Finding**:
Something Validate found wrong with a Task’s work. A blocking Finding sends the Task back to Work; a note carries forward to Review.
_Avoid_: Issue, bug, comment

**P1**:
The highest severity of a Finding: the change loses or corrupts data, opens a security hole, or breaks behaviour the Task’s description asks for. From Validate’s second round a new Finding about code the fixes didn’t touch is blocking only if it is P1, and a Factory can set a round from which a new Finding sends a Task back only if it is P1.
_Avoid_: Critical, blocker, severity 1

**Failure case**:
A record of one failure, its evidence, the Task Lead’s assessment and the human’s decision. Accepting a failure case allows that failure in its tested context; the original result stays failed.
_Avoid_: Passed failure, ignored Check

**Factory setup**:
The first Task of a new Factory, which carries the proposed Workflow for that product through the Workflow itself: it reads the repos, asks the human how they work, and proposes Checks, Apps and Stage settings for the human to approve.
_Avoid_: Onboarding, init

**Factory notes**:
Facts about a Factory’s product, such as how to run it, its conventions and its risky areas, given to every Run in that Factory. They never hold instructions for a Stage; those belong in Stage files.
_Avoid_: Context file, product brief

**App**:
A program a Factory declares for running a Task’s work, such as a dev server, an iOS simulator build or an Android emulator build; each Task has at most one running instance of each App, shared by the human and agents.
_Avoid_: Preview server, environment

**Preview**:
The one place to look at a Task’s work: the hosted preview its pull request reports, or else its running App.
_Avoid_: Demo, staging

**Library**:
A user’s own Stage files and Workflow settings, which apply to all of that user’s Factories; they override TED’s defaults and are overridden by a Factory’s own files.
_Avoid_: Templates, presets

**Task**:
A unit of work moving through a Workflow; once code exists it has one pull request in each repo it changes. A Task too big for one pull request per repo is split into several child Tasks, and the original becomes their parent.
_Avoid_: Ticket, issue, card, session, epic

**Task folder**:
The folder `~/.ted/worktrees/<TASK-ID>/` holding one worktree per repo of a Task, each named after the repo’s `name`. In a Factory with several repos, the Task’s Runs work in it; in a one-repo Factory they work in the repo’s worktree.
_Avoid_: Workspace, Task directory

**Task shell**:
The human’s own login shell in one repo’s worktree of a Task, shown in place of the thread; TED’s daemon keeps it running until the worktree is removed, and `ted` commands in it act as the human.
_Avoid_: Terminal, console, Run

**Parent Task**:
A Task with child Tasks under it. It waits while a child that isn’t archived is unmerged, then does only the work that brings its children’s work together and the final work no child owns. A parent TED made from Split it or a plan moves to Done by itself once its children have merged, if it has no work of its own. Archive, delete and unarchive act on it and every Task under it unless the user detaches the children.
_Avoid_: Epic, group, umbrella

**Child Task**:
A normal Task, with its own Workflow, Task Lead and pull requests, that is part of a parent Task’s work until the user detaches it.
_Avoid_: Subtask, sub-issue (except when naming the Linear or Asana item it came from)

**Detach**:
Remove a Task from its parent so it carries on as a separate Task; its own children stay under it.
_Avoid_: Unparent, unlink

**Follow-up**:
A Task created from a Done Task for a further change, linked to it and starting from its Task brief; the Done Task is never reopened.
_Avoid_: Reopen, amendment, revision

**Reset**:
The human’s choice to throw away what a started Task has done (its worktree, branch, pull request, thread and Runs) and start the same Task again from its first Stage with its Original request. The Task keeps its ID, title, Source, Priority, rank and blockers.
_Avoid_: Restart, retry, redo

**Source**:
The URL of the item a Task was created from, such as a Linear, Sentry or GitHub issue. A Linear source also fills in the Task’s title, Priority and branch when TED has a Linear API key.
_Avoid_: Origin, link, ticket

**Tracker sync**:
TED keeping a Task’s Source item (a Linear issue, later an Asana item) up to date: it moves the item forward as the Task goes on, links its pull requests and notices when the item is closed outside TED. It runs only for a Task the human allowed, one by one or for a whole group (a Linear team) in one Factory. Each tracker plugs in through a connector.
_Avoid_: Integration sync, two-way sync

**Original request**:
The first version of a Task’s description, kept as written when the Task was created. The human can edit the description at any time; each edit is a new version, and the Original request never changes.
_Avoid_: First draft, initial description

**Priority**:
How urgent a Task is (Urgent, High, Medium, Low, or None); together with the Task’s place in its column it decides which Queued Task starts first.
_Avoid_: Severity, importance

**Queued**:
The status of a started Task, or of a new Automation Run, waiting for a free slot under the machine’s or Factory’s limit on working Runs, or for this computer to be less busy when **Start fewer Runs when this computer is busy** is on; a newly started queued Task waits at the start of Intake, and an answered Task can wait in its current Stage before its Run continues. A status, not a Stage.
_Avoid_: Pending, ready

**Paused**:
The status of a Run, or of a Queued Task, whose agent can’t run right now because it hit a usage limit, is signed out, missing, outdated or using the wrong credential, or the machine is offline; it carries on by itself once the agent can run again. A status, not a Stage, and not a failure.
_Avoid_: Blocked, limited, stalled

**Failed**:
The status of a Task whose Task Lead Run ended without finishing or waiting, twice in a short time, for a reason other than the agent being Paused; the human decides whether to retry.
_Avoid_: Errored, crashed

**Stopped**:
The status of a Task whose Runs the human stopped; it stays in its Stage with its worktree until the human resumes it, which starts a fresh Task Lead Run from the Task brief. A status, not a Stage.
_Avoid_: Paused (which is for agents that can’t run), canceled, on hold

**Task Lead**:
The one agent in charge of a Task; it carries the Task through its Stages and may start sub-agents.
_Avoid_: Orchestrator, manager agent

**Coordinator**:
The conversational agent for one Factory. It compares current Tasks, briefs and Comments and carries out the human’s requests in its chat to create Tasks, start Backlog Tasks, reorder waiting Tasks, resume stopped Tasks, send a Task Lead a message, or answer a Task’s open requests, sign-offs included. It never answers a permission prompt, a simulator ask or the Linear team ask. It works only when messaged; each Task keeps its own Task Lead. A Factory has one current Coordinator conversation; New conversation saves it, and an earlier one can be continued.
_Avoid_: Foreman, manager, supervisor

**Sub-agent**:
A Run the Task Lead starts on its Task for one piece of work, such as exploring or reviewing; it reports back to the Task Lead with its final message and may post only plain Comments.
_Avoid_: Worker, helper, child agent

**Reviewer**:
The sub-agent that reviews a Task’s diff at Validate with no Work context. TED picks its agent from the `reviewer` setting, by default the other agent kind from the Task Lead’s. Each Validate visit gets one. From the second round TED limits it to the earlier Findings and the changes since the last reviewed commit, and after a send-back for a conflict with the base branch to the conflict resolution.

**Loop check**:
A sub-agent TED starts itself at Validate’s third send-back to read the rounds of Findings and say whether they are converging or looping.

**Run**:
One agent conversation, on a Task (the Task Lead’s or a sub-agent’s), for an Automation, for planning, or for a Coordinator, from when TED starts it until it is stopped. TED may restart the agent underneath it, for example onto a new agent version, and it is still the same Run. A stopped Run is kept as history and never resumed; work continues in a fresh Run.
_Avoid_: Session, job

**Planning Run**:
A Run in a Factory, not on any Task, where the human and an agent work out a piece of work too big for one Task; it ends by proposing Tasks, with which ones block which, for the human to approve. The UI calls it a planning chat.
_Avoid_: Planning session, epic, map

**Conversation**:
A Run’s full exchange with its agent, including tool calls and messages the human types directly into it; kept with the Run and separate from the Task’s Comments.
_Avoid_: Transcript, chat log

**Side chat**:
A separate conversation for asking questions about a Task Lead Run, using the Conversation as it was when the side chat started, while the Run continues its work. Its answers stay in the side chat.
_Avoid_: Fork, sub-agent, steering thread

**Task brief**:
The Task Lead’s own summary of where a Task stands, kept with the Task, so a fresh Run can pick up the work.
_Avoid_: Handoff, context file

**Comment**:
A message on a Task, or from an Automation’s or Planning Run, written by the human or an agent; a comment can ask for the human’s answer, review, sign-off, approval of proposed Tasks, or permission. Each comment has one kind: note, question, round, review, sign-off, permission or proposal.
_Avoid_: Message, note

**Line comment**:
A note the human attaches to one line of a Task’s diff; it stays a draft until it is sent to the Task Lead with the human’s next Comment on the Task. Approving doesn’t send it.
_Avoid_: Inline comment, review comment, diff comment

**Automation**:
A schedule in a Factory that starts a Run each time it fires, outside any Task, usually to bring new work in as Tasks; one of several ways Tasks are created, alongside the human creating them by hand. With **Run in a copy of the code** on, each of its Runs works in a fresh copy of the default branch and can start the Factory’s Apps there; TED removes both when the Run ends.
_Avoid_: Cron job, trigger

**Scheduled Check**:
An Automation that runs its own command as a Check, with no agent, in a fresh worktree on the tip of the Factory’s default branch. When the command fails, TED creates Tasks to fix what failed, and a later failure of the same test file adds a note to its open Task instead of making another.
_Avoid_: Nightly build, scheduled test run

**Asana intake**:
TED bringing the user’s unfinished Asana work into one Factory: the user picks one Asana project, and optionally one section of it, and each run imports every task there that is assigned to them, with the unfinished tasks under it, as Tasks in Backlog. TED checks every item with Asana itself and never imports one twice.
_Avoid_: Asana sync (that is keeping imported items up to date)

**Daemon**:
TED’s background process on each machine, which keeps Runs, Automations and the store going while no window is open. The UI calls it “TED in the background”, not the daemon.
_Avoid_: Server, backend, service

**View**:
A way of displaying Tasks, such as the Board for one Factory, the List for one Factory or all of them, or the Map of one Factory’s blockers; changing Views never changes a Task’s Stage.
_Avoid_: Layout, mode

**Board**:
The View that shows one Factory’s Tasks, each in a column for its current Stage. Agents move Tasks between Stages; the human only reorders Tasks within a column and starts or un-starts them between Backlog and Queued.
_Avoid_: Kanban (as a noun for the data)

**List**:
The View that shows Tasks, of one Factory or of every Factory, as rows that can be sorted, grouped and filtered; sorted by Priority and rank, the human can reorder, start and un-start Tasks as on the Board.
_Avoid_: Table

**Map**:
The View that draws one Factory’s blockers: each Task that waits for another, or is waited for, as a card, left to right in the order they can start, with a line from each blocker to the Task it blocks. The human removes a blocker from its line and adds one by dragging from one Task to another. Tasks with no blockers stay out of it.
_Avoid_: Graph, timeline, dependency chart

**Inbox**:
The Comments from every Factory waiting on the human’s answer: questions, Clarify rounds, design reviews, sign-offs, Task proposals and permission requests. A Comment leaves the Inbox once it is answered or can no longer be answered. A snoozed request is hidden from the Inbox and its counts until the time the human picked, and stays open meanwhile.
_Avoid_: Notifications, feed

**Middle pane**:
The wide column in the middle of the app’s window, left of a Task’s details. On a Task it shows the Task’s thread, or in its place a Run chat, an App log, a Shell, a diff, All changes or the Full brief; `middle-pane.ts` in the renderer decides which.
_Avoid_: Main pane, content area

**Banner**:
A one-line notice of a machine or Factory problem, shown app-wide or on one Factory’s pages until the problem clears. A banner either stops work (red, can’t be dismissed) or is a warning (amber, hidden for 24 hours by ×). Banners are never Inbox items.
_Avoid_: Alert, error bar, toast

**TED Dev**:
TED run from source (`pnpm app`, `pnpm ted`), as opposed to the installed release. It has its own home folder (`~/.ted-dev`), app name, keyring entry and Factories, and never installs a command, a login item or an update, so it can run beside the release on one machine.
_Avoid_: Debug build, local TED
