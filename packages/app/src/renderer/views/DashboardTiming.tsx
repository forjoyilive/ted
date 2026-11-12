import type { DashboardFlow, FlowReason, FlowReasonId } from '@ted/protocol'
import type { FlowSelection } from '../dashboard.ts'
import styles from './Dashboard.module.css'
import { hours, StatisticsHelp, TimingChange } from './DashboardMeasures.tsx'

export const reasonNames: Record<FlowReasonId, string> = {
  'run-working': 'Observed Run working',
  'running-check': 'Running Checks',
  'user-request': 'Open user requests',
  'run-slot': 'Run-slot waits',
  'check-slot': 'Check-slot waits',
  'test-lock': 'Test-lock waits',
  github: 'GitHub waits',
  'agent-paused': 'Agent pauses',
  blocker: 'Blockers',
  stopped: 'Stopped time',
}
const measured = (r: FlowReason) => r.samples.filter((s) => s.elapsedMs !== null)
export const reasonValue = (r: FlowReason | undefined): number | null =>
  r && measured(r).length ? r.totalMs : null
export function coverageLabel(r: FlowReason) {
  const counts = { full: 0, partial: 0, unavailable: 0 }
  for (const s of r.samples) counts[s.coverage]++
  const tasks = `${r.samples.length} ${r.samples.length === 1 ? 'Task' : 'Tasks'}`
  if (counts.full === r.samples.length && r.samples.length > 0) return `${tasks} · fully covered`
  const coverage = [
    counts.full ? `${counts.full} fully covered` : '',
    counts.partial ? `${counts.partial} partial` : '',
    counts.unavailable ? `${counts.unavailable} unavailable` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return `${measured(r).length} measured of ${tasks}${coverage ? ` · ${coverage}` : ''}`
}

export function TimingOverview({
  data,
  select,
}: {
  data: DashboardFlow
  select: (s: FlowSelection) => void
}) {
  const all = data.current.reasons
  const activity = all.filter((r) => ['run-working', 'running-check'].includes(r.reason))
  const waits = all
    .filter((r) => !activity.includes(r))
    .toSorted((a, b) => b.totalMs - a.totalMs || a.reason.localeCompare(b.reason))
  const largest = waits.find((r) => r.totalMs > 0)
  const sample = largest?.samples.toSorted(
    (a, b) => (b.elapsedMs ?? -1) - (a.elapsedMs ?? -1) || a.taskId.localeCompare(b.taskId),
  )[0]
  const records = new Map(data.tasks.map((t) => [t.id, t]))
  const choose = (reason: FlowReasonId) => select({ kind: 'reason', reason, period: 'current' })
  const row = (r: FlowReason) => {
    const previous = data.previous?.reasons.find((p) => p.reason === r.reason)
    const partial = r.samples.some((s) => s.coverage !== 'full')
    return (
      <li key={r.reason} className={styles.timingRow}>
        <div>
          <button
            type="button"
            data-nav-item
            className={styles.link}
            onClick={() => choose(r.reason)}
          >
            {reasonNames[r.reason]}
          </button>
          {partial && (
            <span className={styles.partial}>
              {reasonValue(r) === null ? 'Unavailable' : 'Partial'}
            </span>
          )}
          <p className={styles.caption}>{coverageLabel(r)}</p>
        </div>
        <div className={styles.timingNumber}>
          <strong>{hours(reasonValue(r))}</strong>
          {data.previous && (
            <TimingChange
              current={reasonValue(r)}
              previous={reasonValue(previous)}
              neutral={activity.includes(r)}
            />
          )}
          <button
            type="button"
            data-nav-item
            className={styles.link}
            aria-label={`Inspect ${reasonNames[r.reason]}`}
            onClick={() => choose(r.reason)}
          >
            →
          </button>
        </div>
      </li>
    )
  }
  return (
    <section className={styles.flowCard} aria-label="Observed working time and wait reasons">
      <h3>Where time went</h3>
      {largest && sample ? (
        <div className={styles.timingHighlight}>
          <strong>Largest recorded wait: {reasonNames[largest.reason].toLowerCase()}.</strong>
          <p>
            {records.get(sample.taskId)?.displayId ?? sample.taskId} contributed{' '}
            {hours(sample.elapsedMs)} of the {hours(largest.totalMs)} measured total.
          </p>
          <button
            type="button"
            data-nav-item
            className={styles.link}
            onClick={() => choose(largest.reason)}
          >
            Inspect Tasks →
          </button>
          <p className={styles.caption}>
            Based on measured time, not estimated impact. Missing history can hide larger waits;
            historical requests may already be answered.
          </p>
        </div>
      ) : (
        <p className={styles.notice}>
          {data.current.taskIds.length
            ? 'No confirmed positive waits to rank. Inspect coverage before drawing conclusions.'
            : 'No started Tasks in this period. Choose a longer period to look for recorded delays.'}
        </p>
      )}
      <h3>Recorded activity</h3>
      <ul className={styles.timingRows}>{activity.map(row)}</ul>
      <p className={styles.caption}>
        Working state is observed agent activity, not proof of productive effort. Check command time
        includes any reported test-lock wait inside it.
      </p>
      <h3 className={styles.timingHeading}>Largest measured waits</h3>
      <ul className={styles.timingRows}>{waits.slice(0, 3).map(row)}</ul>
      <details className={styles.dataTable}>
        <summary>{Math.max(0, waits.length - 3)} more wait reasons · including test delays</summary>
        <ul className={styles.timingRows}>{waits.slice(3).map(row)}</ul>
      </details>
      <p className={styles.flowFoot}>
        Reasons overlap; their durations and percentages cannot be added.
      </p>
      <details className={styles.dataTable}>
        <summary>Coverage and recording gaps</summary>
        <p>
          Each reason has its own coverage. Open it for recording windows, unknown spans, incomplete
          boundaries and Task evidence. Unknown history is excluded, never treated as zero.
        </p>
        <p>
          Test-lock coverage describes registered invocations and executed Checks, not all commands.
          Unsupported runners, unreported Checks and unfinished reports stay visible. Unregistered
          direct commands are outside coverage. External CI is a GitHub wait.
        </p>
        {all.map((r) => (
          <p key={r.reason}>
            <button
              type="button"
              data-nav-item
              className={styles.link}
              onClick={() => choose(r.reason)}
            >
              {reasonNames[r.reason]} · {coverageLabel(r)}
            </button>
          </p>
        ))}
      </details>
      <details className={styles.dataTable}>
        <summary>How to read Flow</summary>
        <p>
          Task-hours add measured time across Tasks: two Tasks waiting 1h each contribute 2
          Task-hours. These are wall-clock measurements. Started non-setup Tasks open during the
          selected period contribute; Backlog is excluded.
        </p>
        <p>
          Signed percentages compare the preceding equal period. Shorter waits and Stage time are
          green; longer are red. Activity and Check command time stay neutral. Zero or missing
          baselines cannot produce a percentage. Samples and recording coverage may differ, so
          direction alone does not prove improvement.
        </p>
        <p>
          Partial samples may understate delay. Zero needs evidence of absence. Open waits without a
          closing test report have no invented final duration. Reporting completion does not
          establish test success.
        </p>
      </details>
      <StatisticsHelp />
    </section>
  )
}
