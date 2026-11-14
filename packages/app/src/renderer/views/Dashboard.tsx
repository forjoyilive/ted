import type {
  DashboardBucket,
  DashboardChange,
  DashboardMetric,
  DashboardPeriod,
  DashboardTask,
  FactoryDashboard,
} from '@ted/protocol'
import {
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { CloseIcon } from '../components/icons.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { Select } from '../components/Select.tsx'
import type { DashboardSelection, DashboardViewState } from '../dashboard.ts'
import { useFactoryDashboard } from '../data.ts'
import { formatDate } from '../time.ts'
import styles from './Dashboard.module.css'
import { Flow } from './DashboardFlow.tsx'
import views from './views.module.css'

const labels: Record<DashboardMetric, string> = {
  completed: 'Tasks completed',
  created: 'Created → Done',
  intake: 'First Intake → Done',
}
const metrics: DashboardMetric[] = ['completed', 'created', 'intake']

function duration(value: number | null): string {
  if (value === null) return 'Unavailable'
  if (value === 0) return '0m'
  if (value < 60_000) return '<1m'
  const minutes = Math.round(value / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes / 60) % 24
  const rest = minutes % 60
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', rest ? `${rest}m` : '']
    .filter(Boolean)
    .join(' ')
}

const timestamp = (at: string) =>
  formatDate(at, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: new Date(at).getUTCMilliseconds() === 0 ? undefined : 3,
    timeZoneName: 'short',
  })
