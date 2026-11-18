import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Comment, CommentAnswer, DaemonEvent } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDevicePool, type DevicePool } from '../src/apps/device-pool.ts'
import {
  createDeviceSlots,
  type DeviceDriver,
  type DeviceShutDown,
  type DeviceSlotsStore,
  type SimulatorApp,
  type SlotRecord,
} from '../src/apps/device-slots.ts'

interface FakeRecord extends SlotRecord {
  id: string
}

let dir: string
const opened: { close(): Promise<void> }[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-device-slots-'))
})

afterEach(async () => {
  for (const slots of opened.splice(0)) await slots.close()
  await rm(dir, { recursive: true, force: true })
})

const app = (task: string, name = 'ios'): SimulatorApp => ({
  taskId: task,
  displayId: task.toUpperCase(),
  factoryId: 'f1',
  repo: 'widgets',
  name,
  device: 'iPhone 16',
})

function setup(
  options: {
    limit?: number
    idleMs?: number
    appLive?: Set<string>
    busy?: () => boolean
    pool?: DevicePool
    android?: boolean
    oneAtATime?: boolean
  } = {},
) {
  const pool =
    options.pool ??
    createDevicePool({
      limit: () => options.limit ?? 1,
      oneAtATime: () => options.oneAtATime ?? false,
    })
  const prefix = options.android ? 'emu' : 'dev'
  const live = new Set<string>()
  const recording = new Set<string>()
  const stopped: string[] = []
  const shutDowns: DeviceShutDown[] = []
  const comments = new Map<string, Comment>()
  const boots: string[] = []
  const events: DaemonEvent[] = []
  let made = 0
  const driver: DeviceDriver<FakeRecord> = {
    words: options.android
      ? { noun: 'emulator', article: 'an', live: 'running', platform: 'android' }
      : { noun: 'simulator', article: 'a', live: 'booted' },
    event: (simulators): DaemonEvent => ({ type: 'simulators-changed', simulators }),
    slotId: (record) => record.id,
    isLive: (record) => live.has(record.id),
    recording: (record) => recording.has(record.id),
    check: async () => undefined,
    async ensure(app, existing) {
      if (existing) return existing
      made += 1
      return {
        id: `${prefix}-${made}`,
        taskId: app.taskId,
        repo: app.repo,
        name: app.name,
        device: app.device,
        lastUsedAt: new Date().toISOString(),
      }
    },
    refreshLive: async () => false,
    async boot(record) {
      boots.push(record.id)
      live.add(record.id)
    },
    async stop(record) {
      live.delete(record.id)
      stopped.push(record.id)
    },
    remove: async () => true,
    shutDownRecorded: (input) => shutDowns.push(input),
  }
  const store = {
    getTask: () => undefined,
    getComment: (id: string) => comments.get(id),
    requestSimulator(input: { taskId: string; title: string; body: string }) {
      const comment = { id: `c${comments.size + 1}`, ...input } as Comment
      comments.set(comment.id, comment)
      return comment
    },
    answerPermission(id: string, answer: CommentAnswer) {
      const comment = { ...comments.get(id), answer } as Comment
      comments.set(id, comment)
      return comment
    },
  } as DeviceSlotsStore
  const slots = createDeviceSlots({
    dir,
    store,
    supported: true,
    driver,
    pool,
    emit: (event) => {
      events.push(event)
    },
    appLive: async (taskId) => options.appLive?.has(taskId) ?? false,
    stopApp: async () => undefined,
    pollMs: 60 * 60_000,
    ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
    ...(options.busy !== undefined && { busy: async () => options.busy?.() ?? false }),
  })
  opened.push(slots)
  return { slots, pool, live, boots, recording, stopped, shutDowns, comments, events }
}

test('a free slot boots the device and a live one is reused', async () => {
  const { slots, live, boots } = setup()
  expect(await slots.acquire(app('t1'), 'human', {})).toEqual({ udid: 'dev-1' })
  expect([...live]).toEqual(['dev-1'])
  expect(await slots.acquire(app('t1'), 'task-lead', { runId: 'r1' })).toEqual({ udid: 'dev-1' })
  expect(boots).toEqual(['dev-1'])
  expect(slots.slots().booted.map((b) => b.udid)).toEqual(['dev-1'])
})

test('Automation Runs wait in line and get the slot in the order they asked', async () => {
  const { slots, live } = setup()
  await slots.acquire(app('t1'), 'human', {})
  const first = await slots.acquire(app('t2'), 'automation', {})
  const second = await slots.acquire(app('t3'), 'automation', {})
  if (!('waiting' in first) || !('waiting' in second)) throw new Error('expected to wait')
  expect(await slots.wait(second.waiting, app('t3'))).toEqual({ state: 'pending' })
  expect(await slots.wait(first.waiting, app('t2'))).toEqual({ state: 'pending' })

  live.delete('dev-1')
  expect(await slots.wait(second.waiting, app('t3'))).toEqual({ state: 'pending' })
  expect(await slots.wait(first.waiting, app('t2'))).toEqual({ state: 'granted', udid: 'dev-2' })
  expect(await slots.wait(second.waiting, app('t3'))).toEqual({ state: 'pending' })

  live.delete('dev-2')
  expect(await slots.wait(second.waiting, app('t3'))).toEqual({ state: 'granted', udid: 'dev-3' })
})

