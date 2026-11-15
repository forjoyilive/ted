import type {
  DashboardFlow,
  FlowFailure,
  FlowFailureKind,
  FlowFailureOutcome,
  FlowPeriod,
  FlowSendBack,
  FlowValidateOutcome,
} from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { useEffect, useId, useRef } from 'react'
import { CloseIcon } from '../components/icons.tsx'
import type { FlowSelection } from '../dashboard.ts'
import { stageName as label } from '../list-view.ts'
import { formatDate } from '../time.ts'
import styles from './Dashboard.module.css'
import { hours, StatisticsHelp, share, TimingChange } from './DashboardMeasures.tsx'
import { coverageLabel, reasonNames, reasonValue, TimingOverview } from './DashboardTiming.tsx'
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

function coverage(
  stage: FlowPeriod['stages'][number],
  period: FlowPeriod,
  factories: readonly { id: string; name: string }[],
): { text: string; names: string } | null {
  if (factories.length < 2 || stage.samples.length === 0) return null
  const having = factories.filter((f) => stage.factoryIds.includes(f.id))
  if (having.length === factories.length) return null
  return {
    text: `${having.length} of ${factories.length} Factories · ${stage.samples.length} of ${period.taskIds.length} Tasks`,
    names: having.map((f) => f.name).join(', '),
  }
}

