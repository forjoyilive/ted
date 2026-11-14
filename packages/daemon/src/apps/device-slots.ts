import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppStarter,
  BootedSimulator,
  Comment,
  DaemonEvent,
  SimulatorAsk,
  SimulatorSlots,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import type { TedStore } from '../store/index.ts'

export interface SimulatorApp {
  taskId: string
  displayId: string
  factoryId: string
  repo: string
  name: string
  device: string
}

export type SimulatorWait =
  | { state: 'pending' }
  | { state: 'granted'; udid: string }
  | { state: 'denied'; text?: string }
  | { state: 'gone' }

export interface SimulatorRequestEffects {
  assertApp(): void
  hasRoom(): Promise<boolean>
  boot(): Promise<void>
  shutDown(udid: string): Promise<string>
}

export interface SlotRecord {
  taskId: string
  repo: string
  name: string
  device: string
  lastUsedAt: string
  shutDown?: { at: string; for?: string }
  owner?: string
}

export interface DeviceWords {
  noun: 'simulator' | 'emulator'
  article: 'a' | 'an'
  live: 'booted' | 'running'
  platform?: 'android'
}

export interface DeviceShutDown {
  taskId: string
  repo: string
  name: string
  forTask?: string
  idle: boolean
}

export interface DeviceDriver<R extends SlotRecord> {
  readonly words: DeviceWords
  limit(): number
  event(slots: SimulatorSlots): DaemonEvent
  slotId(record: R): string | undefined
  isLive(record: R): boolean
  recording(record: R): boolean
  check(factoryId: string): Promise<void>
  ensure(app: SimulatorApp, existing: R | undefined): Promise<R>
  refreshLive(records: R[]): Promise<boolean>
  boot(record: R): Promise<void>
  stop(record: R): Promise<void>
  remove(key: string, record: R): Promise<boolean>
  shutDownRecorded(input: DeviceShutDown): void
  close?(): Promise<void>
}

export type DeviceSlotsStore = Pick<
  TedStore,
  'getTask' | 'getComment' | 'requestSimulator' | 'answerPermission'
>

export interface DeviceSlots<R extends SlotRecord> {
  serial<T>(work: () => Promise<T>): Promise<T>
  keyOf(taskId: string, repo: string, name: string): string
  recordOf(taskId: string, repo: string, name: string): R | undefined
  records(): R[]
  save(): Promise<void>
  needsLive(taskId: string, repo: string, name: string): R
  touch(record: R): void
  changed(): void
  slots(): SimulatorSlots
  afterBoot(record: R): Promise<void>
  shutDown(record: R, why: { for?: string; idle?: boolean; human?: boolean }): Promise<void>
  acquire(
    app: SimulatorApp,
    by: AppStarter,
    input: { runId?: string; shutDown?: string; reason?: string },
  ): Promise<{ udid: string } | { waiting: string }>
  wait(commentId: string, app: SimulatorApp): Promise<SimulatorWait>
  withdraw(commentId: string): void
  withRequest<T>(
    comment: Comment,
    work: (effects: SimulatorRequestEffects) => Promise<T>,
  ): Promise<T>
  remove(taskId: string, repo?: string): Promise<void>
  taskIds(): string[]
  refresh(): Promise<void>
  close(): Promise<void>
}

const lineTicket = 'line:'

export const slug = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .toLowerCase()

