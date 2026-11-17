import type { FlowInterval, FlowReasonId } from './dashboard.ts'

export const stageParts = [
  'working',
  'checks',
  'you',
  'slot',
  'github',
  'blocked',
  'other',
] as const

export type StagePart = (typeof stageParts)[number]
export type StageParts = Record<StagePart, number>

export const stagePartOf: Record<FlowReasonId, Exclude<StagePart, 'other'>> = {
  'run-working': 'working',
  'running-check': 'checks',
  'user-request': 'you',
  'check-slot': 'slot',
  'test-lock': 'slot',
  'run-slot': 'slot',
  github: 'github',
  blocker: 'blocked',
  'agent-paused': 'blocked',
  stopped: 'blocked',
}

export const noStageParts = (): StageParts => ({
  working: 0,
  checks: 0,
  you: 0,
  slot: 0,
  github: 0,
  blocked: 0,
  other: 0,
})

type Span = [number, number]

function spans(intervals: readonly FlowInterval[]): Span[] {
  const result: Span[] = []
  const sorted = intervals
    .flatMap((i): Span[] => {
      const a = Date.parse(i.from)
      const b = Date.parse(i.to)
      return Number.isFinite(a) && Number.isFinite(b) && b > a ? [[a, b]] : []
    })
    .sort((x, y) => x[0] - y[0])
  for (const [a, b] of sorted) {
    const last = result.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else result.push([a, b])
  }
  return result
}

const length = (list: readonly Span[]) => list.reduce((n, [a, b]) => n + b - a, 0)

function minus(from: readonly Span[], cut: readonly Span[]): Span[] {
  const result: Span[] = []
  for (const [a, b] of from) {
    let start = a
    for (const [c, d] of cut) {
      if (d <= start || c >= b) continue
      if (c > start) result.push([start, c])
      start = Math.max(start, d)
      if (start >= b) break
    }
    if (start < b) result.push([start, b])
  }
  return result
}

export function splitStage(
  visits: readonly FlowInterval[],
  reasons: ReadonlyMap<FlowReasonId, readonly FlowInterval[]>,
  leaveOut: readonly StagePart[] = [],
): StageParts {
  const byPart = new Map<StagePart, FlowInterval[]>()
  for (const [reason, intervals] of reasons) {
    const part = stagePartOf[reason]
    byPart.set(part, [...(byPart.get(part) ?? []), ...intervals])
  }
  let left = spans(visits)
  for (const part of leaveOut) left = minus(left, spans(byPart.get(part) ?? []))
  const result = noStageParts()
  for (const part of stageParts) {
    if (part === 'other' || leaveOut.includes(part)) continue
    const rest = minus(left, spans(byPart.get(part) ?? []))
    result[part] = length(left) - length(rest)
    left = rest
  }
  result.other = leaveOut.includes('other') ? 0 : length(left)
  return result
}

export function addStageParts(into: StageParts, add: StageParts) {
  for (const part of stageParts) into[part] += add[part]
  return into
}