function StageTable({
  period,
  previous,
  factories,
  select,
}: {
  period: FlowPeriod
  previous: FlowPeriod | null
  factories: readonly { id: string; name: string }[]
  select: (s: FlowSelection) => void
}) {
  const total = period.stages.reduce((sum, s) => sum + (totalValue(s) ?? 0), 0)
  return (
    <>
      <p className={styles.caption}>{bounds(period)}</p>
      <ul className={`${styles.timingRows} ${styles.stageRows}`}>
        {period.stages.length > 0 && (
          <li className={`${styles.timingRow} ${styles.stageColumns}`}>
            <span>Stage</span>
            <span className={styles.stageNumber}>Share</span>
            <span className={styles.stageNumber}>Time</span>
            <span>{previous && 'vs previous'}</span>
            <span />
          </li>
        )}
        {period.stages.map((s) => {
          const prior = previous?.stages.find((p) => p.stage === s.stage)
          const choose = () => select({ kind: 'stage', stage: s.stage, period: 'current' })
          const partial = coverage(s, period, factories)
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
                  {partial && (
                    <span className={styles.coverage} title={`Only in ${partial.names}`}>
                      {partial.text}
                    </span>
                  )}
                </p>
              </div>
              <strong className={styles.stageNumber}>{share(totalValue(s), total)}</strong>
              <span className={styles.stageNumber}>{hours(totalValue(s))}</span>
              <span>
                {previous && <TimingChange current={totalValue(s)} previous={totalValue(prior)} />}
              </span>
              <button
                type="button"
                data-nav-item
                className={styles.link}
                aria-label={`Inspect ${label(s.stage)} Stage`}
                onClick={choose}
              >
                →
              </button>
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

const causes: { key: string; name: string; className: string | undefined }[] = [
  { key: 'review', name: 'Review Findings', className: styles.causeReview },
  { key: 'check', name: 'Failed Check', className: styles.causeCheck },
  { key: 'human', name: 'You asked', className: styles.causeHuman },
  { key: 'base-conflict', name: 'Base conflict', className: styles.causeBase },
]
const notRecorded = 'none'
const causeName = (key: string) =>
  key === notRecorded ? 'Not recorded' : (causes.find((c) => c.key === key)?.name ?? key)
const severities: { key: string; name: string; text: string }[] = [
  { key: 'p1', name: 'P1', text: 'Must fix' },
  { key: 'unfixed', name: 'Unfixed', text: 'An earlier Finding still not fixed' },
  { key: 'none', name: 'None', text: 'No severity declared' },
]
const failureKinds: Record<FlowFailureKind, string> = {
  check: 'Failed Check',
  finding: 'Reviewer or Task Lead Finding',
  ci: 'CI at Merge',
}
const failureOutcomes: { key: FlowFailureOutcome; name: string; className: string | undefined }[] =
  [
    { key: 'fixed', name: 'Fixed', className: styles.outcomeFixed },
    { key: 'accepted', name: 'Accepted by you', className: styles.outcomeAccepted },
    { key: 'open', name: 'Still open', className: styles.outcomeOpen },
  ]

function sentBackTitle(s: { cause?: string; severity?: string; from?: string; to?: string }) {
  const severity = severities.find((v) => v.key === s.severity)?.name ?? s.severity
  return [
    s.cause === undefined ? 'Send-backs' : `Sent back: ${causeName(s.cause)}`,
    ...(severity === undefined ? [] : [`Severity: ${severity}`]),
    ...(s.from === undefined || s.to === undefined ? [] : [`${label(s.from)} → ${label(s.to)}`]),
  ].join(' · ')
}

function failureTitle(s: { failure?: FlowFailureKind; outcome?: FlowFailureOutcome }) {
  return [
    'Failure cases',
    ...(s.failure ? [failureKinds[s.failure]] : []),
    ...(s.outcome ? [failureOutcomes.find((o) => o.key === s.outcome)?.name ?? s.outcome] : []),
  ].join(' · ')
}

const countedBacks = (period: FlowPeriod) =>
  period.sendBacks.flatMap((g) => g.transitions).filter((t) => t.counted)
const causeOf = (s: FlowSendBack) => s.cause ?? notRecorded

function sentBackMatches(
  s: FlowSendBack,
  selection: { cause?: string; severity?: string; from?: string; to?: string },
) {
  return (
    s.counted &&
    (selection.cause === undefined || causeOf(s) === selection.cause) &&
    (selection.severity === undefined || s.severity === selection.severity) &&
    (selection.from === undefined || s.from === selection.from) &&
    (selection.to === undefined || s.to === selection.to)
  )
}

function failureMatches(
  f: FlowFailure,
  selection: { failure?: FlowFailureKind; outcome?: FlowFailureOutcome; id?: string },
) {
  return (
    (selection.failure === undefined || f.kind === selection.failure) &&
    (selection.outcome === undefined || f.outcome === selection.outcome) &&
    (selection.id === undefined || f.id === selection.id)
  )
}

function SendBackCauses({
  data,
  factories,
  select,
}: {
  data: DashboardFlow
  factories: readonly { id: string; name: string }[]
  select: (s: FlowSelection) => void
}) {
  const backs = countedBacks(data.current)
  const tasks = new Set(backs.map((s) => s.taskId))
  const known = new Set(causes.map((c) => c.key))
  const shown = [
    ...causes,
    ...[...new Set(backs.map(causeOf))]
      .filter((key) => !known.has(key))
      .map((key) => ({
        key,
        name: causeName(key),
        className: key === notRecorded ? styles.causeNone : styles.causeOther,
      })),
  ]
    .map((c) => ({ ...c, count: backs.filter((s) => causeOf(s) === c.key).length }))
    .filter((c) => c.count > 0)
  const routes = [...new Set(backs.map((s) => JSON.stringify([s.from, s.to])))].map((key) => {
    const [from = '', to = ''] = JSON.parse(key) as string[]
    return { from, to, backs: backs.filter((s) => s.from === from && s.to === to) }
  })
  routes.sort((a, b) => b.backs.length - a.backs.length)
  const factoryOf = new Map(data.tasks.map((task) => [task.id, task.factoryId]))
  const columns = factories.length > 1 ? factories : []
  const common = routes[0]
  return (
    <section className={styles.flowCard} aria-label="Why Tasks were sent back">
      <h3>Why Tasks were sent back</h3>
      <p>
        <button
          type="button"
          data-nav-item
          className={styles.link}
          onClick={() => select({ kind: 'sent-back', period: 'current' })}
        >
          <strong className={styles.flowValue}>{backs.length}</strong>
        </button>{' '}
        {backs.length === 1 ? 'send-back' : 'send-backs'} across {tasks.size}{' '}
        {tasks.size === 1 ? 'Task' : 'Tasks'}
        {common && ` · ${label(common.from)} → ${label(common.to)} is the most common`}
      </p>
      {backs.length > 0 && (
        <div className={styles.split}>
          {shown.map((c) => (
            <button
              key={c.key}
              type="button"
              className={c.className}
              style={{ flexGrow: c.count / backs.length }}
              aria-label={`${c.name} ${c.count}`}
              title={`${c.name}: ${c.count}`}
              onClick={() => select({ kind: 'sent-back', cause: c.key, period: 'current' })}
            />
          ))}
        </div>
      )}
      <div className={styles.splitLabels}>
        {shown.map((c) => (
          <button
            key={c.key}
            type="button"
            data-nav-item
            className={styles.link}
            onClick={() => select({ kind: 'sent-back', cause: c.key, period: 'current' })}
          >
            <i className={c.className} />
            {c.name} {c.count}
          </button>
        ))}
      </div>
      <div className={styles.flowTable}>
        <table>
          <thead>
            <tr>
              <th>Severity of review Findings</th>
              <th>Send-backs</th>
            </tr>
          </thead>
          <tbody>
            {severities.map((v) => {
              const count = backs.filter((s) => s.severity === v.key).length
              return (
                <tr key={v.key}>
                  <th scope="row">
                    <button
                      type="button"
                      data-nav-item
                      className={styles.link}
                      onClick={() =>
                        select({ kind: 'sent-back', severity: v.key, period: 'current' })
                      }
                    >
                      <span className={v.key === 'p1' ? styles.severityP1 : styles.severity}>
                        {v.name}
                      </span>{' '}
                      {v.text}
                    </button>
                  </th>
                  <td>{count}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.caption}>
        Severity is recorded only for review send-backs from Validate rounds with the P1-only rule.
      </p>
      <div className={styles.flowTable}>
        <table>
          <thead>
            <tr>
              <th>From → to</th>
              {columns.length ? (
                columns.map((f) => <th key={f.id}>{f.name}</th>)
              ) : (
                <th>Send-backs</th>
              )}
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={`${r.from}-${r.to}`}>
                <th scope="row">
                  <button
                    type="button"
                    data-nav-item
                    className={styles.link}
                    onClick={() =>
                      select({ kind: 'sent-back', from: r.from, to: r.to, period: 'current' })
                    }
                  >
                    {label(r.from)} → {label(r.to)}
                  </button>
                </th>
                {columns.length ? (
                  columns.map((f) => (
                    <td key={f.id}>
                      {r.backs.filter((s) => factoryOf.get(s.taskId) === f.id).length}
                    </td>
                  ))
                ) : (
                  <td>{r.backs.length}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!backs.length && (
        <p className={styles.empty}>No send-backs counted toward limits in this period.</p>
      )}
      <p className={styles.flowFoot}>
        Only send-backs that count toward limits. Actual send-backs below include the rest.
      </p>
    </section>
  )
}

function Failures({ data, select }: { data: DashboardFlow; select: (s: FlowSelection) => void }) {
  const failures = data.current.failures
  const tasks = new Set(failures.map((f) => f.taskId))
  const count = (outcome: FlowFailureOutcome) =>
    failures.filter((f) => f.outcome === outcome).length
  const kinds = (Object.keys(failureKinds) as FlowFailureKind[])
    .map((kind) => ({ kind, cases: failures.filter((f) => f.kind === kind) }))
    .filter((k) => k.cases.length > 0)
  const accepted = failures.filter((f) => f.outcome === 'accepted')
  const records = new Map(data.tasks.map((task) => [task.id, task]))
  return (
    <>
      <section className={styles.flowCard} aria-label="Failures and how they ended">
        <h3>Failures and how they ended</h3>
        <p>
          <button
            type="button"
            data-nav-item
            className={styles.link}
            onClick={() => select({ kind: 'failure', period: 'current' })}
          >
            <strong className={styles.flowValue}>{failures.length}</strong>
          </button>{' '}
          {failures.length === 1 ? 'failure case' : 'failure cases'} on {tasks.size}{' '}
          {tasks.size === 1 ? 'Task' : 'Tasks'} · {count('fixed')} fixed · {count('accepted')}{' '}
          accepted by you · {count('open')} still open
        </p>
        {kinds.map(({ kind, cases }) => (
          <div key={kind} className={styles.failureRow}>
            <span>{failureKinds[kind]}</span>
            <div className={styles.split}>
              {failureOutcomes.map((o) => {
                const n = cases.filter((f) => f.outcome === o.key).length
                return (
                  n > 0 && (
                    <button
                      key={o.key}
                      type="button"
                      className={o.className}
                      style={{ flexGrow: n / cases.length }}
                      aria-label={`${failureKinds[kind]} · ${o.name} ${n}`}
                      title={`${failureKinds[kind]} · ${o.name}: ${n}`}
                      onClick={() =>
                        select({
                          kind: 'failure',
                          failure: kind,
                          outcome: o.key,
                          period: 'current',
                        })
                      }
                    />
                  )
                )
              })}
            </div>
            <span>{cases.length}</span>
          </div>
        ))}
        <div className={styles.splitLabels}>
          {failureOutcomes.map((o) => (
            <button
              key={o.key}
              type="button"
              data-nav-item
              className={styles.link}
              onClick={() => select({ kind: 'failure', outcome: o.key, period: 'current' })}
            >
              <i className={o.className} />
              {o.name}
            </button>
          ))}
        </div>
        {!failures.length && (
          <p className={styles.empty}>No failure cases recorded in this period.</p>
        )}
      </section>
      <section className={styles.flowCard} aria-label="Failures you accepted">
        <h3>Failures you accepted</h3>
        <ul className={styles.taskList}>
          {accepted.map((f) => {
            const task = records.get(f.taskId)
            return (
              <li key={f.id}>
                <button
                  type="button"
                  data-nav-item
                  className={styles.task}
                  onClick={() => select({ kind: 'failure', id: f.id, period: 'current' })}
                >
                  {task?.displayId ?? f.taskId} &nbsp; {failureKinds[f.kind]}
                </button>
                {f.reason && <p className={styles.caption}>{f.reason}</p>}
              </li>
            )
          })}
        </ul>
        {!accepted.length && <p className={styles.empty}>No accepted failures in this period.</p>}
        <p className={styles.flowFoot}>Kept here so a risk you took isn’t forgotten.</p>
      </section>
    </>
  )
}

function FlowByFactory({
  data,
  period,
  factories,
}: {
  data: DashboardFlow
  period: FlowPeriod
  factories: readonly { id: string; name: string }[]
}) {
  const factoryOf = new Map(data.tasks.map((task) => [task.id, task.factoryId]))
  const rows = factories.map((factory) => {
    const mine = (taskId: string) => factoryOf.get(taskId) === factory.id
    const visits = period.firstPass.samples.filter((s) => mine(s.taskId))
    const passed = visits.filter((s) => s.outcome === 'passed').length
    const judged = visits.filter((s) => s.outcome === 'passed' || s.outcome === 'failed').length
    const backs = period.sendBacks.flatMap((g) => g.transitions).filter((t) => mine(t.taskId))
    return { factory, passed, judged, backs: backs.length }
  })
  return (
    <section className={styles.flowCard} aria-label="Flow by Factory">
      <h3>By Factory</h3>
      <div className={styles.flowTable}>
        <table>
          <thead>
            <tr>
              <th>Factory</th>
              <th>First-pass Validate</th>
              <th>Send-backs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ factory, passed, judged, backs }) => (
              <tr key={factory.id}>
                <th scope="row">{factory.name}</th>
                <td>
                  {judged === 0
                    ? 'Unavailable'
                    : `${Math.round((passed / judged) * 100)}% · ${passed} of ${judged}`}
                </td>
                <td>{backs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function FlowSample({
  data,
  selection,
  asOf,
  onClose,
  onOpenTask,
  selectPrevious,
  withoutWaits,
}: {
  data: DashboardFlow
  selection: FlowSelection
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
                : selection.kind === 'sent-back'
                  ? sentBackTitle(selection)
                  : selection.kind === 'failure'
                    ? failureTitle(selection)
                    : selection.kind === 'left-out'
                      ? 'Tasks left out of Stage time'
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
              `Invocation ${i.id}: ${i.coverage} · registered ${at(i.registeredAt)}${i.runId ? ` · direct Run ${shortReference(i.runId)}` : ''}${i.checkRunId ? ` · Check ${i.checkRunId}, position ${i.position}` : ''}${i.openWaitStartedAt ? ` · open wait from ${at(i.openWaitStartedAt)}; final duration unavailable` : ''}${i.outcome ? ` · reporting ${i.outcome}; not a test result` : ''}${i.checkCommand ? ` · Check command ${at(i.checkCommand.from)} – ${at(i.checkCommand.to)}; ${hours(i.checkCommand.overlapMs)} of confirmed wait overlaps the command and also appears in Running Checks` : ''}`,
          ),
          ...s.notices,
        ],
      })
  } else if (selection.kind === 'stage') {
    for (const s of (
      period.stages.find((s) => s.stage === selection.stage)?.samples ?? []
    ).toSorted((a, b) => b.elapsedMs - a.elapsedMs || a.taskId.localeCompare(b.taskId))) {
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
          `${hours(s.elapsedMs)} · ${s.intervals.length} measured ${s.intervals.length === 1 ? 'visit' : 'visits'}${withWaits ? ` · ${hours(withWaits.elapsedMs - s.elapsedMs)} waiting for you left out` : ''}`,
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
  } else if (selection.kind === 'sent-back') {
    for (const s of countedBacks(period).filter((s) => sentBackMatches(s, selection)))
      items.push({
        key: s.id,
        taskId: s.taskId,
        lines: [
          `${at(s.at)} · ${label(s.from)} → ${label(s.to)}`,
          `Cause: ${causeName(causeOf(s))}${s.severity ? ` · Severity: ${severities.find((v) => v.key === s.severity)?.name ?? s.severity}` : ''}`,
        ],
      })
  } else if (selection.kind === 'failure') {
    for (const f of period.failures.filter((f) => failureMatches(f, selection)))
      items.push({
        key: f.id,
        taskId: f.taskId,
        lines: [
          `${failureKinds[f.kind]} · ${failureOutcomes.find((o) => o.key === f.outcome)?.name} · Recorded ${at(f.at)}`,
          ...(f.reason ? [`Your reason: ${f.reason}`] : []),
        ],
      })
  } else if (selection.kind === 'incomplete') {
    for (const s of period.incomplete)
      items.push({ key: s.taskId, taskId: s.taskId, lines: s.reasons })
  } else if (selection.kind === 'left-out') {
    for (const s of withoutWaits?.leftOut[selection.period] ?? [])
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
        As of {at(asOf)} · {items.length}{' '}
        {selection.kind === 'send-back' || selection.kind === 'sent-back'
          ? 'transitions'
          : selection.kind === 'failure'
            ? 'failure cases'
            : 'Tasks'}
        . Open a Task for its existing history and verification evidence.
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
  data: all,
  asOf,
  panel,
  selection,
  select,
  onClose,
  onOpenTask,
  factories = [],
}: {
  data: DashboardFlow
  asOf: string
  panel: 'flow' | 'stages'
  selection?: FlowSelection | undefined
  select: (s: FlowSelection) => void
  onClose: () => void
  onOpenTask: (id: string) => void
  factories?: readonly { id: string; name: string }[]
}) {
  const heading = useId()
  const previousSelect = (s: FlowSelection) => select({ ...s, period: 'previous' })
  const [includeWaits, setIncludeWaits] = useIncludeUserWaits()
  const reduced = panel === 'stages' && !includeWaits ? flowWithoutUserWaits(all) : undefined
  const data = reduced?.data ?? all
  const leftOut = reduced?.leftOut.current.length ?? 0
  return (
    <section className={styles.flow} aria-labelledby={heading}>
      <header className={styles.flowHead}>
        <div>
          <h2 id={heading}>{panel === 'stages' ? 'Time by Stage' : 'Flow'}</h2>
          <p className={styles.caption}>
            {panel !== 'stages'
              ? 'See where Tasks spend time and what holds them up.'
              : includeWaits
                ? 'See which Stages take time, including time waiting for you and repeat visits.'
                : 'See which Stages take time, without the time Tasks spent waiting for you.'}
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
              Stages with the same name are combined across Factories. A Stage only some of the
              shown Factories use says how many Factories and Tasks it covers.
            </p>
          )}
          <StageTable
            period={data.current}
            previous={data.previous}
            factories={factories}
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
                Wall-clock time including stops and rework, not agent effort, without the time a
                Task had an open request to you: a question, a sign-off, a Clarify round or a
                permission ask. Other waits still count. Tasks without a complete record of those
                requests are left out. Each Task’s repeated visits are added together. Started
                non-setup Tasks open during this period contribute, including Tasks now Done or
                archived.
              </p>
            )}
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
            <SendBackCauses data={data} factories={factories} select={select} />
            <Failures data={data} select={select} />
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
            {factories.length > 1 && (
              <FlowByFactory data={data} period={data.current} factories={factories} />
            )}
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
          withoutWaits={reduced && { original: all, leftOut: reduced.leftOut }}
        />
      )}
    </section>
  )
}