export function createDeviceSlots<R extends SlotRecord>(options: {
  dir: string
  store: DeviceSlotsStore
  supported: boolean
  driver: DeviceDriver<R>
  idle?: IdleTimer
  emit(event: DaemonEvent): void
  appLive(taskId: string, repo: string, name: string): Promise<boolean>
  stopApp(taskId: string, repo: string, name: string): Promise<void>
  pollMs?: number
  idleMs?: number
}): DeviceSlots<R> {
  const { dir, store, supported, driver } = options
  const { noun, article, live } = driver.words
  const pollMs = options.pollMs ?? 3_000
  const idleMs = options.idleMs ?? 30 * 60_000
  const file = path.join(dir, 'devices.json')
  const records = new Map<string, R>(Object.entries(readRecords<R>(file)))
  let queue: Promise<unknown> = Promise.resolve()
  let releaseIdle: (() => void) | undefined
  let closed = false
  let refreshing: Promise<void> | undefined
  const line: string[] = []

  const keyOf = (taskId: string, repo: string, name: string) => `${taskId}/${repo}/${slug(name)}`
  const recordOf = (taskId: string, repo: string, name: string) =>
    records.get(keyOf(taskId, repo, name))
  const isLive = (record: R) => driver.isLive(record)
  const liveRecords = () => [...records.values()].filter(isLive)
  const liveCount = () => liveRecords().length
  const ownerOf = (record: R) =>
    store.getTask(record.taskId)?.displayId ?? record.owner ?? record.taskId

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => undefined).then(work)
    queue = next
    return next
  }

  async function save(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(records)), { mode: 0o600 })
    await rename(tmp, file)
  }

  const limit = () => driver.limit()

  function slots(): SimulatorSlots {
    const list: BootedSimulator[] = liveRecords()
      .map((r) => {
        const task = store.getTask(r.taskId)
        return {
          udid: driver.slotId(r) as string,
          taskId: r.taskId,
          displayId: task?.displayId ?? r.owner ?? r.taskId,
          title: task?.title ?? '',
          repo: r.repo,
          app: r.name,
          device: r.device,
          lastUsedAt: r.lastUsedAt,
          recording: driver.recording(r),
        }
      })
      .sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))
    return { supported, limit: limit(), booted: list }
  }

  function changed(): void {
    if (liveCount() > 0) releaseIdle ??= options.idle?.hold()
    else {
      releaseIdle?.()
      releaseIdle = undefined
    }
    options.emit(driver.event(slots()))
    const tasks = new Set([...records.values()].map((r) => r.taskId))
    for (const taskId of tasks) options.emit({ type: 'apps-changed', taskId })
  }

  async function fresh(): Promise<void> {
    if (await driver.refreshLive([...records.values()])) changed()
  }

  async function ensure(app: SimulatorApp): Promise<R> {
    const existing = recordOf(app.taskId, app.repo, app.name)
    const record = await driver.ensure(app, existing)
    if (record === existing) return record
    if (store.getTask(app.taskId) === undefined) record.owner = app.displayId
    records.set(keyOf(app.taskId, app.repo, app.name), record)
    await save()
    return record
  }

  async function afterBoot(record: R): Promise<void> {
    record.lastUsedAt = new Date().toISOString()
    delete record.shutDown
    await save()
    changed()
  }

  async function boot(record: R): Promise<void> {
    await driver.boot(record)
    await afterBoot(record)
  }

  async function shutDown(
    record: R,
    why: { for?: string; idle?: boolean; human?: boolean },
  ): Promise<void> {
    await driver.stop(record)
    record.shutDown = {
      at: new Date().toISOString(),
      ...(why.for !== undefined && { for: why.for }),
    }
    await save()
    if (!why.human) {
      void options.stopApp(record.taskId, record.repo, record.name).catch(() => undefined)
      driver.shutDownRecorded({
        taskId: record.taskId,
        repo: record.repo,
        name: record.name,
        ...(why.for !== undefined && { forTask: why.for }),
        idle: why.idle === true,
      })
    }
    changed()
  }

  function needsLive(taskId: string, repo: string, name: string): R {
    const record = recordOf(taskId, repo, name)
    if (!record || !isLive(record)) {
      throw new RequestError(
        409,
        `${name}’s ${noun} isn’t ${live}. Run it first with ted run-app ${name}.`,
      )
    }
    return record
  }

  function shutDownChoice(id: string, requester: R): R {
    const target = liveRecords().find((r) => driver.slotId(r) === id)
    if (!target) throw new RequestError(409, `That ${noun} isn’t ${live} any more`)
    if (driver.recording(target)) {
      throw new RequestError(
        409,
        `${ownerOf(target)}’s ${noun} is recording, so it can’t be shut down`,
      )
    }
    if (target === requester) throw new RequestError(409, `Pick another ${noun} to shut down`)
    return target
  }

  function touch(record: R): void {
    record.lastUsedAt = new Date().toISOString()
    void save().catch(() => undefined)
  }

  async function idleCheck(): Promise<void> {
    for (const record of [...records.values()]) {
      if (!isLive(record) || driver.recording(record)) continue
      if (Date.now() - Date.parse(record.lastUsedAt) < idleMs) continue
      if (await options.appLive(record.taskId, record.repo, record.name)) {
        touch(record)
        continue
      }
      await shutDown(record, { idle: true }).catch(() => undefined)
    }
  }

  async function refresh(): Promise<void> {
    if (!supported || closed || records.size === 0) return
    refreshing ??= serial(async () => {
      await fresh()
      await idleCheck()
    })
      .catch(() => undefined)
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }

  async function waitInLine(ticket: string, app: SimulatorApp): Promise<SimulatorWait> {
    const record = recordOf(app.taskId, app.repo, app.name)
    if (!record) return { state: 'gone' }
    if (!line.includes(ticket)) line.push(ticket)
    if (line[0] !== ticket || liveCount() >= limit()) return { state: 'pending' }
    return serial(async () => {
      await fresh()
      if (line[0] !== ticket) return { state: 'pending' } as const
      if (liveCount() >= limit() && !isLive(record)) return { state: 'pending' } as const
      if (!isLive(record)) await boot(record)
      line.shift()
      return { state: 'granted', udid: driver.slotId(record) as string } as const
    })
  }

  const granted = (record: R) => ({ udid: driver.slotId(record) as string })

  function acquire(
    app: SimulatorApp,
    by: AppStarter,
    { runId, shutDown: chosen, reason }: { runId?: string; shutDown?: string; reason?: string },
  ): Promise<{ udid: string } | { waiting: string }> {
    return serial(async () => {
      await driver.check(app.factoryId)
      const record = await ensure(app)
      await fresh()
      if (isLive(record)) {
        touch(record)
        return granted(record)
      }
      if (liveCount() < limit()) {
        await boot(record)
        return granted(record)
      }
      if (by === 'automation') {
        const ticket = `${lineTicket}${randomUUID()}`
        line.push(ticket)
        return { waiting: ticket }
      }
      if (by === 'human' || runId === undefined) {
        if (chosen === undefined) {
          throw new RequestError(
            409,
            limit() === 1
              ? `The only ${noun} slot is taken. Choose ${article} ${noun} to shut down, then run ${app.name} again.`
              : `All ${limit()} ${noun}s are ${live}. Choose one to shut down, then run ${app.name} again.`,
          )
        }
        await shutDown(shutDownChoice(chosen, record), { for: app.displayId })
        await boot(record)
        return granted(record)
      }
      const ask: SimulatorAsk = {
        ...(driver.words.platform !== undefined && { platform: driver.words.platform }),
        app: app.name,
        repo: app.repo,
        device: app.device,
        limit: limit(),
        booted: slots().booted,
      }
      const who = by === 'task-lead' ? 'the Task Lead' : 'the sub-agent'
      const comment = store.requestSimulator({
        taskId: app.taskId,
        runId,
        title: `${app.name} needs ${article} ${noun} · ${ask.booted.length} of ${ask.limit} ${live}`,
        body: [
          reason?.trim() ?? '',
          `Pick one to shut down, or deny and ${who} carries on without ${app.name}.`,
        ]
          .filter((text) => text !== '')
          .join(' '),
        simulator: ask,
      })
      return { waiting: comment.id }
    })
  }

  async function wait(commentId: string, app: SimulatorApp): Promise<SimulatorWait> {
    if (commentId.startsWith(lineTicket)) return waitInLine(commentId, app)
    const comment = store.getComment(commentId)
    const answer = comment?.answer
    const record = recordOf(app.taskId, app.repo, app.name)
    if (!comment || !record) return { state: 'gone' }
    if (answer) {
      const id = driver.slotId(record)
      if (id === undefined) return { state: 'gone' }
      if (answer.kind === 'approved') return { state: 'granted', udid: id }
      if (answer.kind === 'withdrawn' && 'slotFreed' in answer) {
        return { state: 'granted', udid: id }
      }
      if (answer.kind === 'denied') {
        return { state: 'denied', ...(answer.text !== undefined && { text: answer.text }) }
      }
      return { state: 'gone' }
    }
    if (liveCount() >= limit()) return { state: 'pending' }
    return serial(async () => {
      if (store.getComment(commentId)?.answer) return { state: 'pending' } as const
      await fresh()
      if (liveCount() >= limit() && !isLive(record)) return { state: 'pending' } as const
      if (!isLive(record)) await boot(record)
      store.answerPermission(commentId, {
        kind: 'withdrawn',
        at: new Date().toISOString(),
        slotFreed: true,
      })
      return { state: 'granted', udid: driver.slotId(record) as string } as const
    })
  }

  function withdraw(commentId: string): void {
    if (commentId.startsWith(lineTicket)) {
      const at = line.indexOf(commentId)
      if (at !== -1) line.splice(at, 1)
      return
    }
    if (store.getComment(commentId)?.answer) return
    store.answerPermission(commentId, {
      kind: 'withdrawn',
      at: new Date().toISOString(),
      appGone: true,
    })
  }

  function withRequest<T>(
    comment: Comment,
    work: (effects: SimulatorRequestEffects) => Promise<T>,
  ): Promise<T> {
    return serial(async () => {
      const requester = () => {
        const ask = comment.simulator
        const record = ask && recordOf(comment.taskId, ask.repo, ask.app)
        if (!record) throw new RequestError(409, 'the App that asked has stopped')
        return record
      }
      return work({
        assertApp() {
          requester()
        },
        async hasRoom() {
          const record = requester()
          await fresh()
          return isLive(record) || liveCount() < limit()
        },
        async boot() {
          const record = requester()
          if (!isLive(record)) await boot(record)
        },
        async shutDown(id) {
          const record = requester()
          const target = shutDownChoice(id, record)
          const owner = ownerOf(target)
          const forTask = store.getTask(comment.taskId)?.displayId ?? comment.taskId
          await shutDown(target, { for: forTask })
          return owner
        },
      })
    })
  }

  function remove(taskId: string, repo?: string): Promise<void> {
    return serial(async () => {
      const gone = [...records.entries()].filter(
        ([, r]) => r.taskId === taskId && (repo === undefined || r.repo === repo),
      )
      if (gone.length === 0) return
      for (const [key, record] of gone) {
        if (!(await driver.remove(key, record))) continue
        records.delete(key)
      }
      await save()
      changed()
    })
  }

  const timer = supported ? setInterval(() => void refresh(), pollMs) : undefined
  timer?.unref()
  if (supported && records.size > 0) void refresh()

  return {
    serial,
    keyOf,
    recordOf,
    records: () => [...records.values()],
    save,
    needsLive,
    touch,
    changed,
    slots,
    afterBoot,
    shutDown,
    acquire,
    wait,
    withdraw,
    withRequest,
    remove,
    taskIds: () => [...new Set([...records.values()].map((r) => r.taskId))],
    refresh,
    async close() {
      closed = true
      if (timer) clearInterval(timer)
      await driver.close?.()
      releaseIdle?.()
      releaseIdle = undefined
    },
  }
}

function readRecords<R>(file: string): Record<string, R> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, R>
  } catch {
    return {}
  }
}

export function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
