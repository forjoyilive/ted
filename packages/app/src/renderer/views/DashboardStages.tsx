import type {
  DashboardFlow,
  DashboardRange,
  FlowPeriod,
  FlowStageSample,
  StagePart,
} from '@ted/protocol'
import { stageParts } from '@ted/protocol/stage-parts'
import { useEffect, useId, useRef, useState } from 'react'
import { CloseIcon } from '../components/icons.tsx'
import { rangeComparison, type StageSelection } from '../dashboard.ts'
import { useStages } from '../stages.tsx'
import { formatDate } from '../time.ts'
import styles from './Dashboard.module.css'
import { hours, StatisticsHelp, share, TimingChange } from './DashboardMeasures.tsx'
import { flowWithoutUserWaits, type LeftOutTask, useIncludeUserWaits } from './stage-waits.ts'

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
  `${period.from ? at(period.from) : 'All time'} – ${at(period.to)} (end excluded)`
const totalValue = (measure: FlowPeriod['stages'][number] | undefined) =>
  measure?.samples.length ? measure.totalMs : null

export const partNames: Record<StagePart, string> = {
  working: 'Agent working',
  checks: 'Running Checks',
  you: 'Waiting on you',
  slot: 'Waiting for a slot',
  github: 'Waiting on GitHub',
  blocked: 'Blocked or paused',
  other: 'Other',
}

const partClass: Record<StagePart, string | undefined> = {
  working: styles.partWorking,
  checks: styles.partChecks,
  you: styles.partYou,
  slot: styles.partSlot,
  github: styles.partGithub,
  blocked: styles.partBlocked,
  other: styles.partOther,
}

function coverage(
  stage: FlowPeriod['stages'][number],
  eligible: number,
  factories: readonly { id: string; name: string }[],
): { text: string; names?: string; full: boolean } {
  const n = stage.samples.length
  const full = n > 0 && n === eligible
  const tasks = `${n} of ${eligible} ${eligible === 1 ? 'Task' : 'Tasks'}`
  const having = factories.filter((f) => stage.factoryIds.includes(f.id))
  if (factories.length < 2 || n === 0 || having.length === factories.length)
    return { text: full ? (n === 1 ? '1 Task' : `All ${n} Tasks`) : tasks, full }
  return {
    text: `${having.length} of ${factories.length} Factories · ${tasks}`,
    names: having.map((f) => f.name).join(', '),
    full: false,
  }
}

