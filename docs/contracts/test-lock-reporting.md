# Test-lock reporting, version 1

A report measures only an explicitly reported test-lock wait. It never changes a Task, a Check result, a Run’s state, a Gate or a command’s outcome. Console text and silence are not inputs. This contract is implemented here; TED-159 will instrument the test runner. Until then, ordinary test commands produce no measurements.

## Registration and ownership

`POST /tasks/:task/test-invocations` takes `RegisterTestInvocation` from `packages/protocol/src/test-invocations.ts`. Generate a lowercase UUID once per test command and reuse it on retries. Supply `supported: true` when the runner implements this contract, or `false` to explicitly declare unsupported reporting. An optional label is at most 120 characters; it is redacted and stripped of control characters before storage. Do not send a command line, output, paths, prompts or credentials as a label.

A Run may register only on its own Task. The authenticated Run determines `runId`; the body cannot provide or change it. Runs cannot claim a Check association. TED can register with `checkRunId` and zero-based `position` only while that Check is running on the same Task. The app-authorized route and `TedStore.testInvocations.register` support this association; runner instrumentation and launch environment wiring are deferred to TED-159.

Registration returns the invocation and a reporting-only token. An identical registration retry returns the same invocation and token; a reused ID with different ownership or registration fields is a conflict. There are at most 256 invocations per Task, across all Runs and Checks; reaching the limit is explicit and never permits ID reuse. Further commands continue without measurements. Task deletion removes materialized invocation rows along with the Task’s other data.

## Runner interface

Use `DaemonClient.tryRegisterTestInvocation` against an already discovered daemon from the owning agent or TED. It has a 500 ms absolute deadline and returns `undefined` on failure. Give the runner only the returned reporting token, invocation ID and loopback daemon connection information. Do not forward the app key or an ordinary Run credential to a Check runner, write a credential to a log or disk, or discover/start a daemon as part of reporting.

Create a `DaemonClient` with that reporting token and call `reportTestInvocation(id, report)`. This also has a 500 ms absolute deadline, consumes the response and returns `false` on any error, including malformed responses, connection failures or rejection. Neither method starts a daemon, retries forever, changes exit status or throws reporting failures. A caller must continue its command independently of reporting success. The normal registration method and CLI are administrative interfaces, not the fail-soft runner path.

No new environment variables or filesystem/network sandbox exceptions are introduced by this Task. Future launch wiring must use the classified TED environment and command environment modules and existing sandbox, never expose the app key, and preserve the reporting-only restriction.

## Reports and retries

`POST /test-invocations/:id/reports` accepts only that invocation’s reporting token. It accepts exactly `sequence`, `kind` and `at`; unknown fields are rejected. Sequence starts at zero and increases by one. At most 64 reports are retained; the last slot must be terminal. Report timestamps are integer Unix milliseconds, nondecreasing, no earlier than registration, no more than five seconds ahead of the daemon clock, and within seven days of registration. Invalid reports make no changes.

| Kind | Meaning |
| --- | --- |
| `wait-start` | The command explicitly began waiting for a test lock. Cannot nest. |
| `wait-end` | The open wait ended; the command may now run. Requires an open wait. |
| `finished` | Reporting ended normally. Requires no open wait; says nothing about passing tests. |
| `canceled` | The command was canceled at this timestamp; also closes an open wait. |
| `interrupted` | The command was interrupted at this timestamp; also closes an open wait. |

An exact retry of an accepted sequence is a no-op, including after the owner ends. A conflicting duplicate, a sequence gap or a report after a terminal report is rejected. Reuse the original timestamp on retries. There is no reordering buffer. A caller that loses delivery can retry within its own bounded budget or stop reporting and continue the command. HTTP request bodies retain the existing 1 MiB transport cap; valid payloads contain only the fields above.

## Reading and incomplete measurements

`GET /tasks/:task/test-invocations`, `DaemonClient.testInvocations` and `ted test-invocations [--task <id>]` return structured metadata. Run readers are restricted to their own Task. `ted test-invocations register --file <json>` is available for explicit registration; its response contains a credential and must be captured privately.

`confirmedWaitMs` sums closed wait intervals exactly once. An open wait carries `openWaitStartedAt`; it contributes no invented duration. `outcome` is present only after an explicit terminal report. Coverage is:

- `unsupported`: registration explicitly declared no reporting support.
- `unreported`: a supported live invocation has no reports, or an executed Check has no registered invocation.
- `reported`: one or more explicit reports exist, with any open wait still identified.
- `incomplete`: a supported invocation has no terminal report and its owning Run or Check has ended. Confirmed intervals remain available; no final timestamp or test outcome is inferred.

Owner termination is materialized from durable Run/Check events. It stays ended even if a Run is revived; register a new invocation for a new command. A Check ending closes coverage for its position immediately, without waiting for the whole Check run. Abrupt termination with no final report therefore remains incomplete rather than being mislabeled canceled. If TED itself has not yet recorded the owner ending, coverage remains open until it does.

The report includes unreported executed Checks. It returns at most 256 such references and explicitly counts any omitted references. Checks that never started are not treated as executed commands. The existing durable Check-start boundary preserves missing-report coverage for an interrupted Check even when its final Check state is `not-run`. An invocation list is capped at 256, each with at most 64 boundaries. Direct commands TED never hears about cannot be counted or distinguished as supported; every summary explicitly states they are outside coverage. No desktop display is added.

`v1.TestInvocationRecorded` stores bounded metadata, never command logs or credentials. Owner-end columns are rebuilt from the same event history. Measurements and incomplete coverage therefore survive replay and output retention independently of logs. Reported timing is self-reported evidence, not proof that a test really waited or passed.

## Security review and verification

Manual review of the implemented reporting seam:

- Authentication retains loopback Host and browser Origin restrictions. Reporting tokens use the existing HMAC signer with a reserved `test-report:` subject. The server permits that subject only on the exact POST path for its own invocation, before ordinary Run authorization. It cannot become an app, file-token or ordinary Run caller. The route checks the same subject again.
- Registration derives Task/Run ownership from authenticated state, checks active Check ownership and position, and rejects body-supplied ownership or unknown fields. Reporting tokens cannot register, read summaries, execute Checks or Runs, change settings, post outcomes or answer requests.
- Bounds constrain field sizes, identifiers, sequences, timestamps, per-Task registrations and returned missing-report references. Exact retries do not write another event. Only a bounded redacted label is retained as free text; errors do not reflect submitted text.
- Successful writes use the server’s existing persistence barrier. Report ordering and terminal state are checked synchronously before committing. Owner termination is part of the original owner-state commit, so a crash cannot reopen an old wait on recovery.
- The runner client aborts requests and response reads at an absolute deadline, including trickled responses. Reporting adds no command runner, filesystem writes, environment bypass or sandbox exemption.

Remaining limitations are intentional: same-user processes are not isolated from each other by authentication, as with existing Run tokens; a stolen reporting credential can falsify only its bounded invocation metadata. Instrumentation has not been installed yet. A failed registration cannot be known as a direct invocation by TED; the summary’s coverage statement preserves that uncertainty.

Focused tests are in `packages/protocol/test/test-invocations.test.ts`, `packages/daemon/test/test-invocations-store.test.ts` and `packages/daemon/test/test-invocations-api.test.ts`. They cover parsing, deadlines, ownership, forbidden authority, duplicate/order rules, timestamps, cancellation/interruption, missing reports, bounds and event-log replay. They are written for Validate; Work runs typecheck and lint only.
