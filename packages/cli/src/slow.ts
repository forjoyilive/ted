import type { SlowMoments, SlowTotals, SlowWindow } from '@ted/protocol'

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function totals({ totalMs, longestMs }: SlowTotals, longest: string): string {
  return `${duration(totalMs)} in total, ${longest} ${duration(longestMs)}`
}

function windowLines(title: string, { stalls, requests, routes }: SlowWindow): string[] {
  return [
    title,
    stalls.count === 0
      ? '  Event loop: not blocked'
      : `  Event loop: blocked ${stalls.count} ${stalls.count === 1 ? 'time' : 'times'}, ${totals(stalls, 'longest')}`,
    requests.count === 0
      ? '  Requests: none slow'
      : `  Requests: ${requests.count} slow, ${totals(requests, 'slowest')}`,
    ...routes.map((route) => `    ${route.count} × ${route.route} · ${totals(route, 'slowest')}`),
  ]
}

export function formatSlowMoments(slow: SlowMoments): string {
  const { requestMs, stallMs } = slow.thresholds
  return [
    `Measured since ${slow.since}. A request is slow over ${requestMs} ms; the event loop is blocked over ${stallMs} ms.`,
    ...windowLines('Last minute', slow.lastMinute),
    ...windowLines('Last hour', slow.lastHour),
  ].join('\n')
}
