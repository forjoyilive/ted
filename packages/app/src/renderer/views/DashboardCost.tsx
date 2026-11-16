import type {
  AgentKind,
  CostKind,
  CostPeriod,
  CostShare,
  DashboardChange,
  DashboardCost,
  DashboardRange,
  Factory,
  MachineSettings,
} from '@ted/protocol'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { FactoryIcon } from '../components/FactoryIcon.tsx'
import {
  type CostSelection,
  type DashboardSelection,
  rangeComparison,
  rangeLabels,
} from '../dashboard.ts'
import { useSettings } from '../data.ts'
import { agentLabels } from '../task-fields.ts'
import { formatDate } from '../time.ts'
import styles from './Dashboard.module.css'

export const costKindNames: Record<CostKind, string> = {
  lead: 'Task Leads',
  reviewer: 'Reviewers',
  'sub-agent': 'Other Sub-Agents',
  coordinator: 'Coordinator',
  automation: 'Automations',
  planning: 'Planning chats',
  other: 'Other Runs',
}

const kindOrder: readonly CostKind[] = [
  'lead',
  'reviewer',
  'sub-agent',
  'coordinator',
  'automation',
  'planning',
  'other',
]

const kindColors: Record<CostKind, string> = {
  lead: 'var(--chart-sapphire)',
  reviewer: 'var(--chart-amethyst)',
  'sub-agent': 'var(--chart-aquamarine)',
  coordinator: 'var(--chart-emerald)',
  automation: 'var(--chart-tourmaline)',
  planning: 'var(--chart-slate)',
  other: 'var(--chart-other)',
}

const palette = [
  'var(--chart-sapphire)',
  'var(--chart-emerald)',
  'var(--chart-amethyst)',
  'var(--chart-ruby)',
  'var(--chart-teal)',
  'var(--chart-tourmaline)',
  'var(--chart-aquamarine)',
  'var(--chart-slate)',
]

