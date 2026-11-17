import { tedEnv } from '@ted/protocol'
import type { RunManager } from '../runs/run-manager.ts'
import type { TedStore } from '../store/index.ts'

export const holdAtMostMs = 5 * 60_000

export interface HeldRequests {
  close(): void
}

export function heldToRelease(
  held: readonly { id: string; runId: string; createdAt: string }[],
  working: (runId: string) => boolean,
  now: number,
  maxMs = holdAtMostMs,
): string[] {
  return held.flatMap((r) =>
    !working(r.runId) || now - Date.parse(r.createdAt) >= maxMs ? [r.id] : [],
  )
}

export function heldUntil(
  held: readonly { id: string; runId: string; createdAt: string }[],
  runId: string,
  turnEndedAt: string | undefined,
): string[] {
  return held.flatMap((r) =>
    r.runId === runId && (turnEndedAt === undefined || r.createdAt <= turnEndedAt) ? [r.id] : [],
  )
}

export function createHeldRequests(
  store: TedStore,
  runs: RunManager,
  options: { checkEveryMs?: number; maxMs?: number } = {},
): HeldRequests {
  const fromEnv = Number(tedEnv('TED_HOLD_REQUESTS_MS') ?? Number.NaN)
  const maxMs = options.maxMs ?? (Number.isFinite(fromEnv) ? fromEnv : holdAtMostMs)
  const releaseFor = (runId: string, turnEndedAt?: string) =>
    store.releaseRequests(heldUntil(store.heldRequests(), runId, turnEndedAt))
  const sweep = () =>
    store.releaseRequests(
      heldToRelease(
        store.heldRequests(),
        (runId) => store.getRun(runId)?.state === 'working',
        Date.now(),
        maxMs,
      ),
    )
  runs.observe({
    turnEnded: (run, at) => releaseFor(run.id, at),
    finished: (run) => releaseFor(run.id),
  })
  sweep()
  const timer = setInterval(sweep, options.checkEveryMs ?? Math.min(10_000, Math.max(maxMs, 25)))
  timer.unref()
  return { close: () => clearInterval(timer) }
}
