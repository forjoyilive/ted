# Dashboard Flow

Dashboard has three tabs: Overview preserves completion metrics and charts; Flow shows observed activity, independent wait reasons and rework; Stages shows elapsed time in each Stage. Overview is the default. Switching tabs retains the period, closes an open sample drawer and uses the existing Dashboard screen state to remember the selected tab. All three share the Today, 7-day, 30-day and all-retained-history selector. Every result in a response uses one as-of instant. The 7-day and 30-day periods are rolling, half-open intervals: the beginning is included and the end is excluded. Their previous period is the immediately preceding equal interval. Today runs from midnight in the daemon machine’s local time to the as-of instant; its previous period is yesterday from midnight to the same time of day, so every figure and percentage compares equal stretches. Overview’s charts draw Today by clock hour and draw all of yesterday’s hours, including those after the comparison ends. All retained history has no comparison.

## Working time and independent waits

Flow’s subtitle is “See where Tasks spend time and what holds them up.” The compact overview shows observed Run working time and running Check command time separately, followed by the largest three measured waiting reasons. A disclosure exposes every remaining reason: open user requests, Run-slot waits, Check-slot waits, test-lock waits, GitHub waits, agent pauses, blockers and stopped time. Optional Quick guide and lower explanation/coverage disclosures keep the overview short. Each row opens distributions and Task evidence, sorted by measured duration.

Working/waiting uses the same active-in-period cohort and clipping rules as Stage time below, including Backlog exclusion. For each reason and Task, union overlapping intervals before summing. Different reasons can overlap; their durations and percentages cannot be added. Observed working state is not proof of productive effort. Running Check time measures the command, including any reported test-lock wait inside it, rather than active test execution. A Check-associated invocation exposes the command interval and its confirmed overlapping wait; neither reason subtracts the other. External CI remains a GitHub wait.

Every reason returns a measured total, median, middle-50% range, per-Task measured/unavailable samples, full/partial/unavailable coverage counts and clipped contributor evidence. Partial samples enter distributions as measured values, with a warning that actual elapsed time may be larger. Known absence enters as zero only where supported; missing records never become zero. An empty cohort has a zero measured total and unavailable distribution.

Structured observation history preserves recording start dates and known/unknown spans, including daemon downtime and unreconciled Run state. Durable request, blocker, stop and queue evidence remains useful in older homes. Check timing distinguishes queue entry/admission from execution, including measured immediate admission, cancellation and recovery with an unknown end. An interruption’s detection time does not become a guessed final timestamp.

Test-lock evidence uses registered invocation reports, including attributed direct-agent commands and Check run/position associations. Only closed report pairs contribute confirmed waits; an open wait retains its start without an invented final duration. Reporting completion does not establish test success. Coverage stays explicit for unsupported, unreported and incomplete invocations, executed Checks without reports, omitted Check references and the 256-invocation recording limit. Direct commands that never registered cannot be counted; a complete supported invocation can establish its own zero wait, never full coverage of all commands on a Task. Other runners and compound/wrapped Check commands remain outside supported instrumentation.

“Worth a look” identifies the largest confirmed measured waiting reason and a contributing Task. It describes recorded time, not estimated impact or a cause. Sparse evidence shows coverage guidance; missing evidence may hide larger delays. Existing Task history provides the request/answer, blocker, queue or GitHub evidence to investigate. A historical delay may already be resolved. The view neither answers requests nor changes settings or starts work.

## Comparisons and explanations

Current hours use compact units such as 12h or 1.5h. Inline signed percentages compare the immediately preceding equal period: `(current − previous) / previous × 100`. Shorter waits/Stage time are green; longer are red. Observed activity and running Check duration changes are neutral because direction alone is not good or bad. Zero change is neutral; zero or unavailable baselines cannot produce a percentage. All retained history shows no comparison. Raw prior values, distributions and each period’s samples/coverage remain available in the evidence drawer. A color indicates measured direction, not improvement independent of sample and recording changes.

