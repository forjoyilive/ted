import type { DashboardFlow, FlowPeriod, FlowValidateOutcome } from '@ted/protocol'
import { useEffect, useId, useRef } from 'react'
import { CloseIcon } from '../components/icons.tsx'
import type { FlowSelection } from '../dashboard.ts'
import { stageName as label } from '../list-view.ts'
import { formatDate } from '../time.ts'
import styles from './Dashboard.module.css'
import { hours, StatisticsHelp, TimingChange } from './DashboardMeasures.tsx'
import { coverageLabel, reasonNames, reasonValue, TimingOverview } from './DashboardTiming.tsx'

const at = (date: string) =>
  formatDate(date, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    timeZoneName: 'short',
  })
const bounds = (period: FlowPeriod) =>
  `${period.from ? at(period.from) : 'All retained history'} – ${at(period.to)} (end excluded)`
const totalValue = (
  measure: FlowPeriod['reasons'][number] | FlowPeriod['stages'][number] | undefined,
) =>
  measure && 'reason' in measure
    ? reasonValue(measure)
    : measure?.samples.length
      ? measure.totalMs
      : null
const outcomes: Record<FlowValidateOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped verification',
  unknown: 'Unknown verification',
  'no-visit': 'No recorded Validate visit',
}

function StageTable({
  period,
  previous,
  select,
}: {
  period: FlowPeriod
  previous: FlowPeriod | null
  select: (s: FlowSelection) => void
}) {
  return (
    <>
      <p className={styles.caption}>{bounds(period)}</p>
      <ul className={styles.timingRows}>
        {period.stages.map((s) => {
          const prior = previous?.stages.find((p) => p.stage === s.stage)
          const choose = () => select({ kind: 'stage', stage: s.stage, period: 'current' })
          return (
            <li key={s.stage} className={styles.timingRow}>
              <div>
                <button type="button" data-nav-item className={styles.link} onClick={choose}>
                  {label(s.stage)}
                </button>
                <p>
                  <button type="button" data-nav-item className={styles.link} onClick={choose}>
                    {s.samples.length} {s.samples.length === 1 ? 'Task' : 'Tasks'}
                  </button>
                </p>
              </div>
              <div className={styles.timingNumber}>
                <strong>{hours(totalValue(s))}</strong>
                {previous && <TimingChange current={totalValue(s)} previous={totalValue(prior)} />}
                <button
                  type="button"
                  data-nav-item
                  className={styles.link}
                  aria-label={`Inspect ${label(s.stage)} Stage`}
                  onClick={choose}
                >
                  →
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {period.stages.every((s) => s.samples.length === 0) && (
        <p className={styles.empty}>
          No measurable Stage intervals in this period. Total and distribution unavailable.
        </p>
      )}
    </>
  )
}

function SendBacks({ period, select }: { period: FlowPeriod; select: (s: FlowSelection) => void }) {
  const total = period.sendBacks.reduce((n, g) => n + g.transitions.length, 0)
  const counted = period.sendBacks.reduce((n, g) => n + g.counted, 0)
  const tasks = new Set(period.sendBacks.flatMap((g) => g.taskIds))
  return (
    <>
      <p>
        <strong className={styles.flowValue}>{total}</strong> actual transitions ·{' '}
        <button
          type="button"
          data-nav-item
          className={styles.link}
          onClick={() => select({ kind: 'affected', period: 'current' })}
        >
          {tasks.size} Tasks affected
        </button>
      </p>
      <p className={styles.caption}>
        {counted} count toward limits · {total - counted} do not
      </p>
      <div className={styles.flowTable}>
        <table>
          <thead>
            <tr>
              <th>From → To</th>
              <th>Actual</th>
              <th>Counted</th>
              <th>Tasks</th>
            </tr>
          </thead>
          <tbody>
            {period.sendBacks.map((g) => (
              <tr key={`${g.from}-${g.to}`}>
                <th scope="row">
                  <button
                    type="button"
                    data-nav-item
                    className={styles.link}
                    onClick={() =>
                      select({ kind: 'send-back', from: g.from, to: g.to, period: 'current' })
                    }
                  >
                    {label(g.from)} → {label(g.to)}
                  </button>
                </th>
                <td>{g.transitions.length}</td>
                <td>{g.counted}</td>
                <td>{g.taskIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!total && <p className={styles.empty}>No recorded send-backs in this period.</p>}
    </>
  )
}

function FirstPass({ period, select }: { period: FlowPeriod; select: (s: FlowSelection) => void }) {
  const pass = period.firstPass
  return (
    <>
      <p>
        <strong className={styles.flowValue}>
          {pass.percent === null ? 'Unavailable' : `${Number(pass.percent.toFixed(1))}%`}
        </strong>{' '}
        · {pass.passed} of {pass.denominator} recorded first visits passed
      </p>
      <p className={styles.caption}>Completed Tasks in this period · First Validate visit only</p>
      <div className={styles.flowTable}>
        <table>
          <tbody>
            {(Object.keys(outcomes) as FlowValidateOutcome[]).map((outcome) => (
              <tr key={outcome}>
                <th scope="row">{outcomes[outcome]}</th>
                <td>
                  <button
                    type="button"
                    data-nav-item
                    className={styles.link}
                    onClick={() => select({ kind: 'validate', outcome, period: 'current' })}
                  >
                    {pass.samples.filter((s) => s.outcome === outcome).length} Tasks
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.caption}>
        Skipped, unknown and no recorded visit are outside the denominator. Accepted failures remain
        failures.
      </p>
    </>
  )
}

function FlowSample({
  data,
  selection,
  asOf,
  onClose,
  onOpenTask,
  selectPrevious,
}: {
  data: DashboardFlow
  selection: FlowSelection
  asOf: string
  onClose: () => void
  onOpenTask: (id: string) => void
  selectPrevious: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    const opener = document.activeElement
    dialog.current?.showModal()
    const element = dialog.current
    return () => {
      element?.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  const period = selection.period === 'previous' ? data.previous : data.current
  if (!period) return null
  const records = new Map(data.tasks.map((t) => [t.id, t]))
  const title =
    selection.kind === 'reason'
      ? `${reasonNames[selection.reason]} · Measured time`
      : selection.kind === 'guide'
        ? 'Follow the time to the Task'
        : selection.kind === 'stage'
          ? `${label(selection.stage)} · Per-Task elapsed time`
          : selection.kind === 'send-back'
            ? `${label(selection.from)} → ${label(selection.to)} · Actual transitions`
            : selection.kind === 'affected'
              ? 'Tasks affected by send-backs'
              : selection.kind === 'incomplete'
                ? 'Incomplete timing history'
                : `${outcomes[selection.outcome]} · First-pass Validate`
  const items: { key: string; taskId: string; lines: string[] }[] = []
  const reason =
    selection.kind === 'reason'
      ? period.reasons.find((r) => r.reason === selection.reason)
      : undefined
  const stage =
    selection.kind === 'stage' ? period.stages.find((s) => s.stage === selection.stage) : undefined
  const prior =
    selection.kind === 'reason'
      ? data.previous?.reasons.find((r) => r.reason === selection.reason)
      : selection.kind === 'stage'
        ? data.previous?.stages.find((s) => s.stage === selection.stage)
        : undefined
  if (selection.kind === 'reason' && reason) {
    for (const s of reason.samples.toSorted(
      (a, b) => (b.elapsedMs ?? -1) - (a.elapsedMs ?? -1) || a.taskId.localeCompare(b.taskId),
    ))
      items.push({
        key: s.taskId,
        taskId: s.taskId,
        lines: [
          `${hours(s.elapsedMs)} · ${s.coverage} coverage`,
          `Covered Task-time: ${s.coveredMs === null ? 'Unavailable or invocation-specific; inspect the recorded boundaries' : `${hours(s.coveredMs)} of ${hours(s.eligibleMs)}`}`,
          ...s.intervals.flatMap((i) => [
            `${at(i.from)} – ${at(i.to)} (end excluded)`,
            ...i.contributors.map(
              (c) =>
                `${c.id}${c.detail ? ` · ${c.detail}` : ''}: ${at(c.start)} – ${at(c.end)} · ${c.startSource} → ${c.endSource}`,
            ),
          ]),
          ...s.coverageIntervals.map(
            (c) => `${c.state}: ${at(c.start)} – ${at(c.end)} · ${c.source}`,
          ),
          ...s.invocations.map(
            (i) =>
              `Invocation ${i.id}: ${i.coverage} · registered ${at(i.registeredAt)}${i.runId ? ` · direct Run ${i.runId}` : ''}${i.checkRunId ? ` · Check ${i.checkRunId}, position ${i.position}` : ''}${i.openWaitStartedAt ? ` · open wait from ${at(i.openWaitStartedAt)}; final duration unavailable` : ''}${i.outcome ? ` · reporting ${i.outcome}; not a test result` : ''}${i.checkCommand ? ` · Check command ${at(i.checkCommand.from)} – ${at(i.checkCommand.to)}; ${hours(i.checkCommand.overlapMs)} of confirmed wait overlaps the command and also appears in Running Checks` : ''}`,
          ),
          ...s.notices,
        ],
      })
  } else if (selection.kind === 'stage') {
    for (const s of (
      period.stages.find((s) => s.stage === selection.stage)?.samples ?? []
    ).toSorted((a, b) => b.elapsedMs - a.elapsedMs || a.taskId.localeCompare(b.taskId))) {
      const incomplete = period.incomplete.find((i) => i.taskId === s.taskId)
      items.push({
        key: s.taskId,
        taskId: s.taskId,
        lines: [
          `${hours(s.elapsedMs)} · ${s.intervals.length} measured ${s.intervals.length === 1 ? 'visit' : 'visits'}`,
          ...s.intervals.map((i) => `${at(i.from)} – ${at(i.to)} (end excluded)`),
          ...(incomplete?.reasons ?? []),
        ],
      })
    }
  } else if (selection.kind === 'send-back' || selection.kind === 'affected') {
    const groups = period.sendBacks.filter(
      (g) => selection.kind === 'affected' || (g.from === selection.from && g.to === selection.to),
    )
    const transitions = groups.flatMap((g) => g.transitions)
    if (selection.kind === 'send-back') {
      for (const s of transitions)
        items.push({
          key: s.id,
          taskId: s.taskId,
          lines: [
            `${at(s.at)} · ${label(s.from)} → ${label(s.to)}`,
            `${s.counted ? 'Counts' : 'Does not count'} toward limit · Cause: ${s.cause ?? 'Unavailable'}`,
          ],
        })
    } else {
      for (const id of new Set(transitions.map((s) => s.taskId))) {
        const own = transitions.filter((s) => s.taskId === id)
        items.push({
          key: id,
          taskId: id,
          lines: [
            `${own.length} actual transitions · ${own.filter((s) => s.counted).length} counted`,
          ],
        })
      }
    }
  } else if (selection.kind === 'incomplete') {
    for (const s of period.incomplete)
      items.push({ key: s.taskId, taskId: s.taskId, lines: s.reasons })
  } else if (selection.kind === 'validate') {
    for (const s of period.firstPass.samples.filter((s) => s.outcome === selection.outcome))
      items.push({
        key: s.taskId,
        taskId: s.taskId,
        lines: [
          ...(s.enteredAt
            ? [`First visit: ${at(s.enteredAt)}${s.exitedAt ? ` – ${at(s.exitedAt)}` : ''}`]
            : []),
          ...s.reasons,
          ...s.checkRunIds.map((id) => `Check run: ${id}`),
          ...s.failureIds.map((id) => `Failure case: ${id}`),
        ],
      })
  }
  return (
    <dialog
      ref={dialog}
      data-nav-dialog
      className={styles.dialog}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className={styles.sampleHead}>
        <h2 id={heading}>{title}</h2>
        <button
          type="button"
          className={styles.close}
          aria-label="Close Flow sample"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <p>
        {selection.period === 'previous' ? 'Previous period' : 'Selected period'} · {bounds(period)}
      </p>
      <p className={styles.caption}>
        As of {at(asOf)} · {items.length} {selection.kind === 'send-back' ? 'transitions' : 'Tasks'}
        . Open a Task for its existing history and verification evidence.
      </p>
      {selection.kind === 'guide' && (
        <>
          <h3>1. Start with one reason</h3>
          <p>
            Task-hours add measured time across Tasks. Signed percentages compare the preceding
            equal period.
          </p>
          <h3>2. Open it to investigate</h3>
          <p>
            See the largest Task delays, typical range, per-period samples and recorded intervals.
            Use Stages for elapsed time by Stage and Overview for completions.
          </p>
          <h3>3. Check the gaps</h3>
          <p>
            Reasons overlap; durations and percentages cannot be added. Partial history can hide
            time. A reported test-lock wait may also be inside a running Check command.
          </p>
        </>
      )}
      {(reason || stage) && (
        <>
          <div className={styles.timingStats}>
            <div>
              <small>Total Task-hours</small>
              <strong>{hours(totalValue(reason ?? stage))}</strong>
              {selection.period === 'current' && data.previous && (
                <TimingChange
                  current={totalValue(reason ?? stage)}
                  previous={totalValue(prior)}
                  neutral={
                    selection.kind === 'reason' &&
                    ['run-working', 'running-check'].includes(selection.reason)
                  }
                />
              )}
            </div>
            <div>
              <small>Middle Task · median</small>
              <strong>{hours((reason ?? stage)?.medianMs ?? null)}</strong>
            </div>
            <div>
              <small>Middle 50%</small>
              <strong>
                {hours((reason ?? stage)?.p25Ms ?? null)} –{' '}
                {hours((reason ?? stage)?.p75Ms ?? null)}
              </strong>
            </div>
          </div>
          {reason && <p>{coverageLabel(reason)}. Partial measured samples may understate delay.</p>}
          {selection.period === 'current' &&
            data.previous &&
            (selection.kind === 'reason' || selection.kind === 'stage') && (
              <details className={styles.dataTable}>
                <summary>Comparison evidence</summary>
                <p>
                  Previous total: {hours(totalValue(prior))} · Middle Task:{' '}
                  {hours(prior?.medianMs ?? null)} · Middle 50%: {hours(prior?.p25Ms ?? null)} –{' '}
                  {hours(prior?.p75Ms ?? null)}.
                </p>
                <p>
                  {prior && 'reason' in prior
                    ? coverageLabel(prior)
                    : `${prior?.samples.length ?? 0} measured Tasks`}
                  . Each period has its own Tasks and coverage; direction alone does not prove
                  improvement.
                </p>
                <button
                  type="button"
                  data-nav-item
                  className={styles.link}
                  onClick={selectPrevious}
                >
                  Inspect previous-period Tasks
                </button>
              </details>
            )}
          <StatisticsHelp />
        </>
      )}
      <ul className={styles.taskList}>
        {items.map((item) => {
          const task = records.get(item.taskId)
          return (
            <li key={item.key} className={styles.flowSampleItem}>
              <button
                type="button"
                data-nav-item
                className={styles.task}
                onClick={() => onOpenTask(item.taskId)}
              >
                {task?.displayId ?? item.taskId} &nbsp; {task?.title} · Open history
                {task?.archived ? ' · Archived' : ''}
              </button>
              {selection.kind === 'stage' && task && (
                <p className={styles.caption}>
                  {task.endReason === 'open'
                    ? 'Open at the as-of instant'
                    : task.endReason === 'unknown'
                      ? 'Lifetime endpoint unavailable'
                      : `${task.endReason === 'archived' ? 'Archived' : 'Done'} ${task.endedAt ? at(task.endedAt) : ''}`}
                </p>
              )}
              {(selection.kind === 'stage' || selection.kind === 'reason') && (
                <p className={styles.caption}>{item.lines[0]}</p>
              )}
              <details
                className={styles.dataTable}
                open={selection.kind !== 'stage' && selection.kind !== 'reason'}
              >
                <summary>Interval evidence</summary>
                {[...new Set(item.lines)].map((line) => (
                  <p className={styles.caption} key={line}>
                    {line}
                  </p>
                ))}
              </details>
            </li>
          )
        })}
      </ul>
      {!items.length && selection.kind !== 'guide' && (
        <p>No Tasks or transitions in this sample.</p>
      )}
    </dialog>
  )
}

export function Flow({
  data,
  asOf,
  panel,
  selection,
  select,
  onClose,
  onOpenTask,
}: {
  data: DashboardFlow
  asOf: string
  panel: 'flow' | 'stages'
  selection?: FlowSelection | undefined
  select: (s: FlowSelection) => void
  onClose: () => void
  onOpenTask: (id: string) => void
}) {
  const heading = useId()
  const previousSelect = (s: FlowSelection) => select({ ...s, period: 'previous' })
  return (
    <section className={styles.flow} aria-labelledby={heading}>
      <header className={styles.flowHead}>
        <div>
          <h2 id={heading}>{panel === 'stages' ? 'Time by Stage' : 'Flow'}</h2>
          <p className={styles.caption}>
            {panel === 'stages'
              ? 'See which Stages take time, including waits and repeat visits.'
              : 'See where Tasks spend time and what holds them up.'}
          </p>
        </div>
        {panel === 'flow' && (
          <button
            type="button"
            data-nav-item
            className={styles.link}
            onClick={() => select({ kind: 'guide', period: 'current' })}
          >
            Quick guide ↗
          </button>
        )}
      </header>
      <p className={styles.caption}>
        {data.current.taskIds.length} Tasks with a recorded Intake boundary · As of {at(asOf)}
      </p>
      {data.current.incomplete.length > 0 && (
        <p className={styles.notice}>
          <button
            type="button"
            data-nav-item
            className={styles.link}
            onClick={() => select({ kind: 'incomplete', period: 'current' })}
          >
            {data.current.incomplete.length}{' '}
            {data.current.incomplete.length === 1 ? 'Task has' : 'Tasks have'} incomplete timing
            history
          </button>
          . Unmeasurable intervals are excluded. Reason coverage counts apply only to Tasks with a
          recorded Intake boundary.
        </p>
      )}
      {panel === 'stages' ? (
        <section className={styles.flowCard} aria-label="Elapsed time by Stage">
          <h3>Elapsed time by Stage</h3>
          <StageTable period={data.current} previous={data.previous} select={select} />
          <details className={styles.dataTable}>
            <summary>How Stage time is measured</summary>
            <p>
              Wall-clock time including waiting, stops and rework, not agent effort. Each Task’s
              repeated visits are added together. Started non-setup Tasks open during this period
              contribute, including Tasks now Done or archived.
            </p>
            <p>
              Intervals are clipped to this period and first Intake through first Done or archive.
              Open Tasks end at the as-of instant. Backlog is excluded. Missing visits contribute no
              zero samples. Stage time can include overlapping wait reasons shown in Flow.
            </p>
          </details>
          <StatisticsHelp />
        </section>
      ) : (
        <>
          <TimingOverview data={data} select={select} />
          <div className={styles.flowGrid}>
            <section className={styles.flowCard} aria-label="Actual send-backs">
              <h3>Actual send-backs</h3>
              <SendBacks period={data.current} select={select} />
              {data.previous && (
                <details className={styles.dataTable}>
                  <summary>Previous send-back evidence</summary>
                  <SendBacks period={data.previous} select={previousSelect} />
                </details>
              )}
              <p className={styles.flowFoot}>
                Actual transitions, including uncounted send-backs. Pending questions and retries
                are excluded. No recorded send-backs does not establish complete history.
              </p>
            </section>
            <section className={styles.flowCard} aria-label="First-pass Validate">
              <h3>First-pass Validate</h3>
              <FirstPass period={data.current} select={select} />
              {data.previous && (
                <details className={styles.dataTable}>
                  <summary>Previous first-pass evidence</summary>
                  <FirstPass period={data.previous} select={previousSelect} />
                </details>
              )}
            </section>
          </div>
        </>
      )}
      <p className={styles.definition}>
        All measures use retained structured history at the same as-of instant. Deleted Tasks are
        unavailable. Stage/working/waiting samples and completed-Task samples are distinct.
      </p>
      {selection && (
        <FlowSample
          data={data}
          asOf={asOf}
          selection={selection}
          onClose={onClose}
          onOpenTask={onOpenTask}
          selectPrevious={() => select({ ...selection, period: 'previous' })}
        />
      )}
    </section>
  )
}
