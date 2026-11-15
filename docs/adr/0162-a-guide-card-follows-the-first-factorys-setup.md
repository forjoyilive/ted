# A guide card follows the first Factory’s setup, and the tutorial Comments go

Status: proposed (TED-370)

## Context

A new user’s first Factory is set up by its setup Task, which runs for a long time and stops several times for the user: a Clarify round, the design review, the Review sign-off. Until now the Add Factory dialog had **Show the tutorial**, which made the setup Task Lead post a Comment with a **Tutorial** chip as each Stage started. Those Comments depended on the agent writing them, sat in a thread the user had to open, and never said what the user should do next.

## Decision

- The app draws a guide card at the bottom of the sidebar, above Settings, on every page, for a Factory whose guide is live. The card names the Factory, shows fixed text chosen from the setup Task’s state, and has at most one button and a **Hide guide** link. The agent writes none of it.
- The card’s text is chosen only by `guideCard` in `packages/app/src/renderer/guide.ts`, a plain function of the Factory (cloned or not, clone-failed banner), its setup Task (Stage, status) and that Task’s open requests from `waiting()`. A round in Clarify is “questions”, a sign-off in Design is “the proposal”, a sign-off in Review is “the sign-off”; any other open request is “The Task Lead needs you”.
- A Factory gets a guide when it is added while no other Factory exists, or when the `guideNextFactory` machine setting is on. `createFactory` commits `v1.FactoryGuideStarted` in the same commit as `v2.FactoryAdded`, and turns `guideNextFactory` off in that commit. **Show on next open** on Settings → Developer turns `guideNextFactory` on together with `onboardingOnNextOpen`, and **Undo** turns both off. It is a separate setting because `onboardingOnNextOpen` ends with onboarding, often before a Factory is added.
- A guide ends with one `v1.FactoryGuideEnded` event, with its reason:
  - `task-created`: the user creates a Task in the Factory (`createdBy: human`) after its setup Task is Done, committed with the Task. Tasks from Automations, the Coordinator, plans and splits don’t end it.
  - `hidden`: **Hide guide**, through the app-only `POST /factories/:id/guide/hide`. There is no confirmation.
  - `setup-archived` or `setup-deleted`: the setup Task is archived or deleted.
- The guide is a column on the Factory’s row, so removing the Factory removes it. The app gets `guide: true` on a Factory whose guide is live. With several live guides the sidebar shows one card, for the most recently added Factory.
- The tutorial is removed: the Add Factory checkbox, the **Tutorial** chip, `ted comment --tutorial` and the tutorial instruction in `setupInstructions`. `v2.FactoryAdded` keeps its `showTutorial` field, always written `false` and never read. `v1.CommentMarkedTutorial` is no longer written; a Comment it marked is left out of every Comment read in `TedStore` (the thread, search, peer reads and the Comments a new Task Lead Run is given), so no shipped event is edited (ADR 0010).
- Factories that exist when this ships get no guide, whatever their `showTutorial` was.

## Considered Options

- **Let the setup Task Lead write the card text.** The text would change from run to run and could be wrong about what the user should do next.
- **Choose the card text in the daemon’s `status.ts`.** The card is not a Task status, and everything it needs (the Task, its open requests, the Factory and its banners) is already in the renderer.
- **Reuse `onboardingOnNextOpen` for the reset.** It is cleared when onboarding ends, so a reset followed by skipping the Add Factory step would lose the guide.
- **Delete tutorial Comments with a new event.** Leaving them out of reads keeps the event log as it is and needs no migration.

## Consequences

- Every Comment read in the store filters on the `tutorial` column.
- A setup Task whose Factory already had `.ted/` waits in Backlog; its card says the Factory is set up and offers New Task.