const machineDate = (at: string | Date, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', {
    ...options,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(typeof at === 'string' ? new Date(at) : at)
const shortDate = (at: string) => machineDate(at, { month: 'short', day: 'numeric' })
const clock = (at: number) => formatDate(new Date(at), { hour: '2-digit', minute: '2-digit' })
const hourMs = 3_600_000
const dayMs = 86_400_000
const lastDay = (bucket: DashboardBucket) => new Date(Date.parse(bucket.to) - 1)
const calendarDate = (at: Date) =>
  machineDate(at, { year: 'numeric', month: 'numeric', day: 'numeric' })
const dayCount = (bucket: DashboardBucket) =>
  Math.round((Date.parse(bucket.to) - Date.parse(bucket.from)) / dayMs)

function dayLabel(bucket: DashboardBucket, asOf: string): string {
  const first = new Date(bucket.from)
  const last = lastDay(bucket)
  const soFar = bucket.to === asOf ? ' (today so far)' : ''
  if (calendarDate(first) === calendarDate(last))
    return `${machineDate(first, { weekday: 'short', day: 'numeric', month: 'short' })}${soFar}`
  const sameMonth =
    machineDate(first, { year: 'numeric', month: 'numeric' }) ===
    machineDate(last, { year: 'numeric', month: 'numeric' })
  const start = sameMonth ? machineDate(first, { day: 'numeric' }) : shortDate(bucket.from)
  return `${start}–${shortDate(last.toISOString())}${soFar}`
}
const metricValue = (period: DashboardPeriod | DashboardBucket, metric: DashboardMetric) =>
  metric === 'completed' ? period.taskIds.length : period[metric].value
const idsOf = (
  period: DashboardPeriod | DashboardBucket,
  metric: DashboardMetric,
  missing = false,
) =>
  metric === 'completed'
    ? period.taskIds
    : missing
      ? period[metric].missingIds
      : period[metric].taskIds
const showValue = (metric: DashboardMetric, value: number | null) =>
  metric === 'completed' ? `${value ?? 0} tasks` : duration(value)

function Change({
  change,
  metric,
  all,
  today,
}: {
  change: DashboardChange | undefined
  metric: DashboardMetric
  all: boolean
  today: boolean
}) {
  const percent = change?.percent
  const good =
    percent !== null &&
    percent !== undefined &&
    (metric === 'completed' ? percent > 0 : percent < 0)
  return (
    <p className={`${styles.change} ${percent ? (good ? styles.good : styles.bad) : ''}`}>
      {all ? (
        'All retained history'
      ) : percent === null || percent === undefined ? (
        change?.absolute === null ? (
          'No duration sample to compare'
        ) : (
          'Percentage unavailable · Previous is 0'
        )
      ) : (
        <>
          <strong>
            {percent > 0 ? '+' : ''}
            {Number(percent.toFixed(1))}%
          </strong>
          <span>
            {`${metric === 'completed' ? '' : 'elapsed time '}${today ? 'vs yesterday to this time' : 'vs previous period'}`}
          </span>
        </>
      )}
    </p>
  )
}

export type PointTip = {
  heading: string
  aligned: string | null
  rows: { period: 'current' | 'previous'; label: string; value: string; note?: string }[]
  change: string | null
}

const tasks = (count: number) => `${count} ${count === 1 ? 'Task' : 'Tasks'}`

export function pointTip({
  metric,
  period,
  bucket,
  other,
  label,
  today,
}: {
  metric: DashboardMetric
  period: 'current' | 'previous'
  bucket: DashboardBucket
  other: DashboardBucket | undefined
  label: (bucket: DashboardBucket) => string
  today: boolean
}): PointTip {
  const earlier = today ? 'Yesterday' : 'Previous'
  const name = metric === 'completed' ? 'Completed' : 'Median'
  const value = metricValue(bucket, metric)
  const shown = (v: number | null, full: boolean) =>
    metric === 'completed'
      ? full
        ? tasks(v ?? 0)
        : String(v ?? 0)
      : v === null
        ? 'No sample'
        : duration(v)
  const first = {
    period,
    label: name,
    value: shown(value, true),
    ...(metric === 'completed' ? {} : { note: `from ${tasks(idsOf(bucket, metric).length)}` }),
  }
  if (period === 'previous')
    return {
      heading: `${earlier} · ${label(bucket)}`,
      aligned: other ? `Aligned to ${label(other)}` : null,
      rows: [first],
      change: null,
    }
  const before = other ? metricValue(other, metric) : undefined
  let change: string | null = null
  if (before === null) change = 'No previous sample'
  else if (before !== undefined && value !== null) {
    const difference = value - before
    const against = today ? 'yesterday' : 'previous'
    if (difference === 0) change = `Same as ${against}`
    else {
      const sign = difference > 0 ? '+' : '−'
      const amount =
        metric === 'completed' ? String(Math.abs(difference)) : duration(Math.abs(difference))
      const percent =
        metric === 'completed' && before > 0
          ? ` (${sign}${Math.round((Math.abs(difference) / before) * 100)}%)`
          : ''
      change = `${sign}${amount} vs ${against}${percent}`
    }
  }
  return {
    heading: label(bucket),
    aligned: null,
    rows: [
      first,
      ...(other
        ? [
            {
              period: 'previous' as const,
              label: `${earlier} · ${label(other)}`,
              value: shown(before ?? null, false),
            },
          ]
        : []),
    ],
    change,
  }
}

function Chart({
  data,
  metric,
  select,
}: {
  data: FactoryDashboard
  metric: DashboardMetric
  select: (sample: DashboardSelection) => void
}) {
  const a = data.current.buckets
  const b = data.previous?.buckets ?? []
  const [hovered, setHovered] = useState<{
    period: 'current' | 'previous'
    index: number
    point: HTMLElement
    data: FactoryDashboard
  } | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const tipId = useId()
  useLayoutEffect(() => {
    const box = frame.current
    const card = tip.current
    if (!hovered || !box || !card) return
    const outer = box.getBoundingClientRect()
    const point = hovered.point.getBoundingClientRect()
    const middle = point.left - outer.left + point.width / 2
    let left = middle + 12
    if (left + card.offsetWidth > outer.width - 8)
      left = Math.max(0, middle - 12 - card.offsetWidth)
    let top = point.top - outer.top - card.offsetHeight - 4
    if (top < 0) top = point.bottom - outer.top + 4
    card.style.left = `${left}px`
    card.style.top = `${top}px`
  }, [hovered])
  const values = [...a, ...b].flatMap((bucket) => {
    const value = metricValue(bucket, metric)
    return value === null ? [] : [value]
  })
  if (a.length === 0) return <p className={styles.chartEmpty}>No recorded completions to plot.</p>
  const rawMaximum = Math.max(metric === 'completed' ? 1 : 60_000, ...values)
  const maximum = metric === 'completed' ? Math.ceil(rawMaximum / 2) * 2 : rawMaximum
  const today = data.range === 'today'
  const start = Date.parse(data.current.from ?? data.asOf)
  const steps = today ? Math.max(1, a.length, b.length) : Math.max(1, a.length - 1)
  const x = (i: number) => 42 + (i * 438) / steps
  const now = x((Date.parse(data.asOf) - start) / hourMs)
  const rows = Array.from({ length: today ? Math.max(a.length, b.length) : a.length }, (_, i) => i)
  const y = (value: number) => 150 - (value / maximum) * 120
  const path = (buckets: DashboardBucket[]) => {
    let gap = true
    return buckets
      .map((bucket, index) => {
        const value = metricValue(bucket, metric)
        if (value === null) {
          gap = true
          return ''
        }
        const segment = `${gap ? 'M' : 'L'}${x(index)},${y(value)}`
        gap = false
        return segment
      })
      .join(' ')
  }
  const unit = metric === 'completed' ? 'Tasks' : 'Median elapsed time'
  const bounds = (bucket: DashboardBucket) =>
    today
      ? `${timestamp(bucket.from)} – ${timestamp(bucket.to)} (end excluded)`
      : dayLabel(bucket, data.asOf)
  const perPoint = Math.max(1, a[0] ? dayCount(a[0]) : 1)
  const last = a.at(-1)
  const number = (value: number) =>
    metric === 'completed' ? String(Math.round(value)) : duration(value)
  const pointLabel = (bucket: DashboardBucket) =>
    today
      ? `${clock(Date.parse(bucket.from))} – ${clock(Date.parse(bucket.to))}`
      : dayLabel(bucket, data.asOf)
  const shownBucket =
    hovered?.data === data ? (hovered.period === 'current' ? a : b)[hovered.index] : undefined
  const details =
    hovered && shownBucket
      ? pointTip({
          metric,
          period: hovered.period,
          bucket: shownBucket,
          other: (hovered.period === 'current' ? b : a)[hovered.index],
          label: pointLabel,
          today,
        })
      : null
  const leave = (point: HTMLElement) =>
    setHovered((shown) => (shown?.point === point ? null : shown))
  return (
    <div className={styles.chart} ref={frame}>
      <div className={styles.legend}>
        <span>
          <i />
          {today
            ? 'Today'
            : last &&
              `${shortDate(a[0]?.from ?? data.asOf)} – ${shortDate(lastDay(last).toISOString())}`}
        </span>
        {data.previous && (
          <span>
            <i className={styles.previousKey} />
            {today ? 'Yesterday · aligned by hour' : 'Previous · aligned by day'}
          </span>
        )}
      </div>
      <svg
        viewBox="0 0 500 185"
        aria-label={`${labels[metric]} by ${today ? 'hour' : perPoint === 1 ? 'day' : `${perPoint} days`}`}
      >
        <title>
          {unit}.{' '}
          {metric !== 'completed'
            ? 'Buckets without a duration sample are gaps.'
            : 'Empty buckets count as zero.'}
        </title>
        {[0, 0.5, 1].map((part) => (
          <g key={part}>
            <line
              className={styles.gridline}
              x1="42"
              x2="480"
              y1={y(maximum * part)}
              y2={y(maximum * part)}
            />
            <text x="36" y={y(maximum * part) + 4} textAnchor="end">
              {number(maximum * part)}
            </text>
          </g>
        ))}
        {today && (
          <>
            <line className={styles.nowLine} x1={now} x2={now} y1="26" y2="150" />
            <text x={now} y="20" textAnchor="middle">
              Now
            </text>
          </>
        )}
        {details && hovered && (
          <line
            className={styles.guideLine}
            x1={x(hovered.index)}
            x2={x(hovered.index)}
            y1="26"
            y2="150"
          />
        )}
        {data.previous && <path className={styles.previousLine} d={path(b)} />}
        <path className={styles.currentLine} d={path(a)} />
        {(
          [
            ['previous', b],
            ['current', a],
          ] as const
        ).flatMap(([period, buckets]) =>
          buckets.map((bucket, index) => {
            const value = metricValue(bucket, metric)
            if (value === null) return null
            return (
              <foreignObject
                key={`${period}-${bucket.from}`}
                x={x(index) - 9}
                y={y(value) - 9}
                width="18"
                height="18"
              >
                <button
                  type="button"
                  className={period === 'current' ? styles.point : styles.previousPoint}
                  aria-label={`${period === 'current' ? 'Selected' : 'Previous'} · ${bounds(bucket)} · ${showValue(metric, value)}`}
                  aria-describedby={
                    details && hovered?.period === period && hovered.index === index
                      ? tipId
                      : undefined
                  }
                  onMouseEnter={(event) =>
                    setHovered({ period, index, point: event.currentTarget, data })
                  }
                  onFocus={(event) =>
                    setHovered({ period, index, point: event.currentTarget, data })
                  }
                  onMouseLeave={(event) => leave(event.currentTarget)}
                  onBlur={(event) => leave(event.currentTarget)}
                  onClick={() => select({ metric, period, bucket: index })}
                />
              </foreignObject>
            )
          }),
        )}
        {today
          ? [0, 6, 12, 18, steps].map((i) => (
              <text
                key={i}
                x={x(i)}
                y="175"
                textAnchor={i === 0 ? 'start' : i === steps ? 'end' : 'middle'}
              >
                {clock(start + i * hourMs)}
              </text>
            ))
          : (data.range === '7d'
              ? a.map((_, i) => i)
              : [...new Set([0, Math.floor((a.length - 1) / 2), a.length - 1])]
            ).map((i) => {
              const bucket = a[i]
              if (!bucket) return null
              const end = i === a.length - 1 && i > 0
              return (
                <text
                  key={i}
                  x={x(i)}
                  y="175"
                  textAnchor={i === 0 ? 'start' : end ? 'end' : 'middle'}
                >
                  {data.range === '7d'
                    ? machineDate(bucket.from, { weekday: 'short', day: 'numeric' })
                    : shortDate(end ? lastDay(bucket).toISOString() : bucket.from)}
                </text>
              )
            })}
      </svg>
      {details && (
        <div className={styles.tooltip} role="tooltip" id={tipId} ref={tip}>
          <div className={styles.tooltipHeading}>{details.heading}</div>
          {details.aligned && <div className={styles.tooltipNote}>{details.aligned}</div>}
          {details.rows.map((row) => (
            <Fragment key={row.label}>
              <div className={styles.tooltipRow}>
                <span>
                  <i className={row.period === 'previous' ? styles.tooltipPrevious : undefined} />
                  {row.label}
                </span>
                <strong>{row.value}</strong>
              </div>
              {row.note && <div className={styles.tooltipNote}>{row.note}</div>}
            </Fragment>
          ))}
          {details.change && <div className={styles.tooltipChange}>{details.change}</div>}
        </div>
      )}
      <p className={styles.caption}>
        {data.range === 'all'
          ? `${perPoint === 1 ? 'One point per calendar day' : `Each point covers ${perPoint} calendar days`}, midnight to midnight. The last point runs to now.`
          : today
            ? 'One point per hour since midnight. Today’s last hour is still running. Yesterday’s line shows the whole day; the figures above count it only to this time.'
            : 'One point per calendar day, midnight to midnight. Today is not included.'}{' '}
        {metric === 'completed'
          ? 'Tasks per point.'
          : 'Graph shows medians per point, not the whole-period median above. No sample = gap.'}
      </p>
      <details className={styles.dataTable}>
        <summary>Graph data and samples</summary>
        <table>
          <caption>
            {unit} ·{' '}
            {today ? 'Interval end timestamps are excluded' : 'Days run midnight to midnight'}
          </caption>
          <thead>
            <tr>
              <th>{today ? 'Interval' : perPoint === 1 ? 'Day' : 'Days'}</th>
              <th>{today ? 'Today' : 'Selected'}</th>
              {data.previous && <th>{today ? 'Yesterday' : 'Previous'}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((index) => {
              const bucket = a[index]
              return (
                <tr key={index}>
                  <th scope="row">{bucket ? bounds(bucket) : 'Not reached yet today'}</th>
                  <td>
                    {bucket && (
                      <button
                        type="button"
                        data-nav-item
                        className={styles.link}
                        onClick={() => select({ metric, period: 'current', bucket: index })}
                      >
                        {showValue(metric, metricValue(bucket, metric))} ·{' '}
                        {idsOf(bucket, metric).length} Tasks
                      </button>
                    )}
                  </td>
                  {data.previous && (
                    <td>
                      {b[index] && (
                        <button
                          type="button"
                          data-nav-item
                          className={styles.link}
                          title={bounds(b[index])}
                          onClick={() => select({ metric, period: 'previous', bucket: index })}
                        >
                          {showValue(metric, metricValue(b[index], metric))} ·{' '}
                          {idsOf(b[index], metric).length} Tasks
                          <br />
                          {bounds(b[index])}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </details>
    </div>
  )
}

function MetricPanel({
  data,
  metric,
  select,
}: {
  data: FactoryDashboard
  metric: DashboardMetric
  select: (sample: DashboardSelection) => void
}) {
  const heading = useId()
  const value = metricValue(data.current, metric)
  const change = data.comparison?.[metric]
  const sample = idsOf(data.current, metric)
  const missing = metric === 'completed' ? [] : data.current[metric].missingIds
  const previous = data.previous
  const absolute = change?.absolute
  return (
    <section className={styles.panel} aria-labelledby={heading}>
      <header className={styles.panelHead}>
        <h2 id={heading}>{labels[metric]}</h2>
        <span>{metric === 'completed' ? 'Completed Tasks' : 'Median elapsed time'}</span>
      </header>
      <div className={styles.headline}>
        <button
          type="button"
          data-nav-item
          className={styles.value}
          onClick={() => select({ metric, period: 'current' })}
        >
          {showValue(metric, value)}
        </button>
        <Change
          change={change}
          metric={metric}
          all={previous === null}
          today={data.range === 'today'}
        />
        {previous && (
          <details className={styles.comparison}>
            <summary>Comparison details</summary>
            <p>
              Previous: {showValue(metric, metricValue(previous, metric))}
              <br />
              Absolute difference:{' '}
              {absolute === null || absolute === undefined
                ? 'Unavailable'
                : `${absolute > 0 ? '+' : absolute < 0 ? '−' : ''}${metric === 'completed' ? `${Math.abs(absolute)} tasks` : duration(Math.abs(absolute))}`}
              <br />
              Selected sample: {sample.length} Tasks · Previous sample:{' '}
              {idsOf(previous, metric).length} Tasks
            </p>
          </details>
        )}
      </div>
      {data.current.taskIds.length === 0 && (
        <p className={styles.empty}>No Tasks completed in this period.</p>
      )}
      {value === null && data.current.taskIds.length > 0 && (
        <p className={styles.empty}>
          No recorded start times for this duration. These Tasks remain in the completed count.
        </p>
      )}
      <Chart data={data} metric={metric} select={select} />
      <footer className={styles.panelFoot}>
        <p className={styles.caption}>
          Sample: {sample.length} Tasks
          {metric !== 'completed' && <> · {missing.length} missing starts</>}
          {previous && (
            <>
              {' '}
              · Previous: {idsOf(previous, metric).length} Tasks
              {metric !== 'completed' && (
                <> · {previous[metric].missingIds.length} missing starts</>
              )}
            </>
          )}
        </p>
        <div className={styles.links}>
          <button
            type="button"
            className={styles.link}
            onClick={() => select({ metric, period: 'current' })}
          >
            View {sample.length} Tasks
          </button>
          {previous && (
            <button
              type="button"
              className={styles.link}
              onClick={() => select({ metric, period: 'previous' })}
            >
              Previous {idsOf(previous, metric).length} Tasks
            </button>
          )}
          {missing.length > 0 && (
            <button
              type="button"
              className={styles.link}
              onClick={() => select({ metric, period: 'current', missing: true })}
            >
              {missing.length} missing starts
            </button>
          )}
          {previous && metric !== 'completed' && previous[metric].missingIds.length > 0 && (
            <button
              type="button"
              className={styles.link}
              onClick={() => select({ metric, period: 'previous', missing: true })}
            >
              Previous {previous[metric].missingIds.length} missing starts
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}

function Sample({
  data,
  selection,
  onClose,
  onOpenTask,
}: {
  data: FactoryDashboard
  selection: DashboardSelection
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
  const bucket = selection.bucket === undefined ? undefined : period?.buckets[selection.bucket]
  const sample =
    selection.metric === 'unavailable' ? null : selection.bucket === undefined ? period : bucket
  const ids =
    selection.metric === 'unavailable'
      ? data.unavailableIds
      : sample
        ? idsOf(sample, selection.metric, selection.missing)
        : []
  const records = new Map(data.tasks.map((task) => [task.id, task]))
  const days = data.range !== 'today' && bucket !== undefined
  const title =
    selection.metric === 'unavailable'
      ? 'Unavailable completion history'
      : `${labels[selection.metric]} · ${
          selection.missing
            ? 'Missing starts'
            : days
              ? `${selection.period === 'previous' ? 'Previous · ' : ''}${dayLabel(bucket, data.asOf)}`
              : selection.period === 'current'
                ? 'Selected period'
                : 'Previous period'
        }`
  const describe = (task: DashboardTask) =>
    selection.metric === 'unavailable'
      ? 'Done timestamp unavailable'
      : [
          task.doneAt ? `Done ${timestamp(task.doneAt)}` : '',
          task.archived ? 'Archived' : '',
          selection.metric === 'created'
            ? task.createdMs === null
              ? 'Start unavailable'
              : duration(task.createdMs)
            : selection.metric === 'intake'
              ? task.intakeMs === null
                ? 'Start unavailable'
                : duration(task.intakeMs)
              : '',
        ]
          .filter(Boolean)
          .join(' · ')
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
        <button type="button" className={styles.close} aria-label="Close sample" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <p>
        {ids.length} Tasks · As of {timestamp(data.asOf)}
      </p>
      {sample?.from && (
        <p className={styles.caption}>
          {days && bucket && bucket.to !== data.asOf && dayCount(bucket) === 1
            ? 'Midnight to midnight'
            : `${timestamp(sample.from)} – ${timestamp(sample.to)} (end excluded)`}
        </p>
      )}
      <p className={styles.caption}>
        {selection.metric === 'unavailable'
          ? 'Completion period unknown. Excluded from period metrics because no Done timestamp was recorded.'
          : selection.missing
            ? 'Included in the completed count; excluded from this duration’s median.'
            : 'Exact Tasks behind this sample. Archived Done Tasks are included.'}
      </p>
      <ul className={styles.taskList}>
        {ids.map((id) => {
          const task = records.get(id)
          return task ? (
            <li key={id}>
              <button
                type="button"
                data-nav-item
                className={styles.task}
                onClick={() => onOpenTask(id)}
              >
                <span>
                  {task.displayId} &nbsp; {task.title}
                </span>
                <small>{describe(task)}</small>
              </button>
            </li>
          ) : null
        })}
      </ul>
      {ids.length === 0 && <p>No Tasks in this sample.</p>}
    </dialog>
  )
}

export function Dashboard({
  factoryId,
  title,
  state,
  onChange,
  onOpenTask,
  banners,
}: {
  factoryId: string
  title: string
  state: DashboardViewState
  onChange: (state: DashboardViewState) => void
  onOpenTask: (id: string) => void
  banners?: ReactNode
}) {
  const resource = useFactoryDashboard(factoryId, state.range)
  const data = resource.value
  const panel = state.panel ?? 'overview'
  const panels = ['overview', 'flow', 'stages'] as const
  const choosePanel = (panel: NonNullable<DashboardViewState['panel']>) =>
    onChange({ range: state.range, panel })
  const select = (sample: DashboardSelection) => onChange({ ...state, sample })
  return (
    <section className={`${views.pane} ${styles.dashboard}`} aria-label="Factory Dashboard">
      <header className={views.header}>
        <h1 className={views.title}>{title} › Dashboard</h1>
        <span className={views.headerSpacer} />
        <Select
          aria-label="Historical period"
          value={state.range}
          onChange={(event) => {
            const range = event.target.value
            if (range === 'today' || range === '7d' || range === '30d' || range === 'all')
              onChange({ range, ...(state.panel && { panel: state.panel }) })
          }}
        >
          <option value="today">Today</option>
          <option value="30d">Last 30 days</option>
          <option value="7d">Last 7 days</option>
          <option value="all">All retained history</option>
        </Select>
      </header>
      {banners}
      <div className={styles.body}>
        <div className={styles.dashboardTabs} role="tablist" aria-label="Dashboard panels">
          {panels.map((name, index) => (
            <button
              key={name}
              id={`dashboard-${name}`}
              type="button"
              role="tab"
              aria-selected={panel === name}
              aria-controls={`dashboard-panel-${name}`}
              tabIndex={panel === name ? 0 : -1}
              onClick={() => choosePanel(name)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? panels.length - 1
                      : (index + (event.key === 'ArrowRight' ? 1 : panels.length - 1)) %
                        panels.length
                const target = panels[next]
                if (target) {
                  choosePanel(target)
                  document.getElementById(`dashboard-${target}`)?.focus()
                }
              }}
            >
              {name === 'overview' ? 'Overview' : name === 'flow' ? 'Flow' : 'Stages'}
            </button>
          ))}
        </div>
        {panel === 'overview' && (
          <p className={styles.intro}>Task completions and completion time</p>
        )}
        {resource.error && (
          <>
            <LoadingError error={resource.error} retry={resource.retry} />
            {data && (
              <p className={styles.caption}>Showing last-known results. The refresh failed.</p>
            )}
          </>
        )}
        {!data && !resource.error && <Skeleton label="Loading Dashboard…" shape="settings" />}
        {data && (
          <section
            role="tabpanel"
            id={`dashboard-panel-${panel}`}
            aria-labelledby={`dashboard-${panel}`}
          >
            {panel === 'overview' ? (
              <>
                <p className={styles.caption}>
                  {data.current.from
                    ? `${timestamp(data.current.from)} – ${timestamp(data.current.to)} (end excluded)`
                    : 'No retained completion timestamps'}
                  <br />
                  {data.previous && (
                    <>
                      Compared with {timestamp(data.previous.from ?? data.previous.to)} –{' '}
                      {timestamp(data.previous.to)} (end excluded)
                      <br />
                    </>
                  )}
                  As of {timestamp(data.asOf)}
                </p>
                {data.unavailableIds.length > 0 && (
                  <p className={styles.notice}>
                    Completion history is unavailable for {data.unavailableIds.length} Done Tasks
                    with no recorded Done timestamp. Their completion period cannot be determined.{' '}
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => select({ metric: 'unavailable', period: 'current' })}
                    >
                      View Tasks
                    </button>
                  </p>
                )}
                <div className={styles.grid}>
                  {metrics.map((metric) => (
                    <MetricPanel key={metric} data={data} metric={metric} select={select} />
                  ))}
                </div>
                <p className={styles.definition}>
                  Each retained Task counts once at its latest recorded Done entry, including
                  archived Done Tasks. Factory setup is excluded.
                  <br />
                  Durations include waits, stops and rework. Created → Done also includes Backlog.
                  Elapsed time is not agent effort. Different completed Tasks form each period’s
                  sample.
                </p>
                {state.sample && (
                  <Sample
                    data={data}
                    selection={state.sample}
                    onClose={() =>
                      onChange({ range: state.range, ...(state.panel && { panel: state.panel }) })
                    }
                    onOpenTask={onOpenTask}
                  />
                )}
              </>
            ) : (
              <Flow
                panel={panel}
                data={data.flow}
                asOf={data.asOf}
                selection={state.flowSample}
                select={(flowSample) => onChange({ range: state.range, panel, flowSample })}
                onClose={() =>
                  onChange({ range: state.range, ...(state.panel && { panel: state.panel }) })
                }
                onOpenTask={onOpenTask}
              />
            )}
          </section>
        )}
      </div>
    </section>
  )
}
