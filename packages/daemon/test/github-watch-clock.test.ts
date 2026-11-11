import { expect, test } from 'vitest'
import { createPullRequestWatch } from '../src/tasks/github-watch.ts'
import type { PullRequestRef } from '../src/tasks/merge.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'

function harness() {
  const clock = new ManualClock()
  let reads = 0
  let acted = 0
  let hold: Promise<void> | undefined
  let refs: PullRequestRef[] = [
    { key: 'a', repo: 'acme/one', number: 1 },
    { key: 'b', repo: 'acme/two', number: 2 },
  ]
  const jobs: Promise<void>[] = []
  const watch = createPullRequestWatch({
    clock,
    everyMs: 30_000,
    gh: {
      async graphql() {
        reads++
        await hold
        return { data: {} }
      },
    },
    refs: () => refs,
    async onRead() {
      acted++
    },
    inBackground(_what, work) {
      jobs.push(work())
    },
  })
  const parked = () =>
    eventWait(
      clock.subscribe,
      () => clock.pending.includes(30_000),
      'GitHub poll to finish and rearm',
    )
  return {
    clock,
    watch,
    parked,
    jobs,
    reads: () => reads,
    acted: () => acted,
    hold: (promise: Promise<void>) => {
      hold = promise
    },
    noRefs: () => {
      refs = []
    },
  }
}

test('GitHub polling batches by host, waits the full interval after completion, and wakes urgently', async () => {
  const h = harness()
  try {
    h.watch.poke()
    await h.parked()
    expect(h.reads()).toBe(1)
    expect(h.acted()).toBe(1)
    h.clock.advance(29_999)
    expect(h.reads()).toBe(1)
    h.clock.advance(1)
    await h.parked()
    expect(h.reads()).toBe(2)
    await h.watch.next({ now: true })
    await h.parked()
    expect(h.reads()).toBe(3)
    const next = h.watch.next()
    h.clock.advance(30_000)
    await next
    await h.parked()
    expect(h.reads()).toBe(4)
    h.watch.kick()
    await h.parked()
    expect(h.reads()).toBe(5)
  } finally {
    h.watch.close()
    await Promise.all(h.jobs)
  }
  expect(h.clock.pending).toEqual([])
})

test('a slow GitHub request does not overlap, and close resolves queued readers without another poll', async () => {
  const h = harness()
  const gate = Promise.withResolvers<void>()
  h.hold(gate.promise)
  h.watch.poke()
  h.watch.kick()
  h.clock.advance(90_000)
  expect(h.reads()).toBe(1)
  const reader = h.watch.next()
  h.watch.close()
  expect((await reader).pulls.size).toBe(0)
  gate.resolve()
  await Promise.all(h.jobs)
  expect(h.acted()).toBe(0)
  expect(h.clock.pending).toEqual([])
  expect((await h.watch.next()).pulls.size).toBe(0)
})

test('GitHub polling stops when no refs remain', async () => {
  const h = harness()
  h.watch.poke()
  await h.parked()
  h.noRefs()
  h.clock.advance(30_000)
  await Promise.all(h.jobs)
  expect(h.reads()).toBe(1)
  expect(h.clock.pending).toEqual([])
  h.watch.close()
})
