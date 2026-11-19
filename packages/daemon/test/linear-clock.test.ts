import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, expectTypeOf, test } from 'vitest'
import { openStore, type TedStore } from '../src/store/index.ts'
import type { TrackersArea } from '../src/store/trackers.ts'
import { createLinearSync } from '../src/tasks/linear-sync.ts'
import { ManualClock } from './support/manual-clock.ts'

expectTypeOf<TedStore>().toExtend<TrackersArea>()

test('Linear waits a full interval after a slow cycle, never overlaps, and does not rearm after close', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ted-linear-clock-'))
  const store = await openStore({ directory: dir })
  const clock = new ManualClock()
  const gate = Promise.withResolvers<void>()
  const jobs: Promise<void>[] = []
  let requests = 0
  const sync = createLinearSync({
    clock,
    store,
    everyMs: 60_000,
    linear: {
      async issueStates() {
        requests++
        await gate.promise
        return new Map()
      },
      async teamStates() {
        return []
      },
      async moveIssue() {},
      async linkUrl() {},
    },
    actions: {
      gone: () => false,
      liveRun: () => false,
      openRequests: () => [],
      archive() {},
      under: () => [],
    },
    inBackground(_what, work) {
      jobs.push(work())
    },
  })
  try {
    store.updateSettings({ linearSync: true })
    await store.createTask({
      title: 'Fix login',
      source: { url: 'https://linear.app/acme/issue/AC-1' },
    })
    clock.advance(59_999)
    expect(requests).toBe(0)
    clock.advance(1)
    expect(requests).toBe(1)
    clock.advance(180_000)
    expect(requests).toBe(1)
    expect(clock.pending).toEqual([])
    gate.resolve()
    await Promise.all(jobs)
    expect(clock.pending).toEqual([60_000])
    clock.advance(60_000)
    expect(requests).toBe(2)
    sync.close()
    await Promise.all(jobs)
    expect(clock.pending).toEqual([])
  } finally {
    gate.resolve()
    sync.close()
    await Promise.all(jobs)
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