const taskWork = new Set<string>(['lead', 'reviewer', 'sub-agent'])

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function money(value: number | null): string {
  if (value === null) return '–'
  if (value > 0 && value < 0.005) return '<$0.01'
  return currency.format(value)
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const tokens = (value: number) => compact.format(value)
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

export function modelName(share: Pick<CostShare, 'agent' | 'model' | 'key'>): string {
  if (share.agent === undefined) return share.key
  const agent = agentLabels[share.agent as AgentKind] ?? share.agent
  return `${agent} · ${share.model || 'Default model'}`
}

function percent(change: DashboardChange | undefined): string | null {
  const value = change?.percent
  if (value === null || value === undefined) return null
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}%`
}

function CostChange({
  change,
  what,
  previous,
  range,
}: {
  change: DashboardChange | undefined
  what: string
  previous: number | null | undefined
  range: DashboardRange
}) {
  const shown = percent(change)
  const value = change?.percent ?? 0
  return (
    <p className={`${styles.change} ${value ? (value < 0 ? styles.good : styles.bad) : ''}`}>
      {previous === undefined ? (
        rangeLabels.all
      ) : shown === null ? (
        `Nothing to compare · previous: ${money(previous)}`
      ) : (
        <>
          <strong>{shown}</strong>
          <span>
            {what} {rangeComparison(range).versus} ({money(previous)})
          </span>
        </>
      )}
    </p>
  )
}

export function moneyScale(maximum: number): number[] {
  if (maximum <= 0) return [0, 1]
  const steps = [0.01, 0.02, 0.05]
  let step = 0.01
  for (let magnitude = 1; ; magnitude *= 10) {
    const found = steps.map((s) => s * magnitude).find((s) => maximum / s <= 4)
    if (found !== undefined) {
      step = found
      break
    }
  }
  const top = Math.ceil(maximum / step - 1e-9) * step
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Number((i * step).toFixed(2)))
}

type Series = { key: string; name: string; color: string; total: number }

function seriesOf(period: CostPeriod, by: 'kind' | 'model'): Series[] {
  if (by === 'kind')
    return kindOrder.flatMap((kind) => {
      const share = period.kinds.find((k) => k.key === kind)
      return share && share.cost > 0
        ? [{ key: kind, name: costKindNames[kind], color: kindColors[kind], total: share.cost }]
        : []
    })
  return period.models
    .filter((share) => share.cost > 0)
    .map((share, index) => ({
      key: share.key,
      name: modelName(share),
      color: palette[index] ?? 'var(--chart-other)',
      total: share.cost,
    }))
}

export function apiEquivalent(settings: MachineSettings | undefined): boolean {
  return !settings || Object.values(settings.billing).includes('subscription')
}

function SpendChart({
  period,
  today,
  equivalent,
  label,
  select,
}: {
  period: CostPeriod
  today: boolean
  equivalent: boolean
  label: (index: number) => string
  select: (sample: DashboardSelection) => void
}) {
  const [by, setBy] = useState<'kind' | 'model'>('kind')
  const [hovered, setHovered] = useState<{ index: number; point: HTMLElement } | null>(null)
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
  const series = seriesOf(period, by)
  const buckets = period.buckets
  const parts = (index: number) => {
    const bucket = buckets[index]
    if (!bucket) return []
    const list = by === 'kind' ? bucket.kinds : bucket.models
    return series.flatMap((s) => {
      const cost = list.find((share) => share.key === s.key)?.cost ?? 0
      return cost > 0 ? [{ ...s, cost }] : []
    })
  }
  const pick = (index: number, key?: string) =>
    select({
      metric: 'cost',
      period: 'current',
      bucket: index,
      cost: {
        of: 'spend',
        ...(key !== undefined && (by === 'kind' ? { kind: key as CostKind } : { model: key })),
      },
    })
  const scale = moneyScale(Math.max(0, ...buckets.map((b) => b.cost)))
  const maximum = scale.at(-1) ?? 1
  const plot = { left: 52, right: 990, top: 14, bottom: 196 }
  const slots = Math.max(1, buckets.length)
  const width = (plot.right - plot.left) / slots
  const edge = (i: number) => plot.left + i * width
  const centre = (i: number) => edge(i + 0.5)
  const y = (value: number) => plot.bottom - (value / maximum) * (plot.bottom - plot.top)
  const bar = Math.max(2, Math.min(width * 0.7, 40))
  const every = today ? 6 : buckets.length <= 7 ? 1 : Math.ceil(buckets.length / 6)
  const tick = (from: string) =>
    today
      ? formatDate(from, { hour: '2-digit', minute: '2-digit' })
      : formatDate(from, { month: 'short', day: 'numeric' })
  const leave = (point: HTMLElement) =>
    setHovered((shown) => (shown?.point === point ? null : shown))
  const shownParts = hovered ? parts(hovered.index) : []
  const shownBucket = hovered ? buckets[hovered.index] : undefined
  return (
    <div className={styles.chart} ref={frame}>
      <div className={styles.stageControls}>
        <div className={styles.legend}>
          {series.map((s) => (
            <span key={s.key}>
              <i className={styles.swatch} style={{ background: s.color }} />
              {s.name} {money(s.total)}
            </span>
          ))}
        </div>
        <fieldset className={styles.segToggle} aria-label="Split spend">
          <button type="button" aria-pressed={by === 'kind'} onClick={() => setBy('kind')}>
            By kind of work
          </button>
          <button type="button" aria-pressed={by === 'model'} onClick={() => setBy('model')}>
            By agent and model
          </button>
        </fieldset>
      </div>
      {buckets.length === 0 || period.cost === 0 ? (
        <p className={styles.chartEmpty}>No recorded spend to plot.</p>
      ) : (
        <svg viewBox="0 0 1000 222" aria-label={`Spend by ${today ? 'hour' : 'day'}`}>
          <title>{equivalent ? 'API-equivalent cost' : 'Cost'} per bar. Empty bars are zero.</title>
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
                {money(value)}
              </text>
            </g>
          ))}
          {buckets.map((bucket, index) => (
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
                aria-label={`${label(index)} · ${money(bucket.cost)}`}
                aria-describedby={hovered?.index === index ? tipId : undefined}
                onMouseEnter={(event) => setHovered({ index, point: event.currentTarget })}
                onFocus={(event) => setHovered({ index, point: event.currentTarget })}
                onMouseLeave={(event) => leave(event.currentTarget)}
                onBlur={(event) => leave(event.currentTarget)}
                onClick={() => pick(index)}
              />
            </foreignObject>
          ))}
          {buckets.map((bucket, index) => {
            let base = 0
            return parts(index).map((part) => {
              const from = base
              base += part.cost
              return (
                <rect
                  key={`${bucket.from}-${part.key}`}
                  className={styles.bar}
                  x={centre(index) - bar / 2}
                  y={y(base)}
                  width={bar}
                  height={y(from) - y(base)}
                  style={{ fill: part.color }}
                />
              )
            })
          })}
          {buckets.map((bucket, index) =>
            index % every === 0 ? (
              <text
                key={`tick-${bucket.from}`}
                x={centre(index)}
                y={plot.bottom + 20}
                textAnchor="middle"
              >
                {tick(bucket.from)}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {hovered && shownBucket && (
        <div className={styles.tooltip} role="tooltip" id={tipId} ref={tip}>
          <div className={styles.tooltipHeading}>{label(hovered.index)}</div>
          <div className={styles.tooltipRow}>
            <span>Spend</span>
            <strong>{money(shownBucket.cost)}</strong>
          </div>
          {shownParts.map((part) => (
            <div key={part.key} className={styles.tooltipRow}>
              <span>
                <i className={styles.swatch} style={{ background: part.color }} />
                {part.name}
              </span>
              <strong>{money(part.cost)}</strong>
            </div>
          ))}
        </div>
      )}
      <details className={styles.dataTable}>
        <summary>Graph data</summary>
        <table>
          <caption>
            {equivalent ? 'API-equivalent cost' : 'Cost'} per {today ? 'hour' : 'bar'}
          </caption>
          <thead>
            <tr>
              <th>{today ? 'Hour' : 'Day'}</th>
              <th>Spend</th>
              {series.map((s) => (
                <th key={s.key}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket, index) => (
              <tr key={bucket.from}>
                <th scope="row">{label(index)}</th>
                <td>
                  <button
                    type="button"
                    data-nav-item
                    className={styles.link}
                    onClick={() => pick(index)}
                  >
                    {money(bucket.cost)}
                  </button>
                </td>
                {series.map((s) => {
                  const cost =
                    (by === 'kind' ? bucket.kinds : bucket.models).find((x) => x.key === s.key)
                      ?.cost ?? 0
                  return (
                    <td key={s.key}>
                      {cost > 0 ? (
                        <button
                          type="button"
                          className={styles.link}
                          onClick={() => pick(index, s.key)}
                        >
                          {money(cost)}
                        </button>
                      ) : (
                        money(0)
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

function RangeBar({ period, onClick }: { period: CostPeriod; onClick: () => void }) {
  const { median, p25, p75, samples } = period.perPullRequest
  if (median === null || p25 === null || p75 === null) return null
  const top = Math.max(p75, ...samples.map((s) => s.perPullRequest)) || 1
  const x = (value: number) => (value / top) * 300
  return (
    <button
      type="button"
      className={styles.rangeBar}
      aria-label={`Middle half ${money(p25)} – ${money(p75)}, median ${money(median)}`}
      onClick={onClick}
    >
      <svg viewBox="0 0 300 24" aria-hidden="true">
        <line className={styles.rangeTrack} x1="0" x2="300" y1="12" y2="12" />
        <rect
          className={styles.rangeBox}
          x={x(p25)}
          y="6"
          width={Math.max(2, x(p75) - x(p25))}
          height="12"
          rx="2"
        />
        <line className={styles.rangeMedian} x1={x(median)} x2={x(median)} y1="3" y2="21" />
      </svg>
    </button>
  )
}

export function Cost({
  data,
  previousData,
  change,
  tasks,
  factories,
  range,
  all,
  bounds,
  label,
  select,
}: {
  data: CostPeriod
  previousData: CostPeriod | null
  change: DashboardCost['change']
  tasks: DashboardCost['tasks']
  factories: readonly Factory[]
  range: DashboardRange
  all: boolean
  bounds: string
  label: (index: number) => string
  select: (sample: DashboardSelection) => void
}) {
  const heading = useId()
  const equivalent = apiEquivalent(useSettings())
  const perPr = data.perPullRequest
  const records = new Map(tasks.map((task) => [task.id, task]))
  const spend = (cost: CostSelection) => select({ metric: 'cost', period: 'current', cost })
  const kinds = kindOrder.flatMap((kind) => {
    const share = data.kinds.find((k) => k.key === kind)
    return share && share.cost > 0 ? [{ kind, cost: share.cost }] : []
  })
  const taskShare =
    data.cost > 0
      ? Math.round(
          (kinds.filter((k) => taskWork.has(k.kind)).reduce((sum, k) => sum + k.cost, 0) /
            data.cost) *
            100,
        )
      : null
  const previousFactories = new Map(
    (previousData?.byFactory ?? []).map((row) => [row.factoryId, row]),
  )
  const factoryRows = data.byFactory.toSorted((a, b) =>
    a.factoryId === null ? 1 : b.factoryId === null ? -1 : b.cost - a.cost,
  )
  return (
    <section className={styles.flow} aria-labelledby={heading}>
      <header className={styles.flowHead}>
        <div>
          <h2 id={heading}>{equivalent ? 'API-equivalent cost' : 'Cost'}</h2>
          <p className={styles.lead}>
            {equivalent
              ? 'API-equivalent cost: what these Runs would have cost on an API key, whatever your billing. Runs still going aren’t counted yet.'
              : 'What these Runs cost on your API keys. Runs still going aren’t counted yet.'}
          </p>
        </div>
      </header>
      <p className={styles.caption}>{bounds}</p>
      {data.unpricedRuns > 0 && (
        <p className={styles.notice}>
          {plural(data.unpricedRuns, 'Run')} in this period{' '}
          {data.unpricedRuns === 1 ? 'has' : 'have'} no known price. Their tokens count, but their
          cost doesn’t.
        </p>
      )}
      <div className={`${styles.grid} ${styles.costCards}`}>
        <section className={styles.panel} aria-label="Cost per merged pull request">
          <header className={styles.panelHead}>
            <h2>Cost per merged pull request</h2>
            <span>Median</span>
          </header>
          <div className={styles.headline}>
            <button
              type="button"
              data-nav-item
              className={styles.value}
              aria-label={`Cost per merged pull request ${money(perPr.median)}`}
              onClick={() => spend({ of: 'per-pull-request' })}
            >
              {money(perPr.median)}
            </button>
            <CostChange
              change={change?.perPullRequest}
              what="median"
              previous={all ? undefined : (previousData?.perPullRequest.median ?? null)}
              range={range}
            />
            <RangeBar period={data} onClick={() => spend({ of: 'per-pull-request' })} />
            <p className={styles.caption}>
              {perPr.p25 !== null && perPr.p75 !== null
                ? `Middle half ${money(perPr.p25)} – ${money(perPr.p75)} · `
                : ''}
              {plural(perPr.pullRequests, 'pull request')}. Includes the Task Lead, reviewer and
              other sub-agents of each Task completed in this period, over the Task’s whole life.
            </p>
          </div>
        </section>
        <section className={styles.panel} aria-label="Spend in this period">
          <header className={styles.panelHead}>
            <h2>Spend in this period</h2>
          </header>
          <div className={styles.headline}>
            <button
              type="button"
              data-nav-item
              className={styles.value}
              aria-label={`Spend in this period ${money(data.cost)}`}
              onClick={() => spend({ of: 'spend' })}
            >
              {money(data.cost)}
            </button>
            <CostChange
              change={change?.spend}
              what="spend"
              previous={all ? undefined : (previousData?.cost ?? null)}
              range={range}
            />
            {kinds.length > 0 && (
              <div className={styles.split}>
                {kinds.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    style={{ flexGrow: k.cost / data.cost, background: kindColors[k.kind] }}
                    aria-label={`${costKindNames[k.kind]} ${money(k.cost)}`}
                    title={`${costKindNames[k.kind]}: ${money(k.cost)}`}
                    onClick={() => spend({ of: 'spend', kind: k.kind })}
                  />
                ))}
              </div>
            )}
            {taskShare !== null && (
              <p className={styles.caption}>
                {taskShare}% went to Task work; the rest to the Coordinator, Automations, planning
                chats and other Runs.
              </p>
            )}
          </div>
        </section>
        <section className={styles.panel} aria-label="Tokens">
          <header className={styles.panelHead}>
            <h2>Tokens</h2>
          </header>
          <div className={styles.headline}>
            <button
              type="button"
              data-nav-item
              className={`${styles.value} ${styles.smallValue}`}
              aria-label={`${tokens(data.input)} tokens in, ${tokens(data.output)} out`}
              onClick={() => spend({ of: 'spend' })}
            >
              {tokens(data.input)} in · {tokens(data.output)} out
            </button>
            <p className={styles.change}>across {plural(data.runs, 'Run')}</p>
          </div>
        </section>
      </div>
      <section className={`${styles.panel} ${styles.costWide}`} aria-label="Spend over time">
        <header className={styles.panelHead}>
          <h2>Spend over time</h2>
        </header>
        <SpendChart
          period={data}
          today={range === 'today'}
          equivalent={equivalent}
          label={label}
          select={select}
        />
      </section>
      <div className={styles.grid}>
        <section className={styles.panel} aria-label="Most expensive pull requests">
          <header className={styles.panelHead}>
            <h2>Most expensive pull requests</h2>
          </header>
          {perPr.samples.length === 0 ? (
            <p className={`${styles.empty} ${styles.costPad}`}>
              No Task with a merged pull request and recorded cost was completed in this period.
            </p>
          ) : (
            <table className={styles.factoryTable}>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col" className={styles.number}>
                    Runs
                  </th>
                  <th scope="col" className={styles.number}>
                    Send-backs
                  </th>
                  <th scope="col" className={styles.number}>
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {perPr.samples.slice(0, 5).map((sample) => {
                  const task = records.get(sample.taskId)
                  return (
                    <tr key={sample.taskId}>
                      <th scope="row">
                        <button
                          type="button"
                          data-nav-item
                          className={styles.factoryName}
                          onClick={() => spend({ of: 'per-pull-request', taskId: sample.taskId })}
                        >
                          <b>{task?.displayId ?? 'Task'}</b> {task?.title}
                        </button>
                        {sample.pullRequests > 1 && (
                          <span className={styles.caption}>
                            {' '}
                            · {money(sample.cost)} over {sample.pullRequests} pull requests
                          </span>
                        )}
                      </th>
                      <td className={styles.number}>{task?.runs ?? '–'}</td>
                      <td className={styles.number}>{task?.sendBacks ?? '–'}</td>
                      <td className={styles.number}>{money(sample.perPullRequest)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <p className={`${styles.caption} ${styles.byFactoryFoot}`}>
            Cost is per merged pull request: a Task that merged two pull requests counts half its
            cost for each.
          </p>
        </section>
        <section className={styles.panel} aria-label="Spend by Factory">
          <header className={styles.panelHead}>
            <h2>By Factory</h2>
          </header>
          <table className={styles.factoryTable}>
            <thead>
              <tr>
                <th scope="col">Factory</th>
                <th scope="col" className={styles.number}>
                  Spend
                </th>
                <th scope="col" className={styles.number}>
                  Per pull request
                </th>
                {!all && (
                  <th scope="col" className={styles.number}>
                    Change
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {factoryRows.map((row) => {
                const factory = factories.find((f) => f.id === row.factoryId)
                const factoryId = row.factoryId
                const before = previousFactories.get(row.factoryId)
                const shift =
                  before && before.cost > 0
                    ? percent({
                        absolute: null,
                        percent: ((row.cost - before.cost) / before.cost) * 100,
                      })
                    : null
                return (
                  <tr key={row.factoryId ?? 'none'}>
                    <th scope="row">
                      <button
                        type="button"
                        data-nav-item
                        className={styles.factoryName}
                        onClick={() => spend({ of: 'spend', factoryId: row.factoryId })}
                      >
                        {factory && <FactoryIcon factory={factory} size={16} />}
                        {row.factoryId === null
                          ? 'Not in a Factory'
                          : (factory?.name ?? 'Removed Factory')}
                      </button>
                      {row.factoryId === null && (
                        <span className={styles.caption}>
                          <br />
                          Runs with no Task, Coordinator, Automation or planning chat, such as one
                          of a deleted Task
                        </span>
                      )}
                    </th>
                    <td className={styles.number}>
                      {row.runs > 0 ? (
                        <button
                          type="button"
                          data-nav-item
                          className={`${styles.link} ${styles.cellLink}`}
                          onClick={() => spend({ of: 'spend', factoryId: row.factoryId })}
                        >
                          {money(row.cost)}
                        </button>
                      ) : (
                        money(row.cost)
                      )}
                    </td>
                    <td className={styles.number}>
                      {factoryId === null || row.perPullRequest.median === null ? (
                        '–'
                      ) : (
                        <button
                          type="button"
                          data-nav-item
                          className={`${styles.link} ${styles.cellLink}`}
                          onClick={() => spend({ of: 'per-pull-request', factoryId })}
                        >
                          {money(row.perPullRequest.median)}
                        </button>
                      )}
                    </td>
                    {!all && (
                      <td className={styles.number}>
                        {shift ? (
                          <button
                            type="button"
                            data-nav-item
                            className={`${styles.link} ${styles.cellLink}`}
                            onClick={() =>
                              select({
                                metric: 'cost',
                                period: 'previous',
                                cost: { of: 'spend', factoryId: row.factoryId },
                              })
                            }
                          >
                            {shift}
                          </button>
                        ) : (
                          '–'
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className={`${styles.caption} ${styles.byFactoryFoot}`}>
            Codex cost comes from TED’s own price table, so treat it as an estimate.
          </p>
        </section>
      </div>
      <p className={styles.definition}>
        Spend counts each finished Run’s recorded use on the day it ended. Cost per merged pull
        request counts every Run of a Task completed in this period, whenever it ran.
      </p>
    </section>
  )
}

export interface CostSampleItem {
  key: string
  taskId: string | null
  displayId: string | null
  label: string
  note: string
}

export function costSample(
  data: DashboardCost,
  selection: DashboardSelection,
  bucketLabel: (index: number) => string,
  factoryName: (id: string | null) => string,
  equivalent: boolean,
): { title: string; caption: string; items: CostSampleItem[] } {
  const chosen = selection.cost ?? { of: 'spend' }
  const period = selection.period === 'previous' ? data.previous : data.current
  const records = new Map(data.tasks.map((task) => [task.id, task]))
  const taskLabel = (id: string) => {
    const task = records.get(id)
    return { displayId: task?.displayId ?? 'Task', label: task?.title ?? '' }
  }
  const runsNote = (id: string) => {
    const task = records.get(id)
    return task ? `${plural(task.runs, 'Run')} · ${plural(task.sendBacks, 'send-back')}` : ''
  }
  if (!period) return { title: 'Cost', caption: '', items: [] }
  if (chosen.of === 'per-pull-request') {
    const scope =
      chosen.factoryId === undefined
        ? period.perPullRequest
        : period.byFactory.find((row) => row.factoryId === chosen.factoryId)?.perPullRequest
    const samples = (scope?.samples ?? []).filter(
      (s) => chosen.taskId === undefined || s.taskId === chosen.taskId,
    )
    return {
      title:
        chosen.taskId !== undefined
          ? `Cost per merged pull request · ${records.get(chosen.taskId)?.displayId ?? 'Task'}`
          : `Cost per merged pull request${chosen.factoryId !== undefined ? ` · ${factoryName(chosen.factoryId)}` : ''}`,
      caption:
        'Tasks completed in this period with merged pull requests, most expensive per pull request first. Each Task’s cost covers all its Runs, whenever they ran.',
      items: samples.map((s) => ({
        key: s.taskId,
        taskId: s.taskId,
        ...taskLabel(s.taskId),
        note: [
          `${money(s.perPullRequest)} per pull request`,
          `${money(s.cost)} for ${plural(s.pullRequests, 'pull request')}`,
          runsNote(s.taskId),
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    }
  }
  const bucket = selection.bucket === undefined ? undefined : period.buckets[selection.bucket]
  const factory =
    chosen.factoryId === undefined
      ? undefined
      : period.byFactory.find((row) => row.factoryId === chosen.factoryId)
  const scope = bucket ?? factory ?? period
  const share: CostShare | undefined =
    chosen.kind !== undefined
      ? scope.kinds.find((k) => k.key === chosen.kind)
      : chosen.model !== undefined && 'models' in scope
        ? scope.models.find((m) => m.key === chosen.model)
        : undefined
  const groups: { name: string; share: CostShare }[] = share
    ? [
        {
          name: chosen.kind !== undefined ? costKindNames[chosen.kind] : 'Runs outside Tasks',
          share,
        },
      ]
    : chosen.kind !== undefined || chosen.model !== undefined
      ? []
      : scope.kinds.map((k) => ({ name: costKindNames[k.key as CostKind] ?? k.key, share: k }))
  const taskSpend = share ? share.tasks : scope.tasks
  const items: CostSampleItem[] = taskSpend.map((t) => ({
    key: t.taskId,
    taskId: t.taskId,
    ...taskLabel(t.taskId),
    note: [money(t.cost), runsNote(t.taskId)].filter(Boolean).join(' · '),
  }))
  for (const group of groups) {
    const rest = group.share.cost - group.share.tasks.reduce((sum, t) => sum + t.cost, 0)
    if (rest > 0.005 || (group.share.tasks.length === 0 && group.share.runs > 0))
      items.push({
        key: `rest-${group.share.key}`,
        taskId: null,
        displayId: null,
        label: group.name,
        note: `${money(rest)} not tied to a Task`,
      })
  }
  const what =
    chosen.kind !== undefined
      ? costKindNames[chosen.kind]
      : chosen.model !== undefined
        ? share
          ? modelName(share)
          : chosen.model
        : 'Spend'
  const where = [
    bucket && selection.bucket !== undefined ? bucketLabel(selection.bucket) : null,
    chosen.factoryId !== undefined ? factoryName(chosen.factoryId) : null,
    selection.period === 'previous' ? 'Previous period' : bucket ? null : 'Selected period',
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    title: `${what} · ${where}`,
    caption: `${money(share ? share.cost : scope.cost)} ${equivalent ? 'API-equivalent cost' : 'cost'}. Tasks by cost, most first, then spend that isn’t part of a Task.`,
    items,
  }
}
