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

Before the final main integration: the required merged-code run passed 188/191 files and 2,152/2,155 tests. Its three failures remain preserved: two timeout cases and an over-specific recovery-resume test assertion. After correcting only that assertion, all 50 tests across the three affected files passed on the final code. The exact two timeout cases also passed on the merged base (three parameterized cases). Typecheck and Lint pass. Corrected renderer coverage passed 3/3 files and 11/11 tests; agent-health passed 8/8. The original broad run is not relabeled passing. The timeout cause is still unestablished; these successful repeats support timing sensitivity without proving it unrelated to this Task.

The original pre-merge 171-file run retained two failures:

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

## Validate round 1

Reviewer Run `71d02924-4cc0-4d3e-aaa2-96bc705664ce` reviewed `a33232e7`. Standards review found no confirmed violations. Correctness review found one blocking P2: a finished Task Lead waiting for automatic recovery lives in `awaitingRevive`, outside the normal queued/held Task records and registered queue sources. Until its revival acquires a start hold, Activity omits that pending work. The Task returned to Work with this Finding; no code was committed during review. The fix must report valid pending recovery Tasks once without changing recovery scheduling.

Current merged-revision evidence: hand-off Typecheck and Lint passed, as did PR #143 CI. The corrected agent-health file passed all eight tests. Four component expectations originally used limit 6 against a limit-3 fixture; only the test literals changed in `a33232e7`. Their three-file rerun is still queued. The merged 191-file daemon/protocol and affected-app run was deferred before collection at TED-8’s request so its focused repairs can finish; no result exists for that attempt.

A fresh hidden Electron trial used this Task’s `node_modules/.cache/ted-home`. First-run setup was completed only there. Current light-mode sidebar and Limits captures (`validate-sidebar.png`, `validate-limits.png` in the cache, attached to the Task) clearly show “0 slots in use · limit 6”. The window was closed after capture. Figma could not be read because its MCP View-seat call limit was reached; images were judged against the approved Design. The isolated `pnpm ted dev slow` trial answered with no slow requests or blocked event loop. Historical populated/above-limit captures remain separate from these current empty-state captures.

The latest failure acceptance became stale after the recovery regression test changed the tree. Earlier, creating PR #143 introduced CI into a previously CI-free tested context and invalidated an acceptance without changing code. Original failure results and all historical decisions remain recorded; none is a passing test result or approval of a later code revision.

## Recovery-count repair

The initial HTTP regression ran before production edits and failed as expected: Activity returned `{ active: 1, working: 1, queued: 0 }` while a finished Task Lead awaited a free recovery slot; expected queued was 1. Original output is retained as `recovery-red.log`. The corrected renderer repeat also completed: 3/3 files and 11/11 tests passed.

The minimal repair adds `queuedTasks` to the internal queue activity snapshot. Tasks supplies `awaitingRevive` IDs filtered through `pendingRevive`, independently of slot readiness or agent pauses. TedStore unions these IDs with its existing queued and held Task IDs before applying its existing duplicate, starting-work and live-Lead exclusions. Recovery admission, execution and scheduling are unchanged. Snapshot fixtures now include the required field and duplicate IDs. The HTTP regression also checks that the queued count returns to zero after revival.

Typecheck and Lint passed after this source change. The focused `failures.test.ts` and `store.test.ts` verification is queued (`recovery-green.log`), not yet passing. Required broad daemon coverage remains outstanding. The user chose Keep waiting for shared test capacity; no peer process or lock was altered.

The same recovery-slot regression now covers both revival and Stop while waiting. Both require one queued item initially. Revival requires two actual unfinished Runs and no queued item afterward; Stop requires the queued item to disappear and the stopped Lead not to restart when the slot becomes free. This adds coverage only, without another production change. Focused and broad verification remain pending.

## Broad recovery verification

The required 191-file run completed on the production repair with 188 files and 2,152 tests passing; three files each had one failure. The Stop-while-recovery-is-queued case passed with the corrected public Task status. All store/other reporting regressions passed. Failures retained in `recovery-broad.log`:

1. The existing `failure-merge.test.ts:62` acceptance/obligations/Gate test again timed out after 30 seconds. This is the original recorded uncertainty, not a new passing result.
2. The recovery-resume test expected both Runs to be idle after revival. Actual active 2 / working 1 / queued 0 correctly reports a resumed working Run and no queued recovery. The final assertion now matches only the promised active 2 / queued 0; no production change.
3. `task-lead.test.ts` · “Stop holds Task Lead messages until send-now, including after an effort change” timed out waiting for Stop and pending effort to be applied. Cause is not established. Compare this exact test on the base and repeat focused verification before assessing it.

The earlier two-file focused run passed the store file but failed the same over-specific resume assertion and an already-corrected private-field assertion in the Stop test. That run loaded the old Stop assertion before its correction; the original Expected true / Received undefined output is retained. Direct Typecheck caught the private-field error and passed after using `status.kind`. Logs are `recovery-green.log`, `recovery-final-typecheck.log` and `recovery-public-status-{typecheck,lint}.log`.


## Final focused and base results

Final source/test revision `5247512f` passed all 50 tests across `failures.test.ts`, `failure-merge.test.ts` and `task-lead.test.ts` in `recovery-corrected-tests.log`. Both new recovery cases passed: one queued item while the finished Lead waits; no queued recovery after revival or Stop; stopping prevents revival after the slot becomes free. This verifies Validate Finding 1 without changing recovery scheduling.

