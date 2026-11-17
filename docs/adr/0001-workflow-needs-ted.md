# The workflow only has to run inside Ted

Ted doesn’t try to make a Factory’s workflow followable by a plain Claude Code or Codex session without Ted. We first wanted that, but it meant every Stage file had to work both with and without Gates, the Inbox, Task briefs and sub-agents, and the version without Ted could only ever be partial. The Workflow files still live in the repo as plain Markdown and YAML so they are versioned and reviewable, and Stage files still use plain instructions that Ted maps to `ted` commands at Run start. Ted does not write to `AGENTS.md`.

Decided in [What goes in workflow.yaml and a Stage file?](https://linear.app/kriyadesign/issue/KRI-12).
