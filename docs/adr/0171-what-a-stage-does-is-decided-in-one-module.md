# What a Stage does is decided in one module

The daemon and the CLI decided what each Stage does by comparing its id wherever the rule was needed: about 400 comparisons across `tasks/tasks.ts`, `validation.ts`, `merge-watcher.ts`, `sub-agents.ts`, `status.ts`, tracker sync, the Dashboard code, the store and the CLI. Users are to rearrange Workflows and add their own Stages later (TED-439), and a Stage TED doesn’t know would fall through those comparisons in ways nobody had checked (TED-440).

Now `packages/protocol/src/stage.ts` (`@ted/protocol/stage`, no Node imports) is the one place that says what a Stage does and where it sits:

- **Traits.** `stageTraits(id)` gives each built-in Stage its flags: `holding` (Backlog, Done) or `working`; `clarifyRounds` (Clarify: rounds, depth, the size check); `skippable` (Clarify, Design: `--skip`); `designReview` (Design); `setupGate` (Design, Review: Gates a setup Task forces on); `handOff` (Work: the hand-off Checks, the latest base at first entry); `validates` (Validate: Checks at entry, the reviewer, Findings); `bindsApproval` (Review, Merge: a sign-off bound to a commit); `merges` (Merge); `cleanup` (Cleanup). Code asks a named helper (`validates(stage)`, `mergesHere(stage)`, …), and `stageWith(trait)` names the one built-in Stage with a trait when code needs the id itself.
- **Order.** Built-in Stages keep their fixed order (`builtInStageOrder`). `compareStages`, `isPast`, `stagePhase` (before, at or after Work) and `clarifyIsOver` place a Stage; tracker sync’s “work has started”, the Dashboard’s Stage order and `workflow/resolve.ts` read them.
- **An unknown id** has no special work and is an ordinary working Stage. With the Workflow’s `order` it sits just after the nearest built-in Stage before it; outside the order it counts as before Work, so nothing outward, such as a tracker comment that work started, happens because of a Stage TED can’t place.

The Stage set stays closed: `checkLayer` still rejects unknown ids. Comparisons that name a Stage as data stay as ids: moving a Task to a named Stage, “is the Task Done” or “in Backlog”, event and schema values, labels and dev scenarios.

## Considered Options

- **A role per Stage** (`role(id) === 'validate'`). Rejected: it renames the comparisons without saying what the Stage does, so a custom Stage couldn’t take on one behaviour without the rest.
- **The module in the daemon.** Rejected: the CLI and, later, the app can’t import daemon code, and a second copy would drift.

## Consequences

- A new rule about what a Stage does is a trait or helper in `stage.ts`, with its test in `packages/protocol/test/stage.test.ts`, never a new id comparison.
- Accepting custom Stages (TED-441) changes `checkLayer` and the Workflow, not the call sites.
