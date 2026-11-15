import { expect, test } from 'vitest'
import { createInFlight, type InFlightKind, type MarkKind } from '../src/tasks/in-flight.ts'
import { ManualClock } from './support/manual-clock.ts'

const task = { id: 'task-1', displayId: 'NB-1' }

function setup() {
  const clock = new ManualClock(1000)
  const seen = { holds: [] as string[], freed: [] as string[], released: 0 }
  const inFlight = createInFlight({
    clock,
    onHold: (id) => seen.holds.push(id),
    onHoldsFreed: (id) => seen.freed.push(id),
    onReleased: () => {
      seen.released += 1
    },
  })
  return { clock, seen, inFlight }
}

test('a second transition on the same Task is refused until the first ends', async () => {
  const { inFlight, seen } = setup()
  const gate = Promise.withResolvers<void>()
  const first = inFlight.transition(task, async () => {
    await gate.promise
    return 'first'
  })
  expect(inFlight.is(task.id, 'transition')).toBe(true)
  await expect(inFlight.transition(task, async () => 'second')).rejects.toMatchObject({
    status: 409,
    message: 'NB-1 is already moving; try again',
  })
  await expect(
    inFlight.transition({ id: 'task-2', displayId: 'NB-2' }, async () => 'other'),
  ).resolves.toBe('other')
  gate.resolve()
  await expect(first).resolves.toBe('first')
  expect(inFlight.is(task.id, 'transition')).toBe(false)
  await expect(inFlight.transition(task, async () => 'again')).resolves.toBe('again')
  expect(seen.released).toBe(3)
})

test('a transition is refused while the Task has hierarchy work or is being deleted', async () => {
  const { inFlight } = setup()
  for (const kind of ['hierarchy', 'deleting'] as const) {
    const done = inFlight.mark(task.id, kind)
    expect(inFlight.inHierarchyWork(task.id)).toBe(true)
    expect(() => inFlight.refuseHierarchyWork(task)).toThrow(
      'NB-1 has a hierarchy operation underway; try again',
    )
    await expect(inFlight.transition(task, async () => 'moved')).rejects.toMatchObject({
      status: 409,
      message: 'NB-1 has a hierarchy operation underway; try again',
    })
    done()
    expect(inFlight.inHierarchyWork(task.id)).toBe(false)
  }
})

test('transitionWhenFree waits for the current transition and then runs on the re-read Task', async () => {
  const { inFlight } = setup()
  const gate = Promise.withResolvers<void>()
  const first = inFlight.transition(task, () => gate.promise)
  const ran: string[] = []
  const reread = { id: task.id, displayId: 'NB-1 renamed' }
  const waiting = inFlight.transitionWhenFree(
    task,
    async () => {
      ran.push('second')
      return 'second'
    },
    60_000,
    () => reread,
  )
  await Promise.resolve()
  expect(ran).toEqual([])
  gate.resolve()
  await first
  await expect(waiting).resolves.toBe('second')
  expect(ran).toEqual(['second'])
})

test('transitionWhenFree gives up after its limit without running', async () => {
  const { clock, inFlight } = setup()
  const gate = Promise.withResolvers<void>()
  const first = inFlight.transition(task, () => gate.promise)
  let ran = false
  const waiting = inFlight.transitionWhenFree(
    task,
    async () => {
      ran = true
    },
    60_000,
  )
  const refused = expect(waiting).rejects.toMatchObject({
    status: 409,
    message:
      'NB-1 is still busy after waiting a minute. No answer was applied; try again when its current operation finishes.',
  })
  clock.advance(59_999)
  await Promise.resolve()
  expect(clock.pending).toEqual([1])
  clock.advance(1)
  await refused
  expect(ran).toBe(false)
  expect(clock.pending).toEqual([])
  gate.resolve()
  await first
})

test('untilFree returns when the Task is free or at its limit', async () => {
  const { clock, inFlight } = setup()
  await inFlight.untilFree(task.id, 15_000)
  const gate = Promise.withResolvers<void>()
  const first = inFlight.transition(task, () => gate.promise)
  const waiting = inFlight.untilFree(task.id, 15_000)
  clock.advance(15_000)
  await waiting
  expect(inFlight.is(task.id, 'transition')).toBe(true)
  gate.resolve()
  await first
})

test('a mark is released exactly once', () => {
  const { inFlight } = setup()
  const done = inFlight.mark(['task-1', 'task-2'], 'hierarchy')
  expect(inFlight.is('task-1', 'hierarchy') && inFlight.is('task-2', 'hierarchy')).toBe(true)
  done()
  expect(inFlight.is('task-1', 'hierarchy') || inFlight.is('task-2', 'hierarchy')).toBe(false)
  const later = inFlight.mark('task-1', 'hierarchy')
  done()
  expect(inFlight.is('task-1', 'hierarchy')).toBe(true)
  later()
  inFlight.mark(task.id, 'checking')
  inFlight.unmark(task.id, 'checking')
  expect(inFlight.is(task.id, 'checking')).toBe(false)
})

test('holds are counted, each release runs once, and the last one frees the Task', () => {
  const { inFlight, seen } = setup()
  const first = inFlight.hold(task.id)
  const second = inFlight.hold(task.id)
  expect(seen.holds).toEqual([task.id, task.id])
  expect(inFlight.held()).toEqual([task.id])
  first()
  first()
  expect(inFlight.is(task.id, 'held')).toBe(true)
  expect(seen).toMatchObject({ freed: [], released: 1 })
  second()
  expect(inFlight.is(task.id, 'held')).toBe(false)
  expect(inFlight.held()).toEqual([])
  expect(seen).toMatchObject({ freed: [task.id], released: 2 })
})

test('busy reflects each kind', async () => {
  const { inFlight } = setup()
  const marks: MarkKind[] = [
    'starting',
    'checking',
    'deleting',
    'hierarchy',
    'stoppingForBlockers',
    'merging',
  ]
  const all: InFlightKind[] = ['transition', 'held', ...marks]
  for (const kind of marks) {
    const done = inFlight.mark(task.id, kind)
    expect(all.filter((k) => inFlight.is(task.id, k))).toEqual([kind])
    expect(inFlight.busy(task.id, [kind])).toBe(true)
    expect(
      inFlight.busy(
        task.id,
        all.filter((k) => k !== kind),
      ),
    ).toBe(false)
    done()
  }
  const release = inFlight.hold(task.id)
  expect(all.filter((k) => inFlight.is(task.id, k))).toEqual(['held'])
  release()
  const gate = Promise.withResolvers<void>()
  const moving = inFlight.transition(task, () => gate.promise)
  expect(all.filter((k) => inFlight.is(task.id, k))).toEqual(['transition'])
  expect(inFlight.busy(task.id, ['held', 'transition'])).toBe(true)
  gate.resolve()
  await moving
  expect(inFlight.busy(task.id, all)).toBe(false)
})
