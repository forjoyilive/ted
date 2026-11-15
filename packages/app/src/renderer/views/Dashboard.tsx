import type {
  DashboardBucket,
  DashboardChange,
  DashboardFactoryPeriod,
  DashboardMetric,
  DashboardOpenState,
  DashboardPeriod,
  DashboardReport,
  DashboardTask,
  Factory,
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
import { FactoryIcon } from '../components/FactoryIcon.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { Select } from '../components/Select.tsx'
import {
  type DashboardSelection,
  type DashboardViewState,
  rememberDashboard,
  shownFactoryIds,
} from '../dashboard.ts'
import { useDashboard } from '../data.ts'
import { stageName } from '../list-view.ts'
import { formatDate } from '../time.ts'
import styles from './Dashboard.module.css'
import { Flow } from './DashboardFlow.tsx'
import { CheckItem, MenuButton } from './TaskList.tsx'
import views from './views.module.css'

const labels: Record<DashboardMetric, string> = {
  completed: 'Tasks completed',
  merged: 'Pull requests merged',
  created: 'Created → Done',
  backlog: 'Waiting in Backlog',
  intake: 'First Intake → Done',
}
const counts = (metric: DashboardMetric) => metric === 'completed' || metric === 'merged'
const openLabels: Record<DashboardOpenState, string> = {
  working: 'Working',
  'waiting-on-you': 'waiting on you',
  blocked: 'Blocked',
  backlog: 'in Backlog',
  other: 'other',
}
const openStateName: Record<DashboardOpenState, string> = {
  working: 'Working',
  'waiting-on-you': 'Waiting on you',
  blocked: 'Blocked',
  backlog: 'In Backlog',
  other: 'Other',
}
const openOrder: DashboardOpenState[] = ['working', 'waiting-on-you', 'backlog', 'blocked', 'other']

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
  metric === 'completed'
    ? period.taskIds.length
    : metric === 'merged'
      ? period.merged.count
      : period[metric].value
const idsOf = (
  period: DashboardPeriod | DashboardBucket,
  metric: DashboardMetric,
  missing = false,
) =>
  metric === 'completed'
    ? period.taskIds
    : metric === 'merged'
      ? period.merged.taskIds
      : missing
        ? period[metric].missingIds
        : period[metric].taskIds
const showValue = (metric: DashboardMetric, value: number | null) =>
  metric === 'completed'
    ? `${value ?? 0} tasks`
    : metric === 'merged'
      ? String(value ?? 0)
      : duration(value)

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
    percent !== null && percent !== undefined && (counts(metric) ? percent > 0 : percent < 0)
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
            {`${counts(metric) ? '' : 'elapsed time '}${today ? 'vs yesterday to this time' : 'vs previous period'}`}
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

export function countScale(maximum: number): number[] {
  const step = maximum <= 4 ? 1 : Math.ceil(maximum / 4)
  const top = Math.max(1, Math.ceil(maximum / step)) * step
  return Array.from({ length: top / step + 1 }, (_, i) => i * step)
}

export function byFactoryCount(
  taskIds: readonly string[],
  tasks: readonly { id: string; factoryId: string }[],
  factoryIds: readonly string[],
): { factoryId: string; count: number }[] {
  const factoryOf = new Map(tasks.map((task) => [task.id, task.factoryId]))
  return factoryIds
    .map((factoryId) => ({
      factoryId,
      count: taskIds.filter((id) => factoryOf.get(id) === factoryId).length,
    }))
    .filter((row) => row.count > 0)
}

function Chart({
  data,
  factories,
  select,
}: {
  data: DashboardReport
  factories: readonly Factory[]
  select: (sample: DashboardSelection) => void
}) {
  const metric = 'completed'
  const a = data.current.buckets
  const b = data.previous?.buckets ?? []
  const [hovered, setHovered] = useState<{
    period: 'current' | 'previous'
    index: number
    point: HTMLElement
    data: DashboardReport
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
    let left = point.right - outer.left + 8
    if (left + card.offsetWidth > outer.width - 8)
      left = Math.max(0, point.left - outer.left - 8 - card.offsetWidth)
    const top = point.top - outer.top + point.height / 2 - card.offsetHeight / 2
    card.style.left = `${left}px`
    card.style.top = `${Math.max(0, top)}px`
  }, [hovered])
  if (a.length === 0) return <p className={styles.chartEmpty}>No recorded completions to plot.</p>
  const scale = countScale(Math.max(1, ...[...a, ...b].map((bucket) => bucket.taskIds.length)))
  const maximum = scale.at(-1) ?? 1
  const today = data.range === 'today'
  const start = Date.parse(data.current.from ?? data.asOf)
  const slots = today ? Math.max(1, a.length, b.length) : a.length
  const plot = { left: 42, right: 990, top: 14, bottom: 196 }
  const width = (plot.right - plot.left) / slots
  const edge = (i: number) => plot.left + i * width
  const centre = (i: number) => edge(i + 0.5)
  const now = edge((Date.parse(data.asOf) - start) / hourMs)
  const rows = Array.from({ length: today ? Math.max(a.length, b.length) : a.length }, (_, i) => i)
  const y = (value: number) => plot.bottom - (value / maximum) * (plot.bottom - plot.top)
  const bar = Math.max(2, Math.min(width * 0.7, 40))
  const previousPath = b
    .map(
      (bucket, index) => `${index === 0 ? 'M' : 'L'}${centre(index)},${y(bucket.taskIds.length)}`,
    )
    .join(' ')
  const unit = 'Tasks'
  const bounds = (bucket: DashboardBucket) =>
    today
      ? `${timestamp(bucket.from)} – ${timestamp(bucket.to)} (end excluded)`
      : dayLabel(bucket, data.asOf)
  const perPoint = Math.max(1, a[0] ? dayCount(a[0]) : 1)
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
  const factoryRows =
    shownBucket && data.factoryIds.length > 1
      ? byFactoryCount(shownBucket.taskIds, data.tasks, data.factoryIds)
      : []
  const factory = (id: string) => factories.find((f) => f.id === id)
  const leave = (point: HTMLElement) =>
    setHovered((shown) => (shown?.point === point ? null : shown))
  const hover = (period: 'current' | 'previous', index: number) => ({
    onMouseEnter: (event: { currentTarget: HTMLElement }) =>
      setHovered({ period, index, point: event.currentTarget, data }),
    onFocus: (event: { currentTarget: HTMLElement }) =>
      setHovered({ period, index, point: event.currentTarget, data }),
    onMouseLeave: (event: { currentTarget: HTMLElement }) => leave(event.currentTarget),
    onBlur: (event: { currentTarget: HTMLElement }) => leave(event.currentTarget),
    'aria-describedby':
      details && hovered?.period === period && hovered.index === index ? tipId : undefined,
  })
  const ticks = today
    ? [0, 6, 12, 18, slots].map((i) => ({
        key: i,
        x: edge(i),
        anchor: i === 0 ? ('start' as const) : i === slots ? ('end' as const) : ('middle' as const),
        text: clock(start + i * hourMs),
      }))
    : a.flatMap((bucket, i) => {
        const every = data.range === '7d' ? 1 : Math.ceil(a.length / 6)
        if (i % every !== 0) return []
        return [
          {
            key: i,
            x: centre(i),
            anchor: 'middle' as const,
            text:
              data.range === '7d'
                ? machineDate(bucket.from, { weekday: 'short', day: 'numeric' })
                : shortDate(bucket.from),
          },
        ]
      })
  return (
    <div className={styles.chart} ref={frame}>
      <div className={styles.legend}>
        {data.factoryIds.map((id) => (
          <span key={id}>
            <i className={styles.swatch} style={{ background: factoryColor(factory(id)) }} />
            {factory(id)?.name ?? 'Removed Factory'}
          </span>
        ))}
        {data.previous && (
          <span>
            <i className={styles.previousKey} />
            {today ? 'Yesterday · aligned by hour' : 'Previous · aligned by day'}
          </span>
        )}
      </div>
      <svg
        viewBox="0 0 1000 222"
        aria-label={`${labels[metric]} by ${today ? 'hour' : perPoint === 1 ? 'day' : `${perPoint} days`}`}
      >
        <title>{unit}. Empty bars count as zero.</title>
        {scale.map((value) => (
          <g key={value}>
            <line
              className={styles.gridline}
              x1={plot.left}
              x2={plot.right}
              y1={y(value)}
              y2={y(value)}
            />
            <text x={plot.left - 6} y={y(value) + 4} textAnchor="end">
              {value}
            </text>
          </g>
        ))}
        {a.map((bucket, index) => (
          <foreignObject
            key={`column-${bucket.from}`}
            x={edge(index)}
            y={plot.top}
            width={width}
            height={plot.bottom - plot.top}
          >
            <button
              type="button"
              className={styles.column}
              aria-label={`Selected · ${bounds(bucket)} · ${showValue(metric, bucket.taskIds.length)}`}
              {...hover('current', index)}
              onClick={() => select({ metric, period: 'current', bucket: index })}
            />
          </foreignObject>
        ))}
        {a.map((bucket, index) => {
          let base = 0
          return byFactoryCount(bucket.taskIds, data.tasks, data.factoryIds).map((part) => {
            const from = base
            base += part.count
            return (
              <rect
                key={`${bucket.from}-${part.factoryId}`}
                className={styles.bar}
                x={centre(index) - bar / 2}
                y={y(base)}
                width={bar}
                height={y(from) - y(base)}
                style={{ fill: factoryColor(factory(part.factoryId)) }}
              />
            )
          })
        })}
        {today && (
          <>
            <line className={styles.nowLine} x1={now} x2={now} y1={plot.top} y2={plot.bottom} />
            <text x={now} y={plot.top - 4} textAnchor="middle">
              Now
            </text>
          </>
        )}
        {data.previous && <path className={styles.previousLine} d={previousPath} />}
        {b.map((bucket, index) => (
          <foreignObject
            key={`previous-${bucket.from}`}
            x={centre(index) - 9}
            y={y(bucket.taskIds.length) - 9}
            width="18"
            height="18"
          >
            <button
              type="button"
              className={styles.previousPoint}
              aria-label={`Previous · ${bounds(bucket)} · ${showValue(metric, bucket.taskIds.length)}`}
              {...hover('previous', index)}
              onClick={() => select({ metric, period: 'previous', bucket: index })}
            />
          </foreignObject>
        ))}
        {ticks.map((tick) => (
          <text key={tick.key} x={tick.x} y={plot.bottom + 20} textAnchor={tick.anchor}>
            {tick.text}
          </text>
        ))}
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
          {factoryRows.map((row) => (
            <div key={row.factoryId} className={styles.tooltipRow}>
              <span>
                <i
                  className={styles.swatch}
                  style={{ background: factoryColor(factory(row.factoryId)) }}
                />
                {factory(row.factoryId)?.name ?? 'Removed Factory'}
              </span>
              <strong>{row.count}</strong>
            </div>
          ))}
          {details.change && <div className={styles.tooltipChange}>{details.change}</div>}
        </div>
      )}
      <p className={styles.caption}>
        {data.range === 'all'
          ? `${perPoint === 1 ? 'One bar per calendar day' : `Each bar covers ${perPoint} calendar days`}, midnight to midnight. The last bar runs to now.`
          : today
            ? 'One bar per hour since midnight. Today’s last hour is still running. Yesterday’s line shows the whole day; the figures above count it only to this time.'
            : 'One bar per calendar day, midnight to midnight. Today is not included.'}{' '}
        Tasks per bar, split by Factory.
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
                        {showValue(metric, bucket.taskIds.length)} · {bucket.taskIds.length} Tasks
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
                          {showValue(metric, b[index].taskIds.length)} · {b[index].taskIds.length}{' '}
                          Tasks
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

