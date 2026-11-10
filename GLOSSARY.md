# TED

TED (“Totally Excellent Development”) runs software factories: agents carry development tasks through a configurable workflow, and the user steers through an inbox and comments.

## Language

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
One step of a Workflow (for example Clarify or Validate), defined by a Stage file and settings such as whether it needs a user. A holding Stage, such as Backlog, has no Stage file: no agent works on a Task while it sits there.
_Avoid_: Step, phase, column

**Backlog**:
The holding Stage at the start of a Workflow where Tasks wait to be started by the user, an Automation, or the Factory’s automatic Backlog starting option. Nothing runs on a Task in Backlog.
_Avoid_: Icebox, queue

**Done**:
The holding Stage at the end of a Workflow where a Task sits once all of its pull requests have merged. Nothing runs on a Task in Done.
_Avoid_: Closed, complete, shipped

**Gate**:
A setting on a Stage that makes the Task wait for the user’s sign-off at the end of that Stage before it moves on; a Stage that skips itself skips its Gate. Set in TED’s defaults, the user’s Library, or a Factory, with optional choices for one Task. Overnight mode turns these Gates off while it is on; Gates TED forces stay.
_Avoid_: Approval step, checkpoint

**Overnight mode**:
A machine setting, off by default, for running Tasks without the user. While on, TED starts eligible Backlog Tasks in every Factory, and Gates set in the Workflow or on one Task count as off, the Merge Gate included. Gates TED forces (a setup Task, Clarify at grilling depth), Gate requests already open, questions and permission prompts still wait for the user. A Task whose changes touch `.ted/` keeps every Gate it has with the mode off, and its Review Gate is on, so Workflow changes never merge unseen.
_Avoid_: Night mode, autopilot

**Stage file**:
The Markdown instructions an agent follows while a Task is in that Stage.
_Avoid_: Prompt, playbook

**Clarify depth**:
How much questioning Clarify does on a Task: none, a few simple questions in one round, or a grilling session of several rounds that ends in the user’s sign-off. The Task Lead picks it unless the user or the Workflow sets it.
_Avoid_: Tier, level

**Check**:
A command a Factory lists for Validate, which TED runs itself; it passes when the command exits cleanly, and a failure sends the Task back to Work. The machine runs the Checks of only so many Tasks at once; the others wait their turn.
_Avoid_: Test (when meaning the command), CI job

**Finding**:
Something Validate found wrong with a Task’s work. A blocking Finding sends the Task back to Work; a note carries forward to Review.
_Avoid_: Issue, bug, comment

**Failure case**:
A record of one failure, its evidence, the Task Lead’s assessment and the user’s decision. Accepting a failure case allows that failure in its tested context; the original result stays failed.
_Avoid_: Passed failure, ignored Check

**Factory setup**:
The first Task of a new Factory, which carries the proposed Workflow for that product through the Workflow itself: it reads the repos, asks the user how they work, and proposes Checks, Apps and Stage settings for the user to approve.
_Avoid_: Onboarding, init

**Factory notes**:
Facts about a Factory’s product, such as how to run it, its conventions and its risky areas, given to every Run in that Factory. They never hold instructions for a Stage; those belong in Stage files.
_Avoid_: Context file, product brief

**App**:
A program a Factory declares for running a Task’s work, such as a dev server or an iOS simulator build; each Task has at most one running instance of each App, shared by the user and agents.
_Avoid_: Preview server, environment

**Preview**:
The one place to look at a Task’s work: the hosted preview its pull request reports, or else its running App.
_Avoid_: Demo, staging

**Library**:
A user’s own Stage files and Workflow settings, which apply to all of that user’s Factories; they override TED’s defaults and are overridden by a Factory’s own files.
_Avoid_: Templates, presets

**Task**:
A unit of work moving through a Workflow; once code exists it has one pull request in each repo it changes. A Task too big for one pull request per repo is split into several Tasks, the original narrowing to the first piece while keeping its original request.
_Avoid_: Ticket, issue, card, session, epic

**Task folder**:
The folder `~/.ted/worktrees/<TASK-ID>/` holding one worktree per repo of a Task, each named after the repo’s `name`. In a Factory with several repos, the Task’s Runs work in it; in a one-repo Factory they work in the repo’s worktree.
_Avoid_: Workspace, Task directory

**Task shell**:
The user’s own login shell in one repo’s worktree of a Task, shown in place of the thread; TED’s daemon keeps it running until the worktree is removed, and `ted` commands in it act as the user.
_Avoid_: Terminal, console, Run

**Follow-up**:
A Task created from a Done Task for a further change, linked to it and starting from its Task brief; the Done Task is never reopened.
_Avoid_: Reopen, amendment, revision

**Source**:
The URL of the item a Task was created from, such as a Linear, Sentry or GitHub issue. A Linear source also fills in the Task’s title, Priority and branch when TED has a Linear API key.
_Avoid_: Origin, link, ticket

**Original request**:
The first version of a Task’s description, kept as written when the Task was created. The user can edit the description at any time; each edit is a new version, and the Original request never changes.
_Avoid_: First draft, initial description

