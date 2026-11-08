# TED

TED (“Totally Excellent Development”) runs software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments.

## Language

**Factory**:
A largely automated process that carries software development tasks from creation to merge for one product, which may span several repos.
_Avoid_: Project (when meaning the whole pipeline), pipeline

**Workflow**:
The ordered list of Stages a Factory runs Tasks through, with each Stage’s settings.
_Avoid_: Process, flow

**Stage**:
One step of a Workflow (for example Clarify or Validate), defined by a Stage file and settings such as whether it needs a human. A holding Stage, such as Backlog, has no Stage file: no agent works on a Task while it sits there.
_Avoid_: Step, phase, column

**Backlog**:
The holding Stage at the start of a Workflow where Tasks wait until they are started, by the human, an Automation, or the Tasks blocking them merging. Nothing runs on a Task in Backlog.
_Avoid_: Icebox, queue

**Done**:
The holding Stage at the end of a Workflow where a Task sits once all of its pull requests have merged. Nothing runs on a Task in Done.
_Avoid_: Closed, complete, shipped

**Gate**:
A setting on a Stage that makes the Task wait for the human’s sign-off at the end of that Stage before it moves on; a Stage that skips itself skips its Gate. Set in TED’s defaults, the user’s Library, or a Factory.
_Avoid_: Approval step, checkpoint

**Stage file**:
The Markdown instructions an agent follows while a Task is in that Stage.
_Avoid_: Prompt, playbook

**Clarify depth**:
How much questioning Clarify does on a Task: none, a few simple questions in one round, or a grilling session of several rounds that ends in the human’s sign-off. The Task Lead picks it unless the human or the Workflow sets it.
_Avoid_: Tier, level

**Check**:
A command a Factory lists for Validate, which TED runs itself; it passes when the command exits cleanly, and a failure sends the Task back to Work.
_Avoid_: Test (when meaning the command), CI job

**Finding**:
Something Validate found wrong with a Task’s work. A blocking Finding sends the Task back to Work; a note carries forward to Review.
_Avoid_: Issue, bug, comment

**Factory setup**:
The first Task of a new Factory, which carries the proposed Workflow for that product through the Workflow itself: it reads the repos, asks the human how they work, and proposes Checks, Apps and Stage settings for the human to approve.
_Avoid_: Onboarding, init

**Factory notes**:
Facts about a Factory’s product, such as how to run it, its conventions and its risky areas, given to every Run in that Factory. They never hold instructions for a Stage; those belong in Stage files.
_Avoid_: Context file, product brief

**App**:
A program a Factory declares for running a Task’s work, such as a dev server or an iOS simulator build; each Task has at most one running instance of each App, shared by the human and agents.
_Avoid_: Preview server, environment

**Preview**:
The one place to look at a Task’s work: the hosted preview its pull request reports, or else its running App.
_Avoid_: Demo, staging

**Library**:
A user’s own Stage files and Workflow settings, which apply to all of that user’s Factories; they override TED’s defaults and are overridden by a Factory’s own files.
_Avoid_: Templates, presets

**Task**:
A unit of work moving through a Workflow; once code exists it corresponds to one pull request. A Task too big for one pull request is split into several Tasks, the original narrowing to the first piece while keeping its original request.
_Avoid_: Ticket, issue, card, session, epic

**Follow-up**:
A Task created from a Done Task for a further change, linked to it and starting from its Task brief; the Done Task is never reopened.
_Avoid_: Reopen, amendment, revision

**Priority**:
How urgent a Task is (Urgent, High, Medium, Low, or None); together with the Task’s place in its column it decides which Queued Task starts first.
_Avoid_: Severity, importance

**Queued**:
A started Task waiting at the start of Intake for a free slot under the machine’s or Factory’s limit on working Runs; a status, not a Stage.
_Avoid_: Pending, ready

**Task Lead**:
The one agent in charge of a Task; it carries the Task through its Stages and may start sub-agents.
_Avoid_: Orchestrator, manager agent

**Run**:
One agent conversation, on a Task (the Task Lead’s or a sub-agent’s), for an Automation, or for planning, from when TED starts it until it is stopped. TED may restart the agent underneath it, for example onto a new agent version, and it is still the same Run. A stopped Run is kept as history and never resumed; work continues in a fresh Run.
_Avoid_: Session, job

**Planning Run**:
A Run in a Factory, not on any Task, where the human and an agent work out a piece of work too big for one Task; it ends by proposing Tasks, with which ones block which, for the human to approve.
_Avoid_: Planning session, epic, map

**Conversation**:
A Run’s full exchange with its agent, including tool calls and messages the human types directly into it; kept with the Run and separate from the Task’s Comments.
_Avoid_: Transcript, chat log

**Task brief**:
The Task Lead’s own summary of where a Task stands, kept with the Task, so a fresh Run can pick up the work.
_Avoid_: Handoff, context file

**Comment**:
A message on a Task, or from an Automation’s or Planning Run, written by the human or an agent; a comment can ask for the human’s answer, review, sign-off or permission.
_Avoid_: Message, note

**Automation**:
A schedule in a Factory that starts a Run each time it fires, outside any Task, usually to bring new work in as Tasks; one of several ways Tasks are created, alongside the human creating them by hand.
_Avoid_: Cron job, trigger

**View**:
A way of displaying a Factory’s Tasks, such as the Board or the List; changing views never changes a Task’s Stage.
_Avoid_: Layout, mode

**Board**:
The View that shows each Task in a column for its current Stage. Agents move Tasks between Stages; the human only reorders Tasks within a column and starts or un-starts them between Backlog and Queued.
_Avoid_: Kanban (as a noun for the data)

**List**:
The View that shows Tasks as rows that can be sorted, grouped, and filtered.
_Avoid_: Table

**Inbox**:
The Comments waiting on the human: unanswered questions, design reviews, and sign-offs.
_Avoid_: Notifications, feed