“Middle Task” means median. “Middle 50%” means the 25th–75th percentile range, with an example: waits of 0h, 1h, 2h, 3h and 10h have median 2h and middle 50% 1–3h. The range describes spread, not a target, forecast or confidence score. Largest Task delays expose waits outside that typical range.

## Elapsed Stage time

The sample includes retained non-setup Tasks whose lifetime from first recorded Intake through first Done or archive overlaps the period. Tasks now Done or archived can contribute. Unfinished Tasks run up to as-of. The first archive remains a cutoff after a Task is restored. Backlog time never contributes.

Clip every recorded Stage interval to the period and lifetime, then add repeated visits per Task and Stage. The total is Task-hours across those samples, including waits, stops and rework. It is wall-clock time, not agent effort. Tasks without a measured visit do not add zero samples. A recorded zero-length visit inside the cohort is a zero sample.

Median and quartiles use linear interpolation on sorted per-Task times: position `(n − 1) × p`, with `p` equal to 0.25, 0.5 or 0.75. Empty samples have zero measured total and unavailable distribution statistics. Sample drawers expose the contributing clipped intervals and Task history.

Missing first Intake or a final endpoint is disclosed. Invalid or out-of-order timestamps exclude that Task’s untrustworthy timing; missing history never adds guessed time. The incomplete-history sample lists the reasons. A zero measured total therefore need not mean no work happened.

## Send-backs

Count durable actual send-back records whose timestamps fall inside the period, grouped by source and destination Stage. Counted and uncounted transitions both contribute; only the former count toward limits. Affected Tasks are distinct within each group and across the period. Pending send-back questions, Loop check questions and retries contribute no transition. A missing cause stays unavailable.

The transition drawer includes timestamps, counting status and links to the Task’s existing history. No recorded send-backs describes retained records, rather than proving complete historical coverage.

## First-pass Validate

This uses the completed-Task cohort of the completion metrics above, rather than the Stage-time cohort. Those metrics still use the latest recorded Done entry. Setup Tasks are excluded. For each Task, inspect only its first recorded Validate visit and the evidence recorded within that visit. Durable event order separates visits and judgments with equal timestamps.

The rate is passing fully recorded first-visit outcomes divided by all fully recorded first-visit outcomes. A pass needs recorded passing Checks, review and applicable visual verification, without an actual send-back on that visit. Accepted failed Checks and judgments stay failed, even if TED permitted the Stage to advance. A later passing visit does not replace the first result. A substitute reviewer’s passing result remains valid; the preferred agent being unavailable does not mean review was skipped.

Explicitly skipped Checks, empty Check runs, unknown verification and no recorded Validate visit appear separately outside the denominator. Missing visual verification or applicability is unknown; existing records do not always distinguish an omitted visual result from a nonvisual Task. An empty denominator shows Unavailable. A known failure with other required evidence missing remains outside the denominator, with the known failure described in its evidence.

## Retained data and verification

The reader batches Factory-scoped Task IDs and reads only structured Stage, archive, transition, judgment and Check history. Validation snapshots retain the failure decisions and merged Check results that applied to that visit. Stage-change boundaries cover transitions without Stage-entry metadata. Working/waiting inputs also batch Task/Run/sub-agent and blocker boundaries, observation/agent windows, request metadata, Check timing and bounded invocation reports. Existing interval reducers remain the source of wait/recovery semantics. There are no per-Task HTTP requests. No Run log file, Conversation or attachment is read. Machine-wide CPU/memory and restart diagnostics are not attributed to Factories. Deleted Tasks cannot contribute.

Calculation, persistence/API and UI coverage lives in `packages/daemon/test/dashboard.test.ts`, `packages/daemon/test/dashboard-api.test.ts` and `packages/app/test/dashboard-component.test.tsx`. Run them only in Validate under this Factory’s rules.

The retained-data fixtures include 1,000 Tasks for pure calculation and the public store reader. They report elapsed calculation/read time and response size when run in Validate; no performance result is claimed merely because the fixtures exist.