test('while this computer is busy an agent’s boot waits in line with a slot free, the first device and a human start still boot', async () => {
  let busy = true
  const { slots, comments } = setup({ limit: 3, busy: () => busy })
  expect(await slots.acquire(app('t1'), 'task-lead', { runId: 'r1' })).toEqual({ udid: 'dev-1' })
  const waiting = await slots.acquire(app('t2'), 'task-lead', { runId: 'r2' })
  if (!('waiting' in waiting)) throw new Error('expected to wait')
  expect(comments.size).toBe(0)
  expect(await slots.wait(waiting.waiting, app('t2'))).toEqual({ state: 'pending' })
  expect(await slots.acquire(app('t3'), 'human', {})).toEqual({ udid: 'dev-3' })

  busy = false
  expect(await slots.wait(waiting.waiting, app('t2'))).toEqual({ state: 'granted', udid: 'dev-2' })
})

test('a human start needs a choice, a chosen device is shut down for it, and a recording one is kept', async () => {
  const { slots, live, recording, stopped, shutDowns } = setup()
  await slots.acquire(app('t1'), 'human', {})
  await expect(slots.acquire(app('t2'), 'human', {})).rejects.toThrow(
    'The only simulator or emulator slot is taken. Choose one to shut down, then run ios again.',
  )

  recording.add('dev-1')
  await expect(slots.acquire(app('t2'), 'human', { shutDown: 'dev-1' })).rejects.toThrow(
    'T1’s simulator is recording, so it can’t be shut down',
  )
  expect(stopped).toEqual([])

  recording.delete('dev-1')
  expect(await slots.acquire(app('t2'), 'human', { shutDown: 'dev-1' })).toEqual({
    udid: 'dev-2',
  })
  expect([...live]).toEqual(['dev-2'])
  expect(shutDowns).toEqual([
    { taskId: 't1', repo: 'widgets', name: 'ios', forTask: 'T2', idle: false },
  ])
})

test('a Task Run asks for a slot and is granted it once the human approves', async () => {
  const { slots, comments } = setup()
  await slots.acquire(app('t1'), 'human', {})
  const asked = await slots.acquire(app('t2'), 'task-lead', {
    runId: 'r2',
    reason: 'To check the login screen.',
  })
  if (!('waiting' in asked)) throw new Error('expected to wait')
  expect(comments.get(asked.waiting)).toMatchObject({
    title: 'ios needs a simulator · 1 of 1 running',
    body: 'To check the login screen. Pick a simulator or emulator to shut down, or deny and the Task Lead carries on without ios.',
  })
  expect(await slots.wait(asked.waiting, app('t2'))).toEqual({ state: 'pending' })
  const owner = await slots.withRequest(comments.get(asked.waiting) as Comment, async (effects) => {
    const freed = await effects.shutDown('dev-1')
    await effects.boot()
    return freed
  })
  expect(owner).toBe('T1')
  const answered = { ...comments.get(asked.waiting), answer: { kind: 'approved' } } as Comment
  comments.set(asked.waiting, answered)
  expect(await slots.wait(asked.waiting, app('t2'))).toEqual({ state: 'granted', udid: 'dev-2' })
})

test('an idle device is shut down unless its App is still running', async () => {
  const { slots, live, shutDowns } = setup({ limit: 2, idleMs: 0, appLive: new Set(['t2']) })
  await slots.acquire(app('t1'), 'human', {})
  await slots.acquire(app('t2'), 'human', {})
  await slots.refresh()
  expect([...live]).toEqual(['dev-2'])
  expect(shutDowns).toEqual([{ taskId: 't1', repo: 'widgets', name: 'ios', idle: true }])
})

test('simulators and emulators share one limit, and either kind can be shut down for the other', async () => {
  const ios = setup({ limit: 2 })
  const android = setup({ pool: ios.pool, android: true })
  expect(await ios.slots.acquire(app('t1'), 'human', {})).toEqual({ udid: 'dev-1' })
  expect(await android.slots.acquire(app('t2', 'android'), 'human', {})).toEqual({
    udid: 'emu-1',
  })
  expect(android.slots.slots()).toMatchObject({ limit: 2 })
  expect(ios.slots.slots().booted.map((b) => [b.udid, b.platform])).toEqual([
    ['dev-1', undefined],
    ['emu-1', 'android'],
  ])
  await expect(ios.slots.acquire(app('t3'), 'human', {})).rejects.toThrow(
    'All 2 simulators and emulators are running. Choose one to shut down, then run ios again.',
  )

  android.recording.add('emu-1')
  await expect(ios.slots.acquire(app('t3'), 'human', { shutDown: 'emu-1' })).rejects.toThrow(
    'T2’s emulator is recording, so it can’t be shut down',
  )
  android.recording.delete('emu-1')
  expect(await ios.slots.acquire(app('t3'), 'human', { shutDown: 'emu-1' })).toEqual({
    udid: 'dev-2',
  })
  expect(android.shutDowns).toEqual([
    { taskId: 't2', repo: 'widgets', name: 'android', forTask: 'T3', idle: false },
  ])
})

