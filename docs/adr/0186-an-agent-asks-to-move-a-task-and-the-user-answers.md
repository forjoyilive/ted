# An agent asks to move a Task to another Factory, and only the user answers

Users often create a Task in the wrong Factory. Its Task Lead notices and says so, but until now the user had to recreate the Task or open Move to Factory… themselves (TED-482). TED-500 added the move itself and a Coordinator confirmation card for it.

**One move request for Task Leads and Coordinators.** `ted task move --factory <key> --reason "<why>"` calls `POST /tasks/:id/move-request` (`runToken: true`, current Task Lead only, `requestMove` in `tasks/tasks.ts`). `ted coordinator transfer … --reason "<why>"` calls `Coordinators.transfer`, which now goes through `Tasks.coordinatorAskMove` instead of saving a `transfer` confirmation. Both post one `question` on the Task with the choices Move and Keep it and a `move` field (`v1.CommentMoveAsked`: the suggested Factory, the one-line reason, `askedBy` and, for a Coordinator, its chat ID). A Task Lead’s request is held until its turn ends like any other; a Coordinator’s is posted by TED. The request is refused for an unknown Factory, any `planMove` refusal (the same Factory included) and a second open move request, and it can’t be superseded.

- **Only the user answers it.** Autopilot (`ordinaryAutopilotRequest`), `ted autopilot answer` and the Coordinator (`coordinatorNeverAnswers`) can’t, and `answerMove` in `tasks/request-answers.ts` refuses any answer with a `mark` or the automatic guard.
- **Move** carries the Factory the user picked, which may differ from the suggested one, and the key of the plan the card showed. TED checks the plan first, records the answer, then runs `Tasks.moveToFactory` as the human, so the request reads as answered rather than withdrawn by the move. If the move then fails, TED posts a note with the reason and the user can use Move to Factory… instead. The plan leaves open move requests out of `openRequests`, so recording the answer doesn’t change the plan key.
- **The new Task Lead** gets the reason: `movedReason` finds the approved move request whose title names the old ID.
- **Keep it** tells the Task Lead the Task stays and to carry on, or tells the Coordinator chat through `tellChat`. A Coordinator chat also hears the result of Move.
- **The card** is `MoveAnswer` in `RequestCard.tsx`: TED-500’s `FactoryPicker` with the suggested Factory chosen, `MovePlanDetails` for the chosen Factory, and Keep it and Move to <Factory>, red when work is thrown away.
- **`ted factories`** (`GET /factories/others`, `runToken: true`, current Task Lead only) lists the other Factories’ key, name and the Repos section of their notes, or their repo names when the notes have no such section.

## Considered Options

- **Keep the Coordinator’s confirmation card for transfers.** Two cards for the same decision; the user asked for one.
- **Let Autopilot approve a move.** Rejected in Clarify: a move throws work away and changes where the Task lives.
- **Open the Move to Factory dialog from the card.** One more click for the common case; the picker and plan fit on the card.

## Consequences

- `transfer` confirmations saved before this change still show and can be answered; no new ones are made.
- A Task Lead can’t ask to move another Task, and nothing moves without the user’s click.