**Priority**:
How urgent a Task is (Urgent, High, Medium, Low, or None); together with the Task’s place in its column it decides which Queued Task starts first.
_Avoid_: Severity, importance

**Queued**:
The status of a started Task, or of a new Automation or Planning Run, waiting for a free slot under the machine’s or Factory’s limit on working Runs, or for this computer to be less busy when **Start fewer Runs when this computer is busy** is on; a queued Task waits at the start of Intake. A status, not a Stage.
_Avoid_: Pending, ready

**Paused**:
The status of a Run, or of a Queued Task, whose agent can’t run right now because it hit a usage limit, is signed out, missing, outdated or using the wrong credential, or the machine is offline; it carries on by itself once the agent can run again. A status, not a Stage, and not a failure.
_Avoid_: Blocked, limited, stalled

**Failed**:
The status of a Task whose Task Lead Run ended without finishing or waiting, twice in a short time, for a reason other than the agent being Paused; the user decides whether to retry.
_Avoid_: Errored, crashed

**Stopped**:
The status of a Task whose Runs the user stopped; it stays in its Stage with its worktree until the user resumes it, which starts a fresh Task Lead Run from the Task brief. A status, not a Stage.
_Avoid_: Paused (which is for agents that can’t run), canceled, on hold

**Task Lead**:
The one agent in charge of a Task; it carries the Task through its Stages and may start sub-agents.
_Avoid_: Orchestrator, manager agent

**Coordinator**:
The conversational agent for one Factory. It compares current Tasks, briefs and Comments and carries out the user’s requests in its chat to start Backlog Tasks, reorder waiting Tasks, resume stopped Tasks, send a Task Lead a message, or answer a Task’s open requests, Gates and sign-offs included. It never answers a permission prompt, a simulator ask or the Linear team ask. It works only when messaged; each Task keeps its own Task Lead.
_Avoid_: Foreman, manager, supervisor

**Sub-agent**:
A Run the Task Lead starts on its Task for one piece of work, such as exploring or reviewing; it reports back to the Task Lead with its final message and may post only plain Comments.
_Avoid_: Worker, helper, child agent

**Reviewer**:
The sub-agent that reviews a Task’s diff at Validate with no Work context. TED picks its agent from the `reviewer` setting, by default the other agent kind from the Task Lead’s.

**Loop check**:
A sub-agent TED starts itself at Validate’s third send-back to read the rounds of Findings and say whether they are converging or looping.

**Run**:
One agent conversation, on a Task (the Task Lead’s or a sub-agent’s), for an Automation, for planning, or for a Coordinator, from when TED starts it until it is stopped. TED may restart the agent underneath it, for example onto a new agent version, and it is still the same Run. A stopped Run is kept as history and never resumed; work continues in a fresh Run.
_Avoid_: Session, job

**Planning Run**:
A Run in a Factory, not on any Task, where the user and an agent work out a piece of work too big for one Task; it ends by proposing Tasks, with which ones block which, for the user to approve. The UI calls it a planning chat.
_Avoid_: Planning session, epic, map

**Conversation**:
A Run’s full exchange with its agent, including tool calls and messages the user types directly into it; kept with the Run and separate from the Task’s Comments.
_Avoid_: Transcript, chat log

**Task brief**:
The Task Lead’s own summary of where a Task stands, kept with the Task, so a fresh Run can pick up the work.
_Avoid_: Handoff, context file

**Comment**:
A message on a Task, or from an Automation’s or Planning Run, written by the user or an agent; a comment can ask for the user’s answer, review, sign-off, approval of proposed Tasks, or permission. Each comment has one kind: note, question, round, review, sign-off, permission or proposal.
_Avoid_: Message, note

**Line comment**:
A note the user attaches to one line of a Task’s diff; it stays a draft until it is sent to the Task Lead with the user’s next Comment on the Task. Approving doesn’t send it.
_Avoid_: Inline comment, review comment, diff comment

**Automation**:
A schedule in a Factory that starts a Run each time it fires, outside any Task, usually to bring new work in as Tasks; one of several ways Tasks are created, alongside the user creating them by hand.
_Avoid_: Cron job, trigger

**Daemon**:
TED’s background process on each machine, which keeps Runs, Automations and the store going while no window is open. The UI calls it “TED in the background”, not the daemon.
_Avoid_: Server, backend, service

**View**:
A way of displaying Tasks, such as the Board for one Factory or the List for one Factory or all of them; changing Views never changes a Task’s Stage.
_Avoid_: Layout, mode

**Board**:
The View that shows one Factory’s Tasks, each in a column for its current Stage. Agents move Tasks between Stages; the user only reorders Tasks within a column and starts or un-starts them between Backlog and Queued.
_Avoid_: Kanban (as a noun for the data)

**List**:
The View that shows Tasks, of one Factory or of every Factory, as rows that can be sorted, grouped and filtered; sorted by Priority and rank, the user can reorder, start and un-start Tasks as on the Board.
_Avoid_: Table

**Inbox**:
The Comments from every Factory waiting on the user’s answer: questions, Clarify rounds, design reviews, sign-offs, Task proposals and permission requests. A Comment leaves the Inbox once it is answered or can no longer be answered.
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
