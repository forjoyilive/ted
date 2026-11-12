import type { DashboardFlow, FlowPeriod, FlowValidateOutcome } from '@ted/protocol'
import { useEffect, useId, useRef } from 'react'
import { CloseIcon } from '../components/icons.tsx'
import type { FlowSelection } from '../dashboard.ts'
import { stageName as label } from '../list-view.ts'
import { formatDate } from '../time.ts'
import styles from './Dashboard.module.css'

const hours = (ms: number | null) =>
  ms === null
    ? 'Unavailable'
    : ms > 0 && ms < 36_000
      ? '<0.01 h'
      : `${Number((ms / 3_600_000).toFixed(2))} h`
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
const outcomes: Record<FlowValidateOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped verification',
  unknown: 'Unknown verification',
  'no-visit': 'No recorded Validate visit',
}

function StageTable({
  period,
  select,
}: {
  period: FlowPeriod
  select: (s: FlowSelection) => void
}) {
  const max = Math.max(1, ...period.stages.map((s) => s.totalMs))
  return (
    <div className={styles.flowTable}>
      <table>
        <caption className={styles.caption}>{bounds(period)}</caption>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Total Task-hours</th>
            <th>Median per Task</th>
            <th>25th–75th percentile</th>
            <th>Sample</th>
          </tr>
        </thead>
        <tbody>
          {period.stages.map((s) => (
            <tr key={s.stage}>
              <th scope="row">{label(s.stage)}</th>
              <td>
                <span className={styles.flowBar} aria-hidden="true">
                  <i style={{ width: `${(s.totalMs / max) * 100}%` }} />
                </span>
                {hours(s.totalMs)}
              </td>
              <td>{hours(s.medianMs)}</td>
              <td>{s.p25Ms === null ? 'Unavailable' : `${hours(s.p25Ms)} – ${hours(s.p75Ms)}`}</td>
              <td>
                <button
                  type="button"
                  data-nav-item
                  className={styles.link}
                  onClick={() => select({ kind: 'stage', stage: s.stage, period: 'current' })}
                >
                  {s.samples.length} Tasks
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {period.stages.every((s) => s.samples.length === 0) && (
        <p className={styles.empty}>
          No measurable Stage intervals in this period. Total: 0 Task-hours; distribution
          unavailable.
        </p>
      )}
    </div>
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
}: {
  data: DashboardFlow
  selection: FlowSelection
  asOf: string
  onClose: () => void
  onOpenTask: (id: string) => void
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
    selection.kind === 'stage'
      ? `${label(selection.stage)} · Per-Task elapsed time`
      : selection.kind === 'send-back'
        ? `${label(selection.from)} → ${label(selection.to)} · Actual transitions`
        : selection.kind === 'affected'
          ? 'Tasks affected by send-backs'
          : selection.kind === 'incomplete'
            ? 'Incomplete timing history'
            : `${outcomes[selection.outcome]} · First-pass Validate`
  const items: { key: string; taskId: string; lines: string[] }[] = []
  if (selection.kind === 'stage') {
    for (const s of period.stages.find((s) => s.stage === selection.stage)?.samples ?? []) {
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
  } else {
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
              {[...new Set(item.lines)].map((line) => (
                <p className={styles.caption} key={line}>
                  {line}
                </p>
              ))}
            </li>
          )
        })}
      </ul>
      {!items.length && <p>No Tasks or transitions in this sample.</p>}
    </dialog>
  )
}

export function Flow({
  data,
  asOf,
  selection,
  select,
  onClose,
  onOpenTask,
}: {
  data: DashboardFlow
  asOf: string
  selection?: FlowSelection | undefined
  select: (s: FlowSelection) => void
  onClose: () => void
  onOpenTask: (id: string) => void
}) {
  const heading = useId()
  const previousSelect = (s: FlowSelection) => select({ ...s, period: 'previous' })
  return (
    <section className={styles.flow} aria-labelledby={heading}>
      <h2 id={heading}>Flow</h2>
      <p className={styles.caption}>Where elapsed time and rework accumulate.</p>
      <section className={styles.flowCard} aria-label="Elapsed time by Stage">
        <header className={styles.flowHead}>
          <h3>Elapsed time by Stage</h3>
          <span className={styles.caption}>
            {data.current.taskIds.length} Tasks open during this period
          </span>
        </header>
        <p className={styles.caption}>
          Wall-clock time including waiting. Each Task’s repeated visits are added together.
        </p>
        <StageTable period={data.current} select={select} />
        {data.current.incomplete.length > 0 && (
          <p className={styles.notice}>
            <button
              type="button"
              data-nav-item
              className={styles.link}
              onClick={() => select({ kind: 'incomplete', period: 'current' })}
            >
              {data.current.incomplete.length} Tasks have incomplete timing history
            </button>
            . Unmeasurable intervals are excluded; measured time may be incomplete.
          </p>
        )}
        {data.previous && (
          <details className={styles.dataTable}>
            <summary>Previous period · all Stage measures</summary>
            <StageTable period={data.previous} select={previousSelect} />
            {data.previous.incomplete.length > 0 && (
              <button
                type="button"
                className={styles.link}
                onClick={() => previousSelect({ kind: 'incomplete', period: 'current' })}
              >
                Previous {data.previous.incomplete.length} Tasks with incomplete timing history
              </button>
            )}
          </details>
        )}
        <p className={styles.flowFoot}>
          Started non-setup Tasks whose open lifetime overlaps the period, including Tasks now Done
          or archived. Intervals are clipped to this period and first Intake through first Done or
          archive; open Tasks end at the as-of instant. Backlog is excluded. Tasks without a
          measured visit contribute no zero. Quartiles use linear interpolation between sorted
          per-Task times.
        </p>
      </section>
      <div className={styles.flowGrid}>
        <section className={styles.flowCard} aria-label="Actual send-backs">
          <h3>Actual send-backs</h3>
          <SendBacks period={data.current} select={select} />
          {data.previous && (
            <details className={styles.dataTable}>
              <summary>Previous period · send-backs</summary>
              <p className={styles.caption}>{bounds(data.previous)}</p>
              <SendBacks period={data.previous} select={previousSelect} />
            </details>
          )}
          <p className={styles.flowFoot}>
            Actual transitions recorded during this period, including uncounted send-backs. Pending
            questions and retries are excluded. No recorded send-backs does not establish that
            history is complete.
          </p>
        </section>
        <section className={styles.flowCard} aria-label="First-pass Validate">
          <h3>First-pass Validate</h3>
          <FirstPass period={data.current} select={select} />
          {data.previous && (
            <details className={styles.dataTable}>
              <summary>Previous period · first-pass Validate</summary>
              <p className={styles.caption}>{bounds(data.previous)}</p>
              <FirstPass period={data.previous} select={previousSelect} />
            </details>
          )}
          <details className={styles.dataTable}>
            <summary>What counts as a pass?</summary>
            <p>
              Recorded passing Checks and review, applicable visual verification and no actual
              send-back on the first visit. Only fully recorded first-visit outcomes enter the
              denominator. Missing visual verification or applicability stays unknown. Later visits
              do not replace the first visit’s result.
            </p>
          </details>
        </section>
      </div>
      <p className={styles.definition}>
        All measures use retained structured history at the same as-of instant. Missing records
        never imply success; deleted Tasks are unavailable. Stage samples and completed-Task samples
        are distinct.
      </p>
      {selection && (
        <FlowSample
          data={data}
          asOf={asOf}
          selection={selection}
          onClose={onClose}
          onOpenTask={onOpenTask}
        />
      )}
    </section>
  )
}
