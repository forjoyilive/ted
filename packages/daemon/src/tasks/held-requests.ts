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
  return held
    .filter((r) => !working(r.runId) || now - Date.parse(r.createdAt) >= maxMs)
    .map((r) => r.id)
}

export function createHeldRequests(
  store: TedStore,
  runs: RunManager,
  options: { checkEveryMs?: number; maxMs?: number } = {},
): HeldRequests {
  const fromEnv = Number(tedEnv('TED_HOLD_REQUESTS_MS') ?? Number.NaN)
  const maxMs = options.maxMs ?? (Number.isFinite(fromEnv) ? fromEnv : holdAtMostMs)
  const releaseFor = (runId: string) =>
    store.releaseRequests(
      store
        .heldRequests()
        .filter((r) => r.runId === runId)
        .map((r) => r.id),
    )
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
    turnEnded: (run) => releaseFor(run.id),
    finished: (run) => releaseFor(run.id),
  })
  sweep()
  const timer = setInterval(sweep, options.checkEveryMs ?? Math.min(10_000, Math.max(maxMs, 25)))
  timer.unref()
  return { close: () => clearInterval(timer) }
}
