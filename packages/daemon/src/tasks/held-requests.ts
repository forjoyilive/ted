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
        options.maxMs,
      ),
    )
  runs.observe({
    settled: (run) => releaseFor(run.id),
    finished: (run) => releaseFor(run.id),
    stoppedOutside: (run) => releaseFor(run.id),
  })
  sweep()
  const timer = setInterval(sweep, options.checkEveryMs ?? 10_000)
  timer.unref()
  return { close: () => clearInterval(timer) }
}
