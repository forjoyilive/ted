import type {
  DashboardBucket,
  DashboardChange,
  DashboardFactoryPeriod,
  DashboardMetric,
  DashboardOpenState,
  DashboardPeriod,
  DashboardRange,
  DashboardReport,
  DashboardTask,
  Factory,
  FactoryLayout,
} from '@ted/protocol'
import { dashboardRange, dashboardRanges } from '@ted/protocol/dashboard'
import {
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { FactoryIcon, useFactoryColors } from '../components/FactoryIcon.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { Select } from '../components/Select.tsx'
import {
  type DashboardSelection,
  type DashboardViewState,
  dashboardPanels,
  pickFactories,
  rangeComparison,
  rangeLabels,
  rememberDashboard,
  shownFactoryIds,
} from '../dashboard.ts'
import { useDashboard, useSettings } from '../data.ts'
import { emptyLayout, groups } from '../factory-layout.ts'
import { useStages } from '../stages.tsx'
import { formatDate } from '../time.ts'
import styles from './Dashboard.module.css'
import { apiEquivalent, Cost, costSample, money } from './DashboardCost.tsx'
import { Stages } from './DashboardStages.tsx'
import listStyles from './TaskList.module.css'
import { CheckItem, FilterIcon, MenuButton } from './TaskList.tsx'
import views from './views.module.css'

const labels: Record<DashboardMetric, string> = {
  completed: 'Tasks completed',
  merged: 'Pull requests merged',
  created: 'Created → Done',
  backlog: 'Waiting in Backlog',
  intake: 'First Intake → Done',
}
const counts = (metric: DashboardMetric | 'waiting') =>
  metric === 'completed' || metric === 'merged'
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
const panelNames = {
  overview: 'Overview',
  stages: 'Stages',
  cost: 'Cost',
} as const
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

function hours(value: number): string {
  return value >= hourMs ? `${Math.round(value / hourMs)}h` : duration(value)
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
type Span = Pick<DashboardBucket, 'from' | 'to'>
const lastDay = (bucket: Span) => new Date(Date.parse(bucket.to) - 1)
const calendarDate = (at: Date) =>
  machineDate(at, { year: 'numeric', month: 'numeric', day: 'numeric' })
const dayCount = (bucket: Span) =>
  Math.round((Date.parse(bucket.to) - Date.parse(bucket.from)) / dayMs)

const rollingRanges: readonly DashboardRange[] = ['7d', '30d', '90d', '12m']

function barsCaption(data: DashboardReport, perPoint: number): string {
  const bars =
    perPoint === 1 ? 'One bar per calendar day' : `Each bar covers ${perPoint} calendar days`
  const last = data.current.buckets.at(-1)
  const lastDays = last ? dayCount(last) : perPoint
  const short =
    perPoint > 1 && last && last.to !== data.asOf && lastDays < perPoint
      ? ` The last bar covers ${lastDays === 1 ? '1 day' : `${lastDays} days`}.`
      : ''
  const end = rollingRanges.includes(data.range)
    ? ' Today is not included.'
    : ' The last bar runs to now.'
  return `${bars}, midnight to midnight.${short}${end}`
}

function dayLabel(bucket: Span, asOf: string): string {
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
  period: DashboardPeriod | DashboardBucket | DashboardFactoryPeriod,
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
  range,
}: {
  change: DashboardChange | undefined
  metric: DashboardMetric | 'waiting'
  all: boolean
  range: DashboardRange
}) {
  const percent = change?.percent
  const good =
    percent !== null && percent !== undefined && (counts(metric) ? percent > 0 : percent < 0)
  return (
    <p className={`${styles.change} ${percent ? (good ? styles.good : styles.bad) : ''}`}>
      {all ? (
        rangeLabels.all
      ) : percent === null || percent === undefined ? (
        change?.absolute === null ? (
          'No duration sample to compare'
        ) : (
          'Percentage unavailable · previous is 0'
        )
      ) : (
        <>
          <strong>
            {percent > 0 ? '+' : ''}
            {Number(percent.toFixed(1))}%
          </strong>
          <span>
            {`${counts(metric) || metric === 'waiting' ? '' : 'elapsed time '}${rangeComparison(range).versus}`}
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
  range,
}: {
  metric: DashboardMetric
  period: 'current' | 'previous'
  bucket: DashboardBucket
  other: DashboardBucket | undefined
  label: (bucket: DashboardBucket) => string
  range: DashboardRange
}): PointTip {
  const { earlier, against } = rangeComparison(range)
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
  const first: PointTip['rows'][number] = { period, label: name, value: shown(value, true) }
  if (metric !== 'completed') first.note = `from ${tasks(idsOf(bucket, metric).length)}`
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
  return factoryIds.flatMap((factoryId) => {
    const count = taskIds.filter((id) => factoryOf.get(id) === factoryId).length
    return count > 0 ? [{ factoryId, count }] : []
  })
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
  const colorOf = useFactoryColors()
  const factoryColor = (f: Factory | undefined) => `var(--factory-icon-${colorOf(f)}-fg)`
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
          range: data.range,
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
        const every = a.length <= 7 ? 1 : Math.ceil(a.length / 6)
        if (i % every !== 0) return []
        return [
          {
            key: i,
            x: centre(i),
            anchor: 'middle' as const,
            text:
              a.length <= 7
                ? machineDate(bucket.from, { weekday: 'short', day: 'numeric' })
                : shortDate(bucket.from),
          },
        ]
      })
  return (
    <div className={styles.chart} ref={frame}>
      <div className={styles.legend}>
        {data.factoryIds.map((id) => {
          const shown = factory(id)
          return (
            <span key={id} className={styles.legendFactory}>
              <i className={styles.swatch} style={{ background: factoryColor(shown) }} />
              {shown && <FactoryIcon factory={shown} size={14} />}
              {shown?.name ?? 'Removed Factory'}
            </span>
          )
        })}
        {data.previous && (
          <span>
            <i className={styles.previousKey} />
            {`${rangeComparison(data.range).earlier} · aligned by ${today ? 'hour' : perPoint === 1 ? 'day' : 'bar'}`}
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
          {factoryRows.map((row) => {
            const shown = factory(row.factoryId)
            return (
              <div key={row.factoryId} className={styles.tooltipRow}>
                <span className={styles.legendFactory}>
                  <i className={styles.swatch} style={{ background: factoryColor(shown) }} />
                  {shown && <FactoryIcon factory={shown} size={14} />}
                  {shown?.name ?? 'Removed Factory'}
                </span>
                <strong>{row.count}</strong>
              </div>
            )
          })}
          {details.change && <div className={styles.tooltipChange}>{details.change}</div>}
        </div>
      )}
      <p className={styles.caption}>
        {today
          ? 'One bar per hour since midnight. Today’s last hour is still running. Yesterday’s line shows the whole day; the figures above count it only to this time.'
          : barsCaption(data, perPoint)}{' '}
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
              {data.previous && <th>{rangeComparison(data.range).earlier}</th>}
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
        <Change change={change} metric={metric} all={previous === null} range={data.range} />
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
          range={data.range}
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
          range={data.range}
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
                range={data.range}
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

function Waiting({
  data,
  select,
}: {
  data: DashboardReport
  select: (sample: DashboardSelection) => void
}) {
  const heading = useId()
  const longestHeading = useId()
  const stages = useStages()
  const stageName = (id: string) => stages.name(id, undefined, data.flow.stageNames)
  const { current, previous, change } = data.waiting
  const top = current.stages[0]?.totalMs ?? 0
  const records = new Map(data.tasks.map((task) => [task.id, task]))
  const whole = () => select({ metric: 'waiting', period: 'current' })
  return (
    <div className={styles.grid}>
      <section className={styles.panel} aria-labelledby={heading}>
        <header className={styles.panelHead}>
          <h2 id={heading}>Waiting on you</h2>
          <span>Completed Tasks</span>
        </header>
        <div className={styles.headline}>
          <div className={styles.waitFigures}>
            <div>
              <button
                type="button"
                data-nav-item
                className={styles.value}
                aria-label={`Waiting on you ${hours(current.totalMs)}`}
                onClick={whole}
              >
                {hours(current.totalMs)}
              </button>
              <Change
                change={change ?? undefined}
                metric="waiting"
                all={previous === null}
                range={data.range}
              />
              <p className={styles.caption}>
                Tasks waited on your answers
                {previous && ` · previous: ${hours(previous.totalMs)}`}
              </p>
            </div>
            <div>
              <button
                type="button"
                data-nav-item
                className={`${styles.value} ${styles.smallValue}`}
                aria-label={`Median answer time ${duration(current.medianMs)}`}
                onClick={whole}
              >
                {duration(current.medianMs)}
              </button>
              <p className={styles.caption}>
                median answer time · {current.waits.length}{' '}
                {current.waits.length === 1 ? 'request' : 'requests'}
              </p>
            </div>
          </div>
          {current.stages.length === 0 ? (
            <p className={styles.empty}>No completed Task waited on you in this period.</p>
          ) : (
            <ul className={styles.waitStages}>
              {current.stages.map((stage) => (
                <li key={stage.stage}>
                  <button
                    type="button"
                    data-nav-item
                    className={styles.waitRow}
                    aria-label={`Waiting on you in ${stageName(stage.stage)} ${hours(stage.totalMs)}`}
                    onClick={() =>
                      select({ metric: 'waiting', period: 'current', stage: stage.stage })
                    }
                  >
                    <span>
                      {stageName(stage.stage)}
                      <small>{stage.kinds.join(', ')}</small>
                    </span>
                    <span className={styles.waitTrack}>
                      <i style={{ width: `${top ? (stage.totalMs / top) * 100 : 0}%` }} />
                    </span>
                    <strong>{hours(stage.totalMs)}</strong>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section className={styles.panel} aria-labelledby={longestHeading}>
        <header className={styles.panelHead}>
          <h2 id={longestHeading}>Longest waits on you</h2>
        </header>
        <div className={styles.headline}>
          {current.waits.length === 0 ? (
            <p className={styles.empty}>No requests waited in this period.</p>
          ) : (
            <ul className={styles.waitList}>
              {current.waits.slice(0, 5).map((wait) => (
                <li key={wait.requestId}>
                  <button
                    type="button"
                    data-nav-item
                    className={styles.waitRow}
                    onClick={() =>
                      select({ metric: 'waiting', period: 'current', requestId: wait.requestId })
                    }
                  >
                    <span>
                      <b>{records.get(wait.taskId)?.displayId ?? 'Task'}</b> {wait.kind}
                    </span>
                    <strong>{duration(wait.waitedMs)}</strong>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.caption}>Snoozed time counts as waiting.</p>
        </div>
      </section>
    </div>
  )
}

function spanLabel(data: DashboardReport, bucket: Span | undefined): string {
  if (!bucket) return ''
  return data.range === 'today'
    ? `${clock(Date.parse(bucket.from))} – ${clock(Date.parse(bucket.to))}`
    : dayLabel(bucket, data.asOf)
}

function Sample({
  data,
  selection,
  onClose,
  onOpenTask,
  factories,
}: {
  data: DashboardReport
  selection: DashboardSelection
  onClose: () => void
  onOpenTask: (id: string) => void
  factories: readonly Factory[]
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const equivalent = apiEquivalent(useSettings())
  const stages = useStages()
  const stageName = (id: string) => stages.name(id, undefined, data.flow.stageNames)
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
    selection.metric === 'unavailable' ||
    selection.metric === 'open' ||
    selection.metric === 'waiting' ||
    selection.metric === 'cost'
      ? null
      : selection.metric
  const spent =
    selection.metric === 'cost'
      ? costSample(
          data.cost,
          selection,
          (index) =>
            spanLabel(
              data,
              (selection.period === 'previous' ? data.cost.previous : data.cost.current)?.buckets[
                index
              ],
            ),
          (id) =>
            id === null
              ? 'Not in a Factory'
              : (factories.find((f) => f.id === id)?.name ?? 'Removed Factory'),
          equivalent,
        )
      : null
  const waited =
    selection.metric !== 'waiting'
      ? null
      : selection.period === 'previous'
        ? data.waiting.previous
        : data.waiting.current
  const request =
    selection.requestId === undefined
      ? undefined
      : waited?.waits.find((w) => w.requestId === selection.requestId)
  const waitedHere =
    selection.factoryId === undefined
      ? null
      : new Set(waited?.byFactory.find((row) => row.factoryId === selection.factoryId)?.taskIds)
  const waitSamples = (
    !waited
      ? []
      : request
        ? [{ taskId: request.taskId, waitedMs: request.waitedMs }]
        : selection.stage !== undefined
          ? (waited.stages.find((s) => s.stage === selection.stage)?.samples ?? [])
          : waited.samples
  ).filter((s) => !waitedHere || waitedHere.has(s.taskId))
  const waitNote = (id: string) => {
    const ms = waitSamples.find((s) => s.taskId === id)?.waitedMs ?? 0
    const kinds = request
      ? [request.kind]
      : [
          ...new Set(
            (waited?.waits ?? [])
              .filter(
                (w) =>
                  w.taskId === id && (selection.stage === undefined || w.stage === selection.stage),
              )
              .map((w) => w.kind),
          ),
        ]
    return [`Waited ${duration(ms)}`, kinds.join(', ')].filter(Boolean).join(' · ')
  }
  const sample = metric === null ? null : selection.bucket === undefined ? period : bucket
  const source =
    selection.factoryId === undefined
      ? sample
      : period?.byFactory.find((row) => row.factoryId === selection.factoryId)
  const factoryName =
    selection.factoryId === undefined
      ? null
      : (factories.find((f) => f.id === selection.factoryId)?.name ?? 'Removed Factory')
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
        : waited
          ? waitSamples.map((s) => s.taskId)
          : source && metric
            ? idsOf(source, metric, selection.missing).toSorted(
                (x, y) => (durationOf(y) ?? -1) - (durationOf(x) ?? -1),
              )
            : []
  const days = data.range !== 'today' && bucket !== undefined
  const title = spent
    ? spent.title
    : selection.metric === 'unavailable' || selection.metric === 'cost'
      ? 'Unavailable completion history'
      : selection.metric === 'open'
        ? 'Open Tasks right now'
        : selection.metric === 'waiting'
          ? `Waiting on you · ${
              request
                ? `${request.kind}${request.stage ? ` in ${stageName(request.stage)}` : ''}`
                : selection.stage !== undefined
                  ? `In ${stageName(selection.stage)}`
                  : selection.period === 'current'
                    ? 'Selected period'
                    : 'Previous period'
            }${factoryName ? ` · ${factoryName}` : ''}`
          : `${labels[selection.metric]} · ${
              selection.missing
                ? 'Missing starts'
                : days
                  ? `${selection.period === 'previous' ? 'Previous · ' : ''}${dayLabel(bucket, data.asOf)}`
                  : selection.period === 'current'
                    ? 'Selected period'
                    : 'Previous period'
            }${factoryName ? ` · ${factoryName}` : ''}`
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
      return {
        displayId: task.displayId,
        title: task.title,
        note: waited ? waitNote(id) : describe(task),
      }
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
        {spent ? spent.items.filter((item) => item.taskId).length : ids.length} Tasks · As of{' '}
        {timestamp(data.asOf)}
      </p>
      {selection.metric !== 'open' && sample?.from && (
        <p className={styles.caption}>
          {days && bucket && bucket.to !== data.asOf && dayCount(bucket) === 1
            ? 'Midnight to midnight'
            : `${timestamp(sample.from)} – ${timestamp(sample.to)} (end excluded)`}
        </p>
      )}
      {spent && (
        <>
          <p className={styles.caption}>{spent.caption}</p>
          <ul className={styles.taskList}>
            {spent.items.map((item) => (
              <li key={item.key}>
                {item.taskId ? (
                  <button
                    type="button"
                    data-nav-item
                    className={styles.task}
                    onClick={() => item.taskId && onOpenTask(item.taskId)}
                  >
                    <span>
                      {item.displayId} &nbsp; {item.label}
                    </span>
                    <small>{item.note}</small>
                  </button>
                ) : (
                  <div className={styles.task}>
                    <span>{item.label}</span>
                    <small>{item.note}</small>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {spent.items.length === 0 && <p>No recorded spend in this sample.</p>}
        </>
      )}
      {!spent && (
        <p className={styles.caption}>
          {selection.metric === 'unavailable'
            ? 'Completion period unknown. Excluded from period metrics because no Done timestamp was recorded.'
            : selection.metric === 'open'
              ? 'Tasks that are not Done and not archived, by what each is doing now.'
              : waited
                ? 'Completed Tasks of this period and how long each waited on your answers, longest first. Snoozed time counts as waiting.'
                : selection.missing
                  ? 'Included in the completed count; excluded from this duration’s median.'
                  : `Exact Tasks behind this sample. Archived Done Tasks are included.${metric === 'created' || metric === 'backlog' || metric === 'intake' ? ' Slowest first.' : ''}`}
        </p>
      )}
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
      {ids.length === 0 && !spent && <p>No Tasks in this sample.</p>}
    </dialog>
  )
}

function FactoriesMenu({
  factories,
  layout,
  shown,
  onChoose,
}: {
  factories: readonly Factory[]
  layout: FactoryLayout
  shown: readonly string[] | undefined
  onChoose: (ids: readonly string[] | undefined) => void
}) {
  const known = (ids: readonly string[]) =>
    factories.filter((f) => ids.includes(f.id)).map((f) => f.id)
  const withFactories = groups(layout)
    .map((group) => ({ group, ids: known(group.factoryIds) }))
    .filter(({ ids }) => ids.length > 0)
  const chosen = (ids: readonly string[]) =>
    shown !== undefined && ids.every((id) => shown.includes(id))
  const pick = (ids: readonly string[]) => onChoose(pickFactories(shown, ids, factories))
  return (
    <MenuButton label="Filter" icon={<FilterIcon />} {...(shown && { badge: shown.length })}>
      {() => (
        <>
          <CheckItem
            label="All Factories"
            checked={shown === undefined}
            onChange={() => onChoose(undefined)}
          />
          <div className={listStyles.menuDivider} />
          {withFactories.map(({ group, ids }) => (
            <CheckItem
              key={`group:${group.id}`}
              label={group.name}
              checked={chosen(ids)}
              onChange={() => pick(ids)}
            />
          ))}
          {withFactories.length > 0 && <div className={listStyles.menuDivider} />}
          {factories.map((factory) => (
            <CheckItem
              key={factory.id}
              label={factory.name}
              icon={<FactoryIcon factory={factory} size={16} />}
              checked={chosen([factory.id])}
              onChange={() => pick([factory.id])}
            />
          ))}
          {shown !== undefined && (
            <>
              <div className={listStyles.menuDivider} />
              <ActionButton
                type="button"
                role="menuitem"
                className={listStyles.menuItem}
                onClick={() => onChoose(undefined)}
              >
                <span className={listStyles.menuLabel}>Clear filter</span>
              </ActionButton>
            </>
          )}
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
  select,
}: {
  data: DashboardReport
  factories: readonly Factory[]
  onOnly: (id: string) => void
  select: (sample: DashboardSelection) => void
}) {
  const heading = useId()
  const colorOf = useFactoryColors()
  const total = data.current.taskIds.length
  const previous = new Map<string, DashboardFactoryPeriod>(
    (data.previous?.byFactory ?? []).map((row) => [row.factoryId, row]),
  )
  const rows = data.current.byFactory.toSorted((a, b) => b.taskIds.length - a.taskIds.length)
  const waits = new Map(data.waiting.current.byFactory.map((row) => [row.factoryId, row]))
  const perPr = new Map(
    data.cost.current.byFactory.map((row) => [row.factoryId, row.perPullRequest.median]),
  )
  const cell = (text: string, sample: DashboardSelection | null) =>
    sample ? (
      <button
        type="button"
        data-nav-item
        className={`${styles.link} ${styles.cellLink}`}
        onClick={() => select(sample)}
      >
        {text}
      </button>
    ) : (
      text
    )
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
            <th scope="col" className={styles.number}>
              Waiting on you
            </th>
            <th scope="col" className={styles.number}>
              Cost per pull request
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const factory = factories.find((f) => f.id === row.factoryId)
            const share = total === 0 ? 0 : row.taskIds.length / total
            const before = previous.get(row.factoryId)
            const waited = waits.get(row.factoryId)
            const wait = waited?.totalMs ?? 0
            const cost = perPr.get(row.factoryId) ?? null
            const of = (
              metric: DashboardMetric,
              taskIds: readonly string[],
            ): DashboardSelection | null =>
              taskIds.length === 0 ? null : { metric, period: 'current', factoryId: row.factoryId }
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
                    style={{
                      width: `${share * 120}px`,
                      background: `var(--factory-icon-${colorOf(factory)}-fg)`,
                    }}
                  />
                  <span className={styles.caption}>
                    {cell(`${Math.round(share * 100)}%`, of('completed', row.taskIds))}
                  </span>
                </td>
                <td className={styles.number}>
                  {cell(String(row.taskIds.length), of('completed', row.taskIds))}
                </td>
                {data.previous && (
                  <td className={styles.number}>
                    {cell(
                      change(row.taskIds.length, before?.taskIds.length),
                      before && before.taskIds.length > 0
                        ? { metric: 'completed', period: 'previous', factoryId: row.factoryId }
                        : null,
                    )}
                  </td>
                )}
                <td className={styles.number}>
                  {cell(String(row.merged.count), of('merged', row.merged.taskIds))}
                </td>
                <td className={styles.number}>
                  {cell(duration(row.created.value), of('created', row.created.taskIds))}
                </td>
                <td className={styles.number}>
                  {cell(duration(row.backlog.value), of('backlog', row.backlog.taskIds))}
                </td>
                <td className={styles.number}>
                  {cell(duration(row.intake.value), of('intake', row.intake.taskIds))}
                </td>
                <td className={styles.number}>
                  {cell(
                    hours(wait),
                    waited?.taskIds.length
                      ? { metric: 'waiting', period: 'current', factoryId: row.factoryId }
                      : null,
                  )}
                </td>
                <td className={styles.number}>
                  {cell(
                    money(cost),
                    cost === null
                      ? null
                      : {
                          metric: 'cost',
                          period: 'current',
                          cost: { of: 'per-pull-request', factoryId: row.factoryId },
                        },
                  )}
                </td>
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
  layout = emptyLayout,
}: {
  factories: readonly Factory[]
  layout?: FactoryLayout
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
  const panels = dashboardPanels
  const choosePanel = (panel: NonNullable<DashboardViewState['panel']>) =>
    onChange({ ...kept, panel })
  const select = (sample: DashboardSelection) => onChange({ ...state, sample })
  return (
    <section className={`${views.pane} ${styles.dashboard}`} aria-label="Dashboard">
      <header className={views.header}>
        <h1 className={views.title}>{scope} › Dashboard</h1>
        <span className={views.headerSpacer} />
        {factories.length > 1 && (
          <FactoriesMenu
            factories={factories}
            layout={layout}
            shown={factoryIds}
            onChoose={choose}
          />
        )}
        <Select
          aria-label="Historical period"
          value={state.range}
          onChange={(event) => {
            const range = dashboardRange(event.target.value)
            if (range) onChange({ ...kept, range })
          }}
        >
          {dashboardRanges.map((range) => (
            <option key={range} value={range}>
              {rangeLabels[range]}
            </option>
          ))}
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
              {panelNames[name]}
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
                <Waiting data={data} select={select} />
                {shown.length > 1 && (
                  <ByFactory
                    data={data}
                    factories={factories}
                    onOnly={(id) => choose([id])}
                    select={select}
                  />
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
                    factories={factories}
                  />
                )}
              </>
            ) : panel === 'cost' ? (
              <>
                <Cost
                  data={data.cost.current}
                  previousData={data.cost.previous}
                  change={data.cost.change}
                  tasks={data.cost.tasks}
                  factories={factories}
                  range={data.range}
                  all={data.previous === null}
                  bounds={`${
                    data.cost.current.from
                      ? `${timestamp(data.cost.current.from)} – ${timestamp(data.cost.current.to)} (end excluded) · `
                      : `${rangeLabels.all} · `
                  }As of ${timestamp(data.asOf)}`}
                  label={(index) => spanLabel(data, data.cost.current.buckets[index])}
                  select={select}
                />
                {state.sample && (
                  <Sample
                    data={data}
                    selection={state.sample}
                    onClose={() => onChange(kept)}
                    onOpenTask={onOpenTask}
                    factories={factories}
                  />
                )}
              </>
            ) : (
              <Stages
                data={data.flow}
                range={data.range}
                asOf={data.asOf}
                selection={state.stageSample}
                select={(stageSample) => onChange({ ...kept, panel, stageSample })}
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