function Completed({
  data,
  factories,
  select,
}: {
  data: DashboardReport
  factories: readonly Factory[]
  select: (sample: DashboardSelection) => void
}) {
  const heading = useId()
  const metric = 'completed'
  const value = data.current.taskIds.length
  const change = data.comparison?.completed
  const previous = data.previous
  const absolute = change?.absolute
  return (
    <section className={`${styles.panel} ${styles.wide}`} aria-labelledby={heading}>
      <header className={styles.panelHead}>
        <h2 id={heading}>{labels.completed}</h2>
        <span>Completed Tasks</span>
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
              Previous: {showValue(metric, previous.taskIds.length)}
              <br />
              Absolute difference:{' '}
              {absolute === null || absolute === undefined
                ? 'Unavailable'
                : `${absolute > 0 ? '+' : absolute < 0 ? '−' : ''}${Math.abs(absolute)} tasks`}
            </p>
          </details>
        )}
      </div>
      {value === 0 && <p className={styles.empty}>No Tasks completed in this period.</p>}
      <Chart data={data} factories={factories} select={select} />
      <footer className={styles.panelFoot}>
        <div className={styles.links}>
          <button
            type="button"
            className={styles.link}
            onClick={() => select({ metric, period: 'current' })}
          >
            View {value} Tasks
          </button>
          {previous && (
            <button
              type="button"
              className={styles.link}
              onClick={() => select({ metric, period: 'previous' })}
            >
              Previous {previous.taskIds.length} Tasks
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}

function comparedWith(data: DashboardReport, metric: DashboardMetric): string | null {
  if (!data.previous) return null
  const value = metricValue(data.previous, metric)
  return `Previous: ${counts(metric) ? (value ?? 0) : duration(value)}`
}

function Throughput({
  data,
  select,
}: {
  data: DashboardReport
  select: (sample: DashboardSelection) => void
}) {
  const merged = useId()
  const open = useId()
  const today = data.range === 'today'
  const states = openOrder.flatMap((state) => {
    const count = data.open.filter((task) => task.state === state).length
    return count === 0 ? [] : [`${count} ${openLabels[state]}`]
  })
  return (
    <div className={styles.panel}>
      <section className={styles.figure} aria-labelledby={merged}>
        <h2 id={merged}>{labels.merged}</h2>
        <button
          type="button"
          data-nav-item
          className={styles.value}
          aria-label={`${data.current.merged.count} pull requests merged`}
          onClick={() => select({ metric: 'merged', period: 'current' })}
        >
          {data.current.merged.count}
        </button>
        <Change
          change={data.comparison?.merged}
          metric="merged"
          all={data.previous === null}
          today={today}
        />
        <p className={styles.caption}>
          {[
            comparedWith(data, 'merged'),
            `From ${data.current.merged.taskIds.length} completed Tasks. A Task with several repos merges several pull requests.`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </section>
      <section className={styles.figure} aria-labelledby={open}>
        <h2 id={open}>Open Tasks right now</h2>
        <button
          type="button"
          data-nav-item
          className={`${styles.value} ${styles.smallValue}`}
          aria-label={`${data.open.length} open Tasks`}
          onClick={() => select({ metric: 'open', period: 'current' })}
        >
          {data.open.length}
        </button>
        <p className={styles.change}>
          {states.length === 0 ? 'No open Tasks' : states.join(' · ')}
        </p>
      </section>
    </div>
  )
}

function TaskTime({
  data,
  select,
}: {
  data: DashboardReport
  select: (sample: DashboardSelection) => void
}) {
  const heading = useId()
  const { created, backlog, intake } = data.current
  const parts = (['backlog', 'intake'] as const).map((metric) => ({
    metric,
    value: data.current[metric].value,
  }))
  const whole = (backlog.value ?? 0) + (intake.value ?? 0)
  return (
    <section className={styles.panel} aria-labelledby={heading}>
      <header className={styles.panelHead}>
        <h2 id={heading}>How long a Task takes</h2>
        <span>Median elapsed time</span>
      </header>
      <div className={styles.headline}>
        <button
          type="button"
          data-nav-item
          className={styles.value}
          aria-label={`${labels.created} ${duration(created.value)}`}
          onClick={() => select({ metric: 'created', period: 'current' })}
        >
          {duration(created.value)}
        </button>
        <Change
          change={data.comparison?.created}
          metric="created"
          all={data.previous === null}
          today={data.range === 'today'}
        />
        <p className={styles.caption}>
          {labels.created}, median of {created.taskIds.length} Tasks
          {comparedWith(data, 'created') && ` · ${comparedWith(data, 'created')}`}
        </p>
        {whole > 0 && (
          <div className={styles.split}>
            {parts.map(
              (part) =>
                part.value !== null &&
                part.value > 0 && (
                  <button
                    key={part.metric}
                    type="button"
                    className={styles[part.metric]}
                    style={{ flexGrow: part.value / whole }}
                    aria-label={`${labels[part.metric]} ${duration(part.value)}`}
                    onClick={() => select({ metric: part.metric, period: 'current' })}
                  />
                ),
            )}
          </div>
        )}
        <div className={styles.splitLabels}>
          {parts.map((part) => (
            <div key={part.metric}>
              <button
                type="button"
                data-nav-item
                className={styles.link}
                onClick={() => select({ metric: part.metric, period: 'current' })}
              >
                <i className={styles[part.metric]} />
                <strong>{duration(part.value)}</strong> {labels[part.metric]}
              </button>
              <Change
                change={data.comparison?.[part.metric]}
                metric={part.metric}
                all={data.previous === null}
                today={data.range === 'today'}
              />
            </div>
          ))}
        </div>
        <p className={styles.caption}>
          Each part is its own median, so the two can differ a little from the whole. Waiting in
          Backlog runs from Created to first Intake.
          {intake.missingIds.length > 0 && (
            <>
              {' '}
              <button
                type="button"
                className={styles.link}
                onClick={() => select({ metric: 'intake', period: 'current', missing: true })}
              >
                {intake.missingIds.length} missing starts
              </button>
            </>
          )}
        </p>
      </div>
    </section>
  )
}

function Sample({
  data,
  selection,
  onClose,
  onOpenTask,
}: {
  data: DashboardReport
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
  const metric =
    selection.metric === 'unavailable' || selection.metric === 'open' ? null : selection.metric
  const sample = metric === null ? null : selection.bucket === undefined ? period : bucket
  const records = new Map(data.tasks.map((task) => [task.id, task]))
  const opened = new Map(data.open.map((task) => [task.id, task]))
  const durationOf = (id: string) => {
    const task = records.get(id)
    return task && metric && metric !== 'completed' && metric !== 'merged'
      ? task[`${metric}Ms`]
      : null
  }
  const ids =
    selection.metric === 'unavailable'
      ? data.unavailableIds
      : selection.metric === 'open'
        ? data.open.map((task) => task.id)
        : sample && metric
          ? idsOf(sample, metric, selection.missing).toSorted(
              (x, y) => (durationOf(y) ?? -1) - (durationOf(x) ?? -1),
            )
          : []
  const days = data.range !== 'today' && bucket !== undefined
  const title =
    selection.metric === 'unavailable'
      ? 'Unavailable completion history'
      : selection.metric === 'open'
        ? 'Open Tasks right now'
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
          metric === 'merged'
            ? `${task.merges} ${task.merges === 1 ? 'pull request' : 'pull requests'} merged`
            : metric === 'created' || metric === 'backlog' || metric === 'intake'
              ? task[`${metric}Ms`] === null
                ? 'Start unavailable'
                : duration(task[`${metric}Ms`])
              : '',
        ]
          .filter(Boolean)
          .join(' · ')
  const rowOf = (id: string) => {
    const task = records.get(id)
    if (selection.metric !== 'open' && task)
      return { displayId: task.displayId, title: task.title, note: describe(task) }
    const open = opened.get(id)
    return open
      ? {
          displayId: open.displayId,
          title: open.title,
          note: `${stageName(open.stage)} · ${openStateName[open.state]}`,
        }
      : null
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
        <button type="button" className={styles.close} aria-label="Close sample" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <p>
        {ids.length} Tasks · As of {timestamp(data.asOf)}
      </p>
      {selection.metric !== 'open' && sample?.from && (
        <p className={styles.caption}>
          {days && bucket && bucket.to !== data.asOf && dayCount(bucket) === 1
            ? 'Midnight to midnight'
            : `${timestamp(sample.from)} – ${timestamp(sample.to)} (end excluded)`}
        </p>
      )}
      <p className={styles.caption}>
        {selection.metric === 'unavailable'
          ? 'Completion period unknown. Excluded from period metrics because no Done timestamp was recorded.'
          : selection.metric === 'open'
            ? 'Tasks that are not Done and not archived, by what each is doing now.'
            : selection.missing
              ? 'Included in the completed count; excluded from this duration’s median.'
              : `Exact Tasks behind this sample. Archived Done Tasks are included.${metric === 'created' || metric === 'backlog' || metric === 'intake' ? ' Slowest first.' : ''}`}
      </p>
      <ul className={styles.taskList}>
        {ids.map((id) => {
          const task = rowOf(id)
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
                <small>{task.note}</small>
              </button>
            </li>
          ) : null
        })}
      </ul>
      {ids.length === 0 && <p>No Tasks in this sample.</p>}
    </dialog>
  )
}

const factoryColor = (factory: Factory | undefined) => {
  const icon = factory?.icon
  return `var(--factory-icon-${icon && 'color' in icon && icon.color ? icon.color : 'blue'}-fg)`
}

function FactoriesMenu({
  factories,
  shown,
  onChoose,
}: {
  factories: readonly Factory[]
  shown: readonly string[] | undefined
  onChoose: (ids: readonly string[] | undefined) => void
}) {
  const showing = (id: string) => shown === undefined || shown.includes(id)
  const toggle = (id: string) => {
    const now = factories.filter((f) => showing(f.id)).map((f) => f.id)
    const next = showing(id) ? now.filter((other) => other !== id) : [...now, id]
    if (next.length > 0) onChoose(next)
  }
  return (
    <MenuButton label="Factories" icon={null} {...(shown && { badge: shown.length })}>
      {() => (
        <>
          <CheckItem
            label="All Factories"
            checked={shown === undefined}
            onChange={() => onChoose(undefined)}
          />
          {factories.map((factory) => (
            <CheckItem
              key={factory.id}
              label={factory.name}
              icon={<FactoryIcon factory={factory} size={16} />}
              checked={showing(factory.id)}
              disabled={shown?.length === 1 && showing(factory.id)}
              onChange={() => toggle(factory.id)}
            />
          ))}
        </>
      )}
    </MenuButton>
  )
}

function FactoryChips({
  factories,
  shown,
  onChoose,
}: {
  factories: readonly Factory[]
  shown: readonly string[]
  onChoose: (ids: readonly string[] | undefined) => void
}) {
  const chosen = factories.filter((f) => shown.includes(f.id))
  return (
    <ul className={styles.factoryChips} aria-label="Factories shown">
      {chosen.map((factory) => (
        <li key={factory.id} className={styles.factoryChip}>
          <FactoryIcon factory={factory} size={14} />
          {factory.name}
          {chosen.length > 1 && (
            <button
              type="button"
              aria-label={`Stop showing ${factory.name}`}
              className={styles.chipRemove}
              onClick={() => onChoose(shown.filter((id) => id !== factory.id))}
            >
              <CloseIcon />
            </button>
          )}
        </li>
      ))}
      <li>
        <button type="button" className={styles.link} onClick={() => onChoose(undefined)}>
          Show all Factories
        </button>
      </li>
    </ul>
  )
}

function change(value: number, previous: number | undefined): string {
  if (previous === undefined) return '–'
  if (previous === 0) return value === 0 ? '0%' : '–'
  const percent = Math.round(((value - previous) / previous) * 100)
  return `${percent > 0 ? '+' : percent < 0 ? '−' : ''}${Math.abs(percent)}%`
}

function ByFactory({
  data,
  factories,
  onOnly,
}: {
  data: DashboardReport
  factories: readonly Factory[]
  onOnly: (id: string) => void
}) {
  const heading = useId()
  const total = data.current.taskIds.length
  const previous = new Map<string, DashboardFactoryPeriod>(
    (data.previous?.byFactory ?? []).map((row) => [row.factoryId, row]),
  )
  const rows = data.current.byFactory.toSorted((a, b) => b.taskIds.length - a.taskIds.length)
  return (
    <section className={`${styles.panel} ${styles.byFactory}`} aria-labelledby={heading}>
      <header className={styles.panelHead}>
        <h2 id={heading}>By Factory</h2>
      </header>
      <table className={styles.factoryTable}>
        <thead>
          <tr>
            <th scope="col">Factory</th>
            <th scope="col">Share of completions</th>
            <th scope="col" className={styles.number}>
              Tasks completed
            </th>
            {data.previous && (
              <th scope="col" className={styles.number}>
                Change
              </th>
            )}
            <th scope="col" className={styles.number}>
              {labels.merged}
            </th>
            <th scope="col" className={styles.number}>
              {labels.created}
            </th>
            <th scope="col" className={styles.number}>
              {labels.backlog}
            </th>
            <th scope="col" className={styles.number}>
              {labels.intake}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const factory = factories.find((f) => f.id === row.factoryId)
            const share = total === 0 ? 0 : row.taskIds.length / total
            return (
              <tr key={row.factoryId}>
                <th scope="row">
                  <button
                    type="button"
                    data-nav-item
                    className={styles.factoryName}
                    title={`Show only ${factory?.name ?? 'this Factory'}`}
                    onClick={() => onOnly(row.factoryId)}
                  >
                    {factory && <FactoryIcon factory={factory} size={16} />}
                    {factory?.name ?? 'Removed Factory'}
                  </button>
                </th>
                <td>
                  <span
                    className={styles.share}
                    style={{ width: `${share * 120}px`, background: factoryColor(factory) }}
                  />
                  <span className={styles.caption}>{Math.round(share * 100)}%</span>
                </td>
                <td className={styles.number}>{row.taskIds.length}</td>
                {data.previous && (
                  <td className={styles.number}>
                    {change(row.taskIds.length, previous.get(row.factoryId)?.taskIds.length)}
                  </td>
                )}
                <td className={styles.number}>{row.merged.count}</td>
                <td className={styles.number}>{duration(row.created.value)}</td>
                <td className={styles.number}>{duration(row.backlog.value)}</td>
                <td className={styles.number}>{duration(row.intake.value)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className={`${styles.caption} ${styles.byFactoryFoot}`}>
        Click a Factory to show only its figures. Medians above are over every Task shown, not an
        average of each Factory’s median.
      </p>
    </section>
  )
}

export function Dashboard({
  factories,
  state,
  onChange,
  onOpenTask,
  banners,
}: {
  factories: readonly Factory[]
  state: DashboardViewState
  onChange: (state: DashboardViewState) => void
  onOpenTask: (id: string) => void
  banners?: ReactNode
}) {
  const factoryIds = shownFactoryIds(state.factoryIds, factories)
  const resource = useDashboard(factoryIds, state.range)
  const data = resource.value
  const panel = state.panel ?? 'overview'
  const shownKey = JSON.stringify(factoryIds ?? null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: shownKey stands for factoryIds
  useEffect(() => {
    rememberDashboard({ range: state.range, panel, ...(factoryIds && { factoryIds }) })
  }, [state.range, panel, shownKey])
  const shown =
    factoryIds === undefined ? factories : factories.filter((f) => factoryIds.includes(f.id))
  const scope =
    factoryIds === undefined
      ? 'All Factories'
      : shown.length <= 2
        ? shown.map((f) => f.name).join(', ')
        : `${shown.length} Factories`
  const kept: DashboardViewState = {
    range: state.range,
    ...(state.panel && { panel: state.panel }),
    ...(factoryIds && { factoryIds }),
  }
  const choose = (ids: readonly string[] | undefined) => {
    const { factoryIds: _, ...rest } = kept
    onChange({ ...rest, ...(ids && { factoryIds: ids }) })
  }
  const panels = ['overview', 'flow', 'stages'] as const
  const choosePanel = (panel: NonNullable<DashboardViewState['panel']>) =>
    onChange({ ...kept, panel })
  const select = (sample: DashboardSelection) => onChange({ ...state, sample })
  return (
    <section className={`${views.pane} ${styles.dashboard}`} aria-label="Dashboard">
      <header className={views.header}>
        <h1 className={views.title}>{scope} › Dashboard</h1>
        <span className={views.headerSpacer} />
        {factories.length > 1 && (
          <FactoriesMenu factories={factories} shown={factoryIds} onChoose={choose} />
        )}
        <Select
          aria-label="Historical period"
          value={state.range}
          onChange={(event) => {
            const range = event.target.value
            if (range === 'today' || range === '7d' || range === '30d' || range === 'all')
              onChange({ ...kept, range })
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
        {factoryIds && factories.length > 1 && (
          <FactoryChips factories={factories} shown={factoryIds} onChoose={choose} />
        )}
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
                  <Completed data={data} factories={factories} select={select} />
                  <Throughput data={data} select={select} />
                  <TaskTime data={data} select={select} />
                </div>
                {shown.length > 1 && (
                  <ByFactory data={data} factories={factories} onOnly={(id) => choose([id])} />
                )}
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
                    onClose={() => onChange(kept)}
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
                select={(flowSample) => onChange({ ...kept, panel, flowSample })}
                onClose={() => onChange(kept)}
                factories={shown}
                onOpenTask={onOpenTask}
              />
            )}
          </section>
        )}
      </div>
    </section>
  )
}
