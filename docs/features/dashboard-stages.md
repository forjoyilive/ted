# Dashboard Stages

Dashboard has three tabs: Overview preserves completion metrics and charts; Stages shows elapsed time in each Stage; Cost shows what Runs spent. Overview is the default. Switching tabs retains the period, closes an open sample drawer and uses the existing Dashboard screen state to remember the selected tab. A remembered tab that no longer exists opens Overview. All three share one period selector, listed from shortest to longest: Today, Last 7 days, Last 30 days, Last 90 days, Last 12 months, This week, This month, Year to date and All time (`dashboardRanges` in `packages/protocol/src/dashboard.ts`). Every result in a response uses one as-of instant, and every period is half-open: the beginning is included and the end is excluded. The rolling periods (7, 30 and 90 days, 12 months) end at midnight this morning, so today is not included; their previous period is the immediately preceding equal interval, and 12 months starts on the same date a year earlier. Today, This week, This month and Year to date run from their start in the daemon machine’s local time to the as-of instant, and their previous period runs to the same point: yesterday to the same time, last week to the same weekday and time, last month to the same day and time, last year to the same date and time. A day past the end of a shorter month counts as that month’s last day. Weeks start on Monday. Overview’s charts draw Today by clock hour and draw all of yesterday’s hours, including those after the comparison ends. Other periods get one bar per calendar day up to 31 days; longer ones group days so there are at most 30 bars, the last one possibly shorter. All time has no comparison.

## Elapsed Stage time

The sample includes retained non-setup Tasks whose lifetime from first recorded Intake through first Done or archive overlaps the period. Tasks now Done or archived can contribute. Unfinished Tasks run up to as-of. The first archive remains a cutoff after a Task is restored. Backlog time never contributes.

Clip every recorded Stage interval to the period and lifetime, then add repeated visits per Task and Stage. The total is Task-hours across those samples, including waits, stops and rework. It is wall-clock time, not agent effort. Tasks without a measured visit do not add zero samples. A recorded zero-length visit inside the cohort is a zero sample.

Median and quartiles use linear interpolation on sorted per-Task times: position `(n − 1) × p`, with `p` equal to 0.25, 0.5 or 0.75. Empty samples have zero measured total and unavailable distribution statistics. Sample drawers expose the contributing clipped intervals and Task history.

Missing first Intake or a final endpoint is disclosed. Invalid or out-of-order timestamps exclude that Task’s untrustworthy timing; missing history never adds guessed time. The incomplete-history sample lists the reasons. A zero measured total therefore need not mean no work happened.

## What each Stage bar is made of

Each Stage’s bar splits its time by the first recorded reason that covers each hour: Agent working, Running Checks, Waiting on you, Waiting for a slot, Waiting on GitHub, then Blocked or paused. Other is time no recorded reason covers. Without “Include time waiting for me”, Stage time leaves out the time a Task had an open request to the user, and Tasks without a complete record of those requests are left out and listed.

The reasons come from the same active-in-period cohort and clipping rules as Stage time. For each reason and Task, overlapping intervals are unioned before summing. Running Check time measures the command, including any reported test-lock wait inside it. External CI remains a GitHub wait. Structured observation history preserves recording start dates and known and unknown spans, including daemon downtime and unreconciled Run state; missing records never become zero.

## Comparisons and explanations

Current hours use compact units such as 12h or 1.5h. Inline signed percentages compare the immediately preceding equal period: `(current − previous) / previous × 100`. Shorter Stage time is green; longer is red. Zero change is neutral; zero or unavailable baselines cannot produce a percentage. All time shows no comparison. Raw prior values, distributions and each period’s samples remain available in the evidence drawer. A color indicates measured direction, not improvement independent of sample and recording changes.

“Middle Task” means median. “Middle 50%” means the 25th–75th percentile range, with an example: times of 0h, 1h, 2h, 3h and 10h have median 2h and middle 50% 1–3h. The range describes spread, not a target, forecast or confidence score.

## Retained data and verification

The reader batches Factory-scoped Task IDs and reads only structured Stage, archive and send-back history. Stage-change boundaries cover transitions without Stage-entry metadata. The reason inputs also batch Task, Run and sub-agent and blocker boundaries, observation and agent windows, request metadata, Check timing and bounded test-lock reports. Existing interval reducers remain the source of wait and recovery semantics. There are no per-Task HTTP requests. No Run log file, Conversation or attachment is read. Deleted Tasks cannot contribute.

Calculation, persistence/API and UI coverage lives in `packages/daemon/test/dashboard.test.ts`, `packages/daemon/test/dashboard-api.test.ts` and `packages/app/test/dashboard-component.test.tsx`. Run them only in Validate under this Factory’s rules.