function StageTable({
  period,
  previous,
  range,
  eligible,
  factories,
  names,
  select,
}: {
  period: FlowPeriod
  previous: FlowPeriod | null
  range: DashboardRange
  eligible: number
  factories: readonly { id: string; name: string }[]
  names: Readonly<Record<string, string>>
  select: (s: StageSelection) => void
}) {
  const stages = useStages().within(factories.map((f) => f.id))
  const label = (id: string) => stages.name(id, undefined, names)
  const rows = period.stages.toSorted((a, b) => stages.index(a.stage) - stages.index(b.stage))
  const [mode, setMode] = useState<'total' | 'share'>('total')
  const total = period.stages.reduce((sum, s) => sum + (totalValue(s) ?? 0), 0)
  const most = Math.max(0, ...period.stages.map((s) => totalValue(s) ?? 0))
  const top = most > 0 ? period.stages.find((s) => totalValue(s) === most) : undefined
  const used = stageParts.filter((part) => period.stages.some((s) => s.parts[part] > 0))
  return (
    <>
      <p className={styles.caption}>{bounds(period)}</p>
      {used.length > 0 && (
        <div className={styles.stageControls}>
          <div className={styles.stageLegend}>
            {used.map((part) => (
              <span key={part}>
                <i className={partClass[part]} />
                {partNames[part]}
              </span>
            ))}
          </div>
          <fieldset className={styles.segToggle} aria-label="Bar length">
            <button type="button" aria-pressed={mode === 'total'} onClick={() => setMode('total')}>
              Total time
            </button>
            <button type="button" aria-pressed={mode === 'share'} onClick={() => setMode('share')}>
              Share of each Stage
            </button>
          </fieldset>
        </div>
      )}
      <ul className={`${styles.timingRows} ${styles.stageRows}`}>
        {period.stages.length > 0 && (
          <li className={`${styles.timingRow} ${styles.stageColumns}`}>
            <span>Stage</span>
            <span />
            <span className={styles.stageNumber}>Share</span>
            <span className={styles.stageNumber}>Time</span>
            <span className={styles.stageNumber}>Median</span>
            <span>Covers</span>
            <span>{previous && `vs ${rangeComparison(range).against}`}</span>
          </li>
        )}
        {rows.map((s) => {
          const prior = previous?.stages.find((p) => p.stage === s.stage)
          const choose = () => select({ kind: 'stage', stage: s.stage, period: 'current' })
          const covers = coverage(s, eligible, factories)
          const value = totalValue(s)
          const parts = stageParts.filter((part) => s.parts[part] > 0)
          const split = parts.reduce((n, part) => n + s.parts[part], 0)
          const width = mode === 'share' ? 100 : most > 0 ? ((value ?? 0) / most) * 100 : 0
          return (
            <li key={s.stage} className={styles.timingRow}>
              <div>
                <button type="button" data-nav-item className={styles.link} onClick={choose}>
                  {label(s.stage)}
                </button>
                {s === top && <span className={styles.mostTime}>Most time</span>}
              </div>
              <div className={styles.stageTrack}>
                {split > 0 && (
                  <div
                    className={styles.stageBar}
                    data-testid={`stage-bar-${s.stage}`}
                    style={{ width: `${width}%` }}
                  >
                    {parts.map((part) => {
                      const text = `${label(s.stage)} · ${partNames[part]}: ${hours(s.parts[part])}`
                      return (
                        <button
                          key={part}
                          type="button"
                          className={partClass[part]}
                          style={{ flexGrow: s.parts[part] / split }}
                          aria-label={text}
                          title={text}
                          onClick={() =>
                            select({ kind: 'stage', stage: s.stage, part, period: 'current' })
                          }
                        />
                      )
                    })}
                  </div>
                )}
              </div>
              <strong className={styles.stageNumber}>{share(value, total)}</strong>
              <span className={styles.stageNumber}>{hours(value)}</span>
              <span className={styles.stageNumber}>
                {s.samples.length ? hours(s.medianMs) : '—'}
              </span>
              <span>
                <button
                  type="button"
                  data-nav-item
                  className={covers.full ? styles.coversAll : styles.coverage}
                  title={covers.names && `Only in ${covers.names}`}
                  onClick={choose}
                >
                  {covers.text}
                </button>
              </span>
              <span>
                {previous && (
                  <TimingChange
                    current={value}
                    previous={totalValue(prior)}
                    versus={rangeComparison(range).versus}
                  />
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {used.length > 0 && (
        <p className={styles.caption}>
          Reasons can overlap, for example a Run waiting for a slot while Checks run. Each hour
          counts once, under the first reason that applies, in the legend’s order: Agent working,
          Running Checks, Waiting on you, Waiting for a slot, Waiting on GitHub, then Blocked or
          paused. Other is time no recorded reason covers, including history TED didn’t record.
          Hover a segment for its hours; click it for the Tasks.
        </p>
      )}
      {period.stages.every((s) => s.samples.length === 0) && (
        <p className={styles.empty}>
          No measurable Stage intervals in this period. Total and distribution unavailable.
        </p>
      )}
    </>
  )
}

function StageSample({
  data,
  range,
  selection,
  asOf,
  onClose,
  onOpenTask,
  selectPrevious,
  withoutWaits,
}: {
  data: DashboardFlow
  range: DashboardRange
  selection: StageSelection
  asOf: string
  onClose: () => void
  onOpenTask: (id: string) => void
  selectPrevious: () => void
  withoutWaits?:
    | { original: DashboardFlow; leftOut: { current: LeftOutTask[]; previous: LeftOutTask[] } }
    | undefined
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const stages = useStages()
  const label = (id: string) => stages.name(id, undefined, data.stageNames)
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
      ? `${label(selection.stage)} · ${selection.part ? partNames[selection.part] : 'Per-Task elapsed time'}`
      : selection.kind === 'incomplete'
        ? 'Incomplete timing history'
        : 'Tasks left out of Stage time'
  const items: { key: string; taskId: string; lines: string[] }[] = []
  const stage =
    selection.kind === 'stage' ? period.stages.find((s) => s.stage === selection.stage) : undefined
  const prior =
    selection.kind === 'stage'
      ? data.previous?.stages.find((s) => s.stage === selection.stage)
      : undefined
  if (selection.kind === 'stage') {
    const part = selection.part
    const spent = (s: FlowStageSample) => (part ? s.parts[part] : s.elapsedMs)
    for (const s of (stage?.samples ?? [])
      .filter((s) => spent(s) > 0 || !part)
      .toSorted((a, b) => spent(b) - spent(a) || a.taskId.localeCompare(b.taskId))) {
      const incomplete = period.incomplete.find((i) => i.taskId === s.taskId)
      const withWaits = (
        selection.period === 'previous'
          ? withoutWaits?.original.previous
          : withoutWaits?.original.current
      )?.stages
        .find((o) => o.stage === selection.stage)
        ?.samples.find((o) => o.taskId === s.taskId)
      items.push({
        key: s.taskId,
        taskId: s.taskId,
        lines: [
          ...(part ? [`${partNames[part]}: ${hours(s.parts[part])} of ${hours(s.elapsedMs)}`] : []),
          `${hours(s.elapsedMs)} · ${s.intervals.length} measured ${s.intervals.length === 1 ? 'visit' : 'visits'}${withWaits ? ` · ${hours(withWaits.elapsedMs - s.elapsedMs)} waiting for you left out` : ''}`,
          ...s.intervals.map((i) => `${at(i.from)} – ${at(i.to)} (end excluded)`),
          ...(incomplete?.reasons ?? []),
        ],
      })
    }
  } else if (selection.kind === 'incomplete') {
    for (const s of period.incomplete)
      items.push({ key: s.taskId, taskId: s.taskId, lines: s.reasons })
  } else {
    for (const s of withoutWaits?.leftOut[selection.period] ?? [])
      items.push({ key: s.taskId, taskId: s.taskId, lines: s.reasons })
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
          aria-label="Close Stage sample"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <p>
        {selection.period === 'previous' ? 'Previous period' : 'Selected period'} · {bounds(period)}
      </p>
      <p className={styles.caption}>
        As of {at(asOf)} · {items.length} Tasks. Open a Task for its existing history and
        verification evidence.
      </p>
      {selection.kind === 'stage' && (
        <p className={styles.caption}>
          {withoutWaits ? 'Without time waiting for you.' : 'Includes time waiting for you.'}
        </p>
      )}
      {selection.kind === 'left-out' && (
        <p className={styles.caption}>
          TED has no complete record of when these Tasks were waiting for you.
        </p>
      )}
      {stage && selection.kind === 'stage' && (
        <>
          <div className={styles.timingStats}>
            <div>
              <small>Total Task-hours</small>
              <strong>{hours(totalValue(stage))}</strong>
              {selection.period === 'current' && data.previous && (
                <TimingChange
                  current={totalValue(stage)}
                  previous={totalValue(prior)}
                  versus={rangeComparison(range).versus}
                />
              )}
            </div>
            <div>
              <small>Middle Task · median</small>
              <strong>{hours(stage.medianMs)}</strong>
            </div>
            <div>
              <small>Middle 50%</small>
              <strong>
                {hours(stage.p25Ms)} – {hours(stage.p75Ms)}
              </strong>
            </div>
          </div>
          {selection.part && (
            <p>
              {partNames[selection.part]}: {hours(stage.parts[selection.part])} of this Stage’s{' '}
              {hours(totalValue(stage))}. Longest first.
            </p>
          )}
          {selection.period === 'current' && data.previous && (
            <details className={styles.dataTable}>
              <summary>Comparison evidence</summary>
              <p>
                Previous total: {hours(totalValue(prior))} · Middle Task:{' '}
                {hours(prior?.medianMs ?? null)} · Middle 50%: {hours(prior?.p25Ms ?? null)} –{' '}
                {hours(prior?.p75Ms ?? null)}.
              </p>
              <p>
                {prior?.samples.length ?? 0} measured Tasks. Each period has its own Tasks and
                coverage; direction alone does not prove improvement.
              </p>
              <button type="button" data-nav-item className={styles.link} onClick={selectPrevious}>
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
            <li key={item.key} className={styles.stageSampleItem}>
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
              {selection.kind === 'stage' && <p className={styles.caption}>{item.lines[0]}</p>}
              <details className={styles.dataTable} open={selection.kind !== 'stage'}>
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
      {!items.length && <p>No Tasks or transitions in this sample.</p>}
    </dialog>
  )
}

export function Stages({
  data: all,
  range,
  asOf,
  selection,
  select,
  onClose,
  onOpenTask,
  factories = [],
}: {
  data: DashboardFlow
  range: DashboardRange
  asOf: string
  selection?: StageSelection | undefined
  select: (s: StageSelection) => void
  onClose: () => void
  onOpenTask: (id: string) => void
  factories?: readonly { id: string; name: string }[]
}) {
  const heading = useId()
  const [includeWaits, setIncludeWaits] = useIncludeUserWaits()
  const reduced = includeWaits ? undefined : flowWithoutUserWaits(all)
  const data = reduced?.data ?? all
  const leftOut = reduced?.leftOut.current.length ?? 0
  return (
    <section className={styles.flow} aria-labelledby={heading}>
      <header className={styles.flowHead}>
        <div>
          <h2 id={heading}>Time by Stage</h2>
          <p className={styles.caption}>
            {includeWaits
              ? 'See which Stages take time, including time waiting for you and repeat visits.'
              : 'See which Stages take time, without the time Tasks spent waiting for you.'}
          </p>
        </div>
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
      <section className={styles.flowCard} aria-label="Elapsed time by Stage">
        <div className={styles.stageHead}>
          <h3>Elapsed time by Stage</h3>
          <label className={styles.stageWaits}>
            <input
              type="checkbox"
              data-nav-item
              checked={includeWaits}
              onChange={(event) => setIncludeWaits(event.target.checked)}
            />
            Include time waiting for me
          </label>
        </div>
        {leftOut > 0 && (
          <p className={styles.notice}>
            <button
              type="button"
              data-nav-item
              className={styles.link}
              onClick={() => select({ kind: 'left-out', period: 'current' })}
            >
              {leftOut} {leftOut === 1 ? 'Task is' : 'Tasks are'} left out
            </button>
            : TED has no complete record of when {leftOut === 1 ? 'it was' : 'they were'} waiting
            for you. Tick “Include time waiting for me” to count {leftOut === 1 ? 'it' : 'them'}.
          </p>
        )}
        {factories.length > 1 && (
          <p className={styles.caption}>
            Stages with the same name are combined across Factories. A Stage only some of the shown
            Factories use says how many Factories and Tasks it covers.
          </p>
        )}
        <StageTable
          period={data.current}
          previous={data.previous}
          range={range}
          eligible={
            data.current.taskIds.filter(
              (id) => !reduced?.leftOut.current.some((t) => t.taskId === id),
            ).length
          }
          factories={factories}
          names={data.stageNames}
          select={select}
        />
        <details className={styles.dataTable}>
          <summary>How Stage time is measured</summary>
          {includeWaits ? (
            <p>
              Wall-clock time including waiting, stops and rework, not agent effort. Each Task’s
              repeated visits are added together. Started non-setup Tasks open during this period
              contribute, including Tasks now Done or archived.
            </p>
          ) : (
            <p>
              Wall-clock time including stops and rework, not agent effort, without the time a Task
              had an open request to you: a question, a sign-off, a Clarify round or a permission
              ask. Other waits still count. Tasks without a complete record of those requests are
              left out. Each Task’s repeated visits are added together. Started non-setup Tasks open
              during this period contribute, including Tasks now Done or archived.
            </p>
          )}
          <p>
            Intervals are clipped to this period and first Intake through first Done or archive.
            Open Tasks end at the as-of instant. Backlog is excluded. Missing visits contribute no
            zero samples.
          </p>
        </details>
        <StatisticsHelp />
      </section>
      <p className={styles.definition}>
        All measures use retained structured history at the same as-of instant. Deleted Tasks are
        unavailable. Stage/working/waiting samples and completed-Task samples are distinct.
      </p>
      {selection && (
        <StageSample
          data={data}
          range={range}
          asOf={asOf}
          selection={selection}
          onClose={onClose}
          onOpenTask={onOpenTask}
          selectPrevious={() => select({ ...selection, period: 'previous' })}
          withoutWaits={reduced && { original: all, leftOut: reduced.leftOut }}
        />
      )}
    </section>
  )
}