An exact archive of merged base `8a8ad3bb` passed both timeout-test files and all three selected parameterized cases in `base-timeout-repeat.log`. Workspace dependencies were installed offline and `@ted/protocol` was verified to resolve inside that snapshot. The comparison ran from `.claude/worktrees/ted136-baseline`, an ignored folder inside this worktree. The initial comparison under `node_modules` was canceled before collection because Node refuses TypeScript child paths there; its log is not a test result. No peer process or shared lock was changed.

Direct Typecheck and Lint pass in `recovery-corrected-typecheck.log` and `recovery-corrected-lint.log`. TED’s manual Checks command refused “already moving” despite the Task being in Work; this is recorded separately from the passing direct commands and does not claim final Factory hand-off Checks ran.

The historical broad timeouts remain in failure cases `c3d148b7-d555-4f2f-ba94-bbfa8ceecc46` (merge acceptance) and `7007c3c6-242c-4236-bea4-87f04ddae284` (Stop/effort). Both exact cases now pass on this branch and the base, but no causal timing repair was made. These Work-reported cases require the user’s decision; the Task Lead cannot close them with `failure verify`, which is limited to eligible Validate failures. Recommend accepting the retained timing uncertainty with the original broad results and successful repeats both visible. Acceptance is not a passing test result or merge approval.

This final evidence update changes documentation only. Production code is unchanged since `cf6ec880`; the subsequent test corrections and evidence commits do not require repeating the 188 other passing broad files. No additional verification is pending.


## Final main integration and next validation

Before requesting another failure decision, merge readiness found two conflicts against main. Exact main `c49fd4b2c20a2b3005ab926739548b64b9488ee2` was merged. Both conflicts were in the Automation test files. Main’s human-authored `d0295522` intentionally starts Automations and drafts despite slot/load holds. The resolution preserves that scheduling behavior and its assertions, while retaining this Task’s Activity assertions with the corresponding actual totals: active 2 / queued 1 (one ordinary Task waits). Both `Activity` and `Task` imports are retained. No production scheduling change was introduced by this Task’s resolution. The recovery snapshot and start-ID source methods survived the automatic source merges.

Typecheck, Lint and `ted workflow check` passed on the merged tree (`merge-c49-typecheck.log`, `merge-c49-lint.log`). Dependencies were installed with package scripts disabled, using this Task’s existing pnpm store to preserve its cache and trial home. A flat evidence backup is retained in `.claude/worktrees/ted136-evidence-pre-merge`. All files remain inside this Task’s worktree or its own configured dependency cache.

Main now requires agents to run test files only in Validate, once per visit, with at most three files. No test files were run in Work after integrating that rule. The next Validate selection is `failures.test.ts`, `automation-drafts.test.ts` and `automations.test.ts`: recovery/Stop behavior plus both conflict resolutions. Earlier broad and focused results above remain pre-integration evidence, not claims that this final merged tree was tested. All other changed test files should be named as coverage limitations in the Validate note under the new cap. Original timeout histories and their passing branch/base repeats remain preserved for the user’s decision in their fresh final context.

## Latest base conflict repair

The user requested another base integration after GitHub reported PR #143 conflicted. Merged exact main `6123d244375d27240598d31c6ea19efb96e961f2`; Git resolved this integration automatically. The reporting-only diff against that base retains valid pending-recovery IDs, the queue/start/live union, and all upstream Task-history observation refreshes. No recovery scheduling was changed. Typecheck, Lint and workflow validation pass (`merge-6123-typecheck.log`, `merge-6123-lint.log`). Manual `ted checks` still refuses “already moving”; direct static results are not Factory Check results. No test files ran in Work. The three selected Validate files remain unchanged.

The earlier failure decision requests were captured before this required integration. Fresh evidence and assessments must name the new committed context; neither old approval nor passing pre-integration repeats are a claim that the latest merged tree passed tests. Main now has an opt-in Task Lead verification path, but no fresh passing test on this integration exists to justify using it here.

## Lifecycle extraction integration repair

Round 2 Validate passed on c30595b2: selected failures/automation-drafts/automations files passed 57 tests; exact base 6123d244 passed the same files/56 tests; fresh Factory Typecheck/Lint, reviewer and current screenshots passed. No code changed after its reviewer started. TED advanced to Merge. PR CI run 43121248525 then found the combined-code Typecheck failure: the reporting hook referred to awaitingRevive/pendingRevive after main’s lifecycle extraction moved them into lead-lifecycle.ts. That failure and original CI log remain attached; the Task returned to Work.

Integrated exact main 291318198eda7791f43b0414545315afaa37fc71 automatically. The narrow repair exposes pendingRecoveryTaskIds(): readonly string[] from the lifecycle owner, returning a new array filtered through its private pendingRevive predicate. Tasks uses that snapshot for QueueActivity. No scheduling query, mutable collection, admission or RunManager behavior changes. The store’s normal/held/starting/live union remains intact. Added three lifecycle-boundary cases: pending recovery remains visible under agent pause/load/disk holds, then disappears after Stop, archive or revival. Existing HTTP recovery tests remain the end-to-end seam.

Work ran no test files. Typecheck and Lint pass on integrated source (cache lifecycle-integration-typecheck.log and lifecycle-integration-lint.log); Lint reports three preexisting non-null assertion warnings in main’s packages/app/test/app-runs.test.ts:115–118. Workflow validation reports no problems. Next Validate selects lead-lifecycle.test.ts, failures.test.ts and store.test.ts under the three-file cap. Other affected coverage and earlier results remain recorded separately; no claim these new cases have passed yet.

The user closed the historical merge-timeout case as fixed (“Fixed on main”). Stop/effort acceptance was invalidated when CI changed despite unchanged source; its attempted renewal was rejected as CI changed again. Defer a fresh context/assessment until this integration and its Checks are committed. Do not reuse historical acceptance for changed code or relabel any failed run as passing.
