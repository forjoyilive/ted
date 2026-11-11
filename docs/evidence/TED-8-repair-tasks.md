# Repair Tasks after a failure

The user can choose existing work or approve a focused new repair from a Validate or Merge failure request. A new repair defaults to queued ordinary work, with a Backlog option. Selecting existing work leaves its state unchanged. The affected Task keeps its Stage, worktree and original failure; its Lead stops and releases its working-Run slot.

## Approval and recovery

The existing app-only resolveFailure request carries an explicit existing/new selection. No route or Run-token permission was widened. The app drafts title and description from retained evidence; cancel performs no mutation. New creation, failure association, answer, blocker, pending answer and brief are committed together. The request ID identifies a repeated decision. Identical answers return the recorded repair; conflicting selections are refused. The ordinary blocker cycle check prevents self and cyclic waits.

Startup reconciles a persisted repair wait by stopping its remaining Runs through RunManager. Ordinary blocker and slot handling queues continuation after the repair actually merges. Archive/delete preserve the user’s keep/unblock choice. Removing the final unmerged blocker leaves the affected Task Stopped until Resume. Notes and the brief explain these cases, and the recorded repair identity survives deletion. None resolves the original failure.

## Incorporation and fresh verification

Tasks owns incorporation before starting the replacement Lead. It checks local execution assignment first, checks worktree paths, fetches each target base and proves the merged repair is present. Ancestry covers normal merges; a no-op patch replay supports squash merges. All repos are prepared before any branch moves. Dirty or conflicting worktrees stop continuation before Checks, retaining local work and giving an actionable Resume instruction. Partly merged affected repos are not rewritten.

Incorporation records the resulting repo heads in a new append-only FailureRepairIncorporated event. The original failure and failed execution remain unchanged. The current Factory Workflow is fetched before choosing Lead defaults, permissions and prompt instructions. The prompt reads the updated brief. After Run creation and pending-answer delivery, Tasks schedules the existing Validate or Merge Check runner in the background. Checks use the existing sandbox and CheckSlots and do not retain the queue’s working-Run launch hold.

Current failure-context comparison invalidates acceptance when the revision changes. A fresh matching Check can verify an incorporated repair. A fresh failure creates another case and retains its link to the previous failed execution. Reported Findings still need fresh evidence. When a repair replaces or removes a Check, current coverage and a recorded explanation are required; the affected Task does not need a Work visit solely to satisfy that verification rule. Merge progression remains owned by the merge watcher.

## Verification status

Work is still being verified; this report is not a passing sign-off yet.

- Typecheck, lint and diff whitespace checks pass after the recovery changes.
- The final focused recovery pass has ten passing cases: retained incorporation, reset worktree, persisted hold and interrupted Check at both Validate and Merge, existing-selection restart, plus the complete Merge repair continuation. Startup produces exactly one fresh Check run, preserves the original failed execution, and holds a reset worktree before running Checks. Reset and persisted-hold cases also require all restored Runs to finish through RunManager. The fixtures also prove retained incorporation can recover after repair Task metadata is deleted.
- The ineffective-repair case passes after identifying original/replacement failure cases by ID. Failure rows sort by their latest event; positional assertions were incorrect after linking replacement evidence.
- Earlier two-file verification had 57 passing cases covering concurrent approval/replay, replaced-Check verification, merge/squash incorporation, dirty recovery, conflict holds, waiting restart, cycles, slot release, archive/delete and Merge selection. Current broad coverage is recorded below.
- The three-repo daemon API case passes: a dirty repo holds every branch unchanged, then Resume incorporates all three repos.
- The original restart tests failed at both Validate and Merge before the recovery fix. Tasks now confirms recorded worktree ancestry, refreshes Workflow definitions and schedules its existing Check runner after Lead delivery. Automatic verification requires a Check started after incorporation. Earlier executions cannot count as repair verification.
- The first full daemon/protocol/affected renderer run (12683) was intentionally interrupted to fix a newly found lifecycle gap: after restart, an incorporation hold marked the Task stopped but could leave its restored Lead alive. Its partial output is node_modules/.cache/ted-8/final-tests.log and is not a passing result. It also reported one existing-selection restart failure. Focused session 1003 reproduced the live-Lead hold at both Stages; the existing-selection case passes after waiting for startup reconciliation. The RunManager stop fix passes all ten expanded focused cases in session 69900 (node_modules/.cache/ted-8/hold-recovery-tests.log). No peer processes or locks have been changed. The final broad run (61917) completed with 163/164 files and 1992/1993 tests passing. Every repair case passed. Only the existing process-cleanup test, leaks.test.ts, failed at its nested Vitest 120-second timeout. Output: node_modules/.cache/ted-8/final-tests-after-hold-fix.log.
- The cleanup failure is recorded as Finding 7c23aa45-a348-43ea-a1c1-3786bd2c9c30 and assessed as unrelated, not accepted. The unchanged global setup takes every slot for a broad run without forwarding its PID to nested Vitest. The unchanged leak fixture uses that setup and can wait on its parent. An isolated temporary-lock reproduction confirms this wait; forwarding the parent PID makes the same nested acquisition finish. The reproduction never touches shared locks. Evidence: node_modules/.cache/ted-8/prove-nested-lock.mjs and nested-lock-proof.log. A scoped cleanup rerun remains queued normally.
- Two native Electron cases exercise the real app approval bridge: cancellation and edited new repair left in Backlog; existing selection, cycle rejection and corrected retry; retained failure and answered repair history. Initial execution exposed two test selector errors, corrected without production changes. The corrected run passed both cases without retries (session 94475). Native screenshots were inspected and attached. Evidence: node_modules/.cache/ted-8/native-repair-tests.log.
- Headless Chromium exercised the implemented renderer’s editable approval, cancel, unchecked queue, existing search and 390px layout. Final captures are attached to the Task. No human screen or keyboard control was used.

