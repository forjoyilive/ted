# Automatic Backlog starts are a machine-local Factory choice

A Factory can opt into automatically starting eligible Backlog Tasks whenever working-Run capacity is free. The choice defaults off and is saved immediately in the Factory’s store row, through the app-only API, rather than in repository Workflow settings: a repo or Library edit must not enable automatic work on this machine.

The Tasks module’s existing serialized queue pump serves runnable Queued work, held Runs and recoveries first, then selects eligible Backlog Tasks by Priority and manual order across enabled Factories. Only Tasks that fit the remaining machine and Factory capacity leave Backlog; setup, archived, blocked, stopped and failed Tasks are excluded. Agent pauses, cloning and the disk hold still apply. Waiting for the human or a Gate frees working-Run capacity, so more Tasks can start while others wait. Turning the option off leaves started Tasks running; returning an eligible Task to Backlog while it is on makes that Task eligible again.

The new setting is recorded by `v1.FactoryAutoStartBacklogChanged`. A start failure is excluded from further automatic attempts until the human explicitly starts it, changes the Factory option, or restarts Ted, preventing queue events from creating a retry loop.
