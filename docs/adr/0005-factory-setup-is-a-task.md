# Factory setup is a Task that goes through the Workflow

Adding a Factory creates a setup Task, the Factory’s first Task. It goes through the inherited Workflow like any other Task: Clarify asks how the human works, Design proposes Factory notes, Stage overrides, Checks, Apps and Stage settings, Work writes them on a branch, Validate runs the proposed Checks and starts the Apps, and Review and Merge land them on the default branch. We chose this so setup also teaches the human how the process works, using the same Inbox, Gates and sign-offs they will use every day.

## Considered Options

- **A setup Run outside any Task that posts one review Comment** (the earlier plan from KRI-16). Faster and simpler, but it shows the human none of the Workflow and needed its own approval UI.
- **Ted commits the approved files straight to the default branch.** Rejected: it skips branch protection and review.

## Consequences

- The Design and Review Gates are always on for a setup Task, even if the Library turns them off.
- The Factory can be used while setup runs. Tasks started before it merges use the inherited layers, and Ted warns about this.
- Changing a Factory later uses the same path: a new setup Task, or the Factory settings panel, whose Save opens a pull request.
