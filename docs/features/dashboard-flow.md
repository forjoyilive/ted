# Dashboard Flow

Flow sits below completion metrics in a Factory’s Dashboard and shares the 7-day, 30-day and all-retained-history selector. Every result in a response uses one as-of instant. Fixed periods are rolling, half-open intervals: the beginning is included and the end is excluded. The previous period is the immediately preceding equal interval. All retained history has no comparison.

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

The reader batches Factory-scoped Task IDs and reads only structured Stage, archive, transition, judgment and Check history. Validation snapshots retain the failure decisions and merged Check results that applied to that visit. Stage-change boundaries cover transitions without Stage-entry metadata. No Run log file, Conversation or attachment is read. Deleted Tasks cannot contribute.

Calculation, persistence/API and UI coverage lives in `packages/daemon/test/dashboard.test.ts`, `packages/daemon/test/dashboard-api.test.ts` and `packages/app/test/dashboard-component.test.tsx`. Run them only in Validate under this Factory’s rules.