The full Merge continuation case shows that fresh Checks do not close the Finding themselves: the replacement Lead supplies evidence before progression. The source PR retains its previously signed-off commit, and the existing watcher merges it only after its normal requirements are satisfied. Incorporation neither changes the signed-off PR revision nor grants new merge authority.

## How to try it

1. Start TED Dev from the Task’s Preview row. Open a Task in Validate or Merge with an assessed failure and an open failure decision.
2. Choose **Wait for a repair Task**. Try existing selection, then the new repair form. The title and description are editable and queueing is checked by default. Cancel leaves the decision unanswered and creates nothing.
3. Approve a repair. The affected Task keeps its Stage and worktree, links the repair, and stops its Lead. An existing repair keeps its prior state; a new repair queues unless queueing was unchecked.
4. Merge the repair through its own Workflow. The affected Task queues continuation, incorporates the merged base and runs fresh Checks. A reported Finding still needs verification evidence. Check the original failure and brief for the retained repair link and execution history.
5. For the alternate path, archive/delete an unmerged repair or remove its blocker. The thread explains that validation has not passed. Removing the final blocker requires Resume; it does not close the original failure.

## Manual security review

Approval authority remains behind the existing app-only route. General Task creation with Run tokens stays restricted to Automations. Request parsing requires a boolean queue choice and explicit selection; Tasks checks current failure decision, Stage, running Checks, Factory, archive/Done state and cycles before mutation. Atomic event composition prevents duplicate/orphan repair creation on retry. Stop/restart use existing Tasks and RunManager boundaries.

Git work uses existing command environments, hook-disabled primitives and validated Task worktree paths. Target commits come from configured Factory repos. Local drafts and conflicts hold validation rather than being discarded. Repository-provided setup, Check and App commands keep their existing sandbox paths. Secrets pass through the existing failure text and error redaction before entering user-visible history.

## Integration with peer work

TED-84 extracts Lead lifecycle. Preserve this order: local assignment; Tasks-owned incorporation; refreshed WorkflowResolution returned to lifecycle; reload Task and brief; choose effective Lead/permissions and build prompt; RunManager start; answersDelivered/releaseTaskRun/sendWaiting; Tasks-owned fresh Check scheduling. The refreshed resolution must affect execution permissions and defaults as well as prompt text. Preserve blocked/stopped revive refusal and startup reconciliation of a persisted repair wait.

TED-151 changes Gate wording in shared Stage guidance. Preserve both its terminology and this Task’s repair instructions. TED-9 owns broader post-rebase Merge failure adoption; TED-10 owns CI failure diagnosis. This Task supplies their common repair remedy.
