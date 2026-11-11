# TED-136 · Distinguish slots, unfinished Runs and queued work

## Result

The sidebar and Limits show occupied slots against their limit, for example “7 slots in use · limit 6 · 1 queued”. Quit names the actual unfinished Runs, including idle, waiting and paused Runs. It lists queued work separately and names work starting or setting up before a Run exists. Menu text also names unfinished Runs. The existing working/queued list and Quit choices retain their behavior. The user requested removal of the proposed explanatory panel; no panel was added.

The original screenshot’s historical 14-to-7 breakdown cannot be recovered from the available evidence. The code establishes that the old counts had different meanings: the sidebar used working-slot occupancy; Quit summed unfinished/held Runs and some queued work. The illustrative Design counts were not a reconstruction of the incident.

## Counting decisions

- `TedStore.activity().runs.active` counts actual non-finished Run records. A held Task launch is not another unfinished Run.
- `runs.working` excludes agent pauses and Task Leads waiting only on sub-agents. Standalone development Runs still appear in Activity; they do not consume working slots.
- Queued/held Tasks are counted once. A Task preparing to launch is reported as starting work, and a Task already represented by its unfinished Lead is not invented as another Run.
- Tasks supplies queued and starting Run IDs for sub-agents and every registered queue source: Planning, Coordinator and Automation Runs, Automation drafts and side chats. Sources expose their actual starting IDs so stopping a finished Run is not mistaken for a new launch.
- Starting work stops counting as such when its Run exists. Preparing to revive a finished Run remains starting work until revival. Duplicate IDs within a category count once.
- Queued work may be a follow-up turn in an existing unfinished Run. The two categories are reported separately and never summed.
- Counts and queue ownership remain in the daemon. Neither the renderer nor Electron main recomputes scheduling rules. No scheduling or limit enforcement changes were made.

## Verification

Status: implementation and native captures complete. The broad run passed 169/171 files and 1967/1969 tests. Native background/menu/capture verification passed 7/7 tests without retries. Four renderer component files and the corrected agent-health file remain queued behind other required full runs.

The broad run retained two failures:

1. `failure-merge.test.ts` · “acceptance, obligations and Gate approval each verify worktree edits made while GitHub is pending” exceeded its 30-second limit. TED-147 independently reported the same timeout on its separate branch (peer evidence at commit f6fe4951). This is evidence of a shared timing problem, not proof that this change cannot affect its timing. Assessment: uncertain; no unrelated merge code was changed. A user decision is required before treating this failure as acceptable for this Task.
2. `agent-health.test.ts` · the auth-error resume test expected a held launch to remain an active Run. Actual was 0, as intended by the approved definitions. The assertion now checks active 0 / queued 1. The focused file rerun remains queued; it is not reported as passing. The broad run’s new TedStore held-launch and queue tests passed.

The original failure log is retained unchanged. The updated source excerpt in Vitest’s final stack reflects the file edit made after that test failed; its recorded Expected 1 / Received 0 values preserve the original assertion result.

TED Checks: Typecheck and Lint passed; the final rerun after removal of the disposable capture test also passed. Test-first direct public-interface assertions reproduced incorrect labels, summed Quit totals, held-launch counts, missing queued Tasks and missing preparation for revival, then passed after their corresponding changes.

Existing regression tests cover:

| Public interface | Coverage |
| --- | --- |
| Display helpers | Slots versus limits, zero/one/many, queued-only, above-limit, load hold; Quit’s separate totals, starting-only work and existing choices |
| Renderer app | Live sidebar/Settings updates, reconnection, existing working/queued popover and navigation |
| TedStore | Actual unfinished versus held launches; paused and idle Runs; duplicate queue IDs; queued/starting/live transitions; revival; activity update events |
| Daemon HTTP | Queued Tasks, setup holds, waiting and resumed-above-limit Runs; each queue source; queued sub-agents and existing Coordinator follow-up turns |
| Native Electron app | Background/quit/menu behavior and hidden-window screenshots of mixed and above-limit occupancy |

The required daemon/protocol run explicitly names the files listed in `node_modules/.cache/ted136-design/test-files.txt` (171 files, including four affected app tests). Logs are `tests.log`, `component-tests.log` and `native-tests.log` in that directory. The disposable capture test has been removed from the app test folder and preserved only as `capture-native.test.ts` in the cache. No GitHub workflow was started.

## Manual security review

The new source methods only report IDs already owned by the daemon’s queue sources. The store setter is internal and changes transient reporting state only. The existing Activity response carries an optional number for starting work. No route authorization, Run token authority, process-launch arguments, environment, credentials, filesystem access or Quit action changes were introduced.

## Native captures

The Task thread attaches `implemented-mixed.png`, `implemented-above-limit.png` and `implemented-quit.json` from the cache folder. The real sidebar was captured in a hidden Electron test window and visually checked; the above-limit count wraps cleanly within the existing sidebar. The Quit JSON is the production dialog model for that same real daemon state: two unfinished Runs and one queued item. No human screen, mouse or keyboard was used.

## Required main integration

After the user accepted the recorded timing uncertainty, TED refused the Work hand-off because main at `8a8ad3bbfe6649f1f9dff4e33e299b3d25ef48ef` conflicted with the branch. That exact main commit was merged. The sole conflict was the store schema import list: keep main’s `severityDeclarations`, and keep this Task’s removal of the unused `sideChats` table import. The reporting implementation and queue summary survived unchanged; main’s Check timing, request/review and Task history changes were retained. Typecheck and Lint passed on the merged tree. Fresh merged-tree verification is required/queued; the earlier counts above describe the pre-merge run. The earlier failure acceptance is historical and must not be treated as current after this merge.
