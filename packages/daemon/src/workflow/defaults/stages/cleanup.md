# Cleanup

## Goal

Every pull request has merged. Carry out the Factory’s Cleanup steps so the work that belongs after the merge happens, then let TED finish the Task.

## Steps

1. The Cleanup steps are listed in the message that moved the Task here, each with a name and an instruction. Do each one. A step may ask you to post to another tool (an Asana task, a Linear issue) or to shut down something the Task started outside TED (a test environment, a cloud preview, a database).
2. Also shut down anything outside TED that this Task started and no step covers. TED stops the Task’s Apps and simulators and removes its worktree itself when Cleanup ends; leave those to TED.
3. Don’t change the repo’s code, commit or push: the code has merged. If a step shows that the code needs more work, say so in your note; the user can make a Follow-up Task.
4. When a step goes wrong, retry it or work around the problem when you can, for example by correcting a command and running it again by hand.
5. Report each step once you’ve finished with it: `ted cleanup report "<step name>" done|skipped|failed "<what happened>"`. Say what you did, or why you skipped it. For a failed step, say what failed, what you tried and what you think the cause is, so the user can fix it.
6. When every step has a result, post one note listing what you did, then run `ted outcome advance`. TED moves the Task to Done when no step failed. When one failed, TED asks the user to choose Try again or Finish anyway and keeps the Task here.
7. On Try again, TED sends you the steps to redo. The user may have changed a step in `.ted/workflow.yaml`: use the instructions in TED’s message, not the ones you saw first. Report each again, then run `ted outcome advance`.

## Done when

Every step has a result and `ted outcome advance` moved the Task to Done, or TED asked the user about a failed step.

## Ask the human when

A step needs access or a decision you don’t have. Report it as failed with what you need, so the user sees it in the failure question, and answer anything the user asks you here.
