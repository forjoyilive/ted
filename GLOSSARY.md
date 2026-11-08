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
One step of a Workflow (for example Clarify or Validate), defined by a Stage file and settings such as whether it needs a human.
_Avoid_: Step, phase, column

**Gate**:
A setting on a Stage that makes the Task wait for the human’s sign-off at the end of that Stage before it moves on; a Stage that skips itself skips its Gate. Set in TED’s defaults, the user’s Library, or a Factory.
_Avoid_: Approval step, checkpoint

**Stage file**:
The Markdown instructions an agent follows while a Task is in that Stage.
_Avoid_: Prompt, playbook

**Library**:
A user’s own Stage files and Workflow settings, which apply to all of that user’s Factories; they override TED’s defaults and are overridden by a Factory’s own files.
_Avoid_: Templates, presets

**Task**:
A unit of work moving through a Workflow; once code exists it corresponds to one pull request.
_Avoid_: Ticket, issue, card, session

**Task Lead**:
The one agent in charge of a Task; it carries the Task through its Stages and may start sub-agents.
_Avoid_: Orchestrator, manager agent

**Run**:
One agent working on a Task, from when TED starts it until it is stopped; either the Task Lead or a sub-agent. A stopped Run is kept as history and never restarted; work continues in a fresh Run.
_Avoid_: Session, job

**Task brief**:
The Task Lead’s own summary of where a Task stands, kept with the Task, so a fresh Run can pick up the work.
_Avoid_: Handoff, context file

**Comment**:
A message on a Task from the human or an agent; a comment can ask for the human’s answer, review or sign-off.
_Avoid_: Message, note

**View**:
A way of displaying a Factory’s Tasks, such as the Board or the List; changing views never changes a Task’s Stage.
_Avoid_: Layout, mode

**Board**:
The View that shows each Task in a column for its current Stage; agents move Tasks, humans do not.
_Avoid_: Kanban (as a noun for the data)

**List**:
The View that shows Tasks as rows that can be sorted, grouped, and filtered.
_Avoid_: Table, backlog

**Inbox**:
The Comments waiting on the human: unanswered questions, design reviews, and sign-offs.
_Avoid_: Notifications, feed