test('while this computer is busy an agent’s first simulator waits when an emulator is running', async () => {
  const ios = setup({ limit: 3, busy: () => true })
  const android = setup({ pool: ios.pool, android: true, busy: () => true })
  expect(await android.slots.acquire(app('t1', 'android'), 'task-lead', { runId: 'r1' })).toEqual({
    udid: 'emu-1',
  })
  const waiting = await ios.slots.acquire(app('t2'), 'task-lead', { runId: 'r2' })
  expect(waiting).toHaveProperty('waiting')
  expect(ios.live.size).toBe(0)
})

test('one App builds at a time across kinds, and the next goes when the turn ends or runs out', async () => {
  let now = 0
  const pool = createDevicePool({
    limit: () => 3,
    oneAtATime: () => true,
    turnMs: 60_000,
    now: () => now,
  })
  const ios = setup({ pool })
  const android = setup({ pool, android: true })
  expect(await android.slots.acquire(app('t1', 'android'), 'task-lead', { runId: 'r1' })).toEqual({
    udid: 'emu-1',
  })
  expect(pool.holder()).toMatchObject({ displayId: 'T1', app: 'android' })

  const human = await ios.slots.acquire(app('t2'), 'human', {})
  const agent = await ios.slots.acquire(app('t3'), 'task-lead', { runId: 'r3' })
  if (!('waiting' in human) || !('waiting' in agent)) throw new Error('expected to wait')
  expect(ios.live.size).toBe(0)
  expect(await ios.slots.wait(human.waiting, app('t2'))).toEqual({ state: 'pending' })

  pool.endTurn('t1/widgets/android')
  expect(await ios.slots.wait(agent.waiting, app('t3'))).toEqual({ state: 'pending' })
  expect(await ios.slots.wait(human.waiting, app('t2'))).toEqual({
    state: 'granted',
    udid: 'dev-1',
  })
  expect(await ios.slots.wait(agent.waiting, app('t3'))).toEqual({ state: 'pending' })

  now += 60_000
  expect(await ios.slots.wait(agent.waiting, app('t3'))).toEqual({
    state: 'granted',
    udid: 'dev-2',
  })
  expect(pool.holder()).toMatchObject({ displayId: 'T3' })

  const again = await android.slots.acquire(app('t1', 'android'), 'human', {})
  expect(again).toHaveProperty('waiting')
})

test('the waiting list says what each App waits for and updates when the build turn ends', async () => {
  const { slots, pool, events } = setup({ oneAtATime: true })
  await slots.acquire(app('t1'), 'human', {})
  const queued = await slots.acquire(app('t2'), 'automation', {})
  if (!('waiting' in queued)) throw new Error('expected to wait')
  expect(slots.slots().waiting).toMatchObject([
    { taskId: 't2', app: 'ios', place: 1, waitingFor: { kind: 'build', displayId: 'T1' } },
  ])

  events.length = 0
  pool.endTurn('t1/widgets/ios')
  const sent = events.flatMap((e) => (e.type === 'simulators-changed' ? [e.simulators] : []))
  expect(sent.at(-1)?.waiting).toMatchObject([{ taskId: 't2', waitingFor: { kind: 'device' } }])

  slots.withdraw(queued.waiting)
  expect(slots.slots().waiting).toEqual([])
})

test('Apps that ask the human and Apps in line are listed in the order they asked', async () => {
  const { slots } = setup()
  await slots.acquire(app('t1'), 'human', {})
  await slots.acquire(app('t2'), 'task-lead', { runId: 'r2' })
  await slots.acquire(app('t3'), 'automation', {})
  expect(slots.slots().waiting).toMatchObject([
    { taskId: 't2', place: 1, waitingFor: { kind: 'answer' } },
    { taskId: 't3', place: 2, waitingFor: { kind: 'device' } },
  ])
})

test('with one build at a time off, two Apps start together', async () => {
  const ios = setup({ limit: 2 })
  const android = setup({ pool: ios.pool, android: true })
  expect(await android.slots.acquire(app('t1', 'android'), 'task-lead', { runId: 'r1' })).toEqual({
    udid: 'emu-1',
  })
  expect(await ios.slots.acquire(app('t2'), 'task-lead', { runId: 'r2' })).toEqual({
    udid: 'dev-1',
  })
  expect(ios.pool.holder()).toBeUndefined()
})
