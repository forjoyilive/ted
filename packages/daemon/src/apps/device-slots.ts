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
import type { DevicePool, TurnHolder } from './device-pool.ts'

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

export const lineTicket = 'line:'

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
  pool: DevicePool
  idle?: IdleTimer
  emit(event: DaemonEvent): void
  appLive(taskId: string, repo: string, name: string): Promise<boolean>
  stopApp(taskId: string, repo: string, name: string): Promise<void>
  pollMs?: number
  idleMs?: number
  busy?: () => Promise<boolean>
}): DeviceSlots<R> {
  const { dir, store, supported, driver, pool } = options
  const { noun, article, live } = driver.words
  const pollMs = options.pollMs ?? 3_000
  const idleMs = options.idleMs ?? 30 * 60_000
  const file = path.join(dir, 'devices.json')
  const records = new Map<string, R>(Object.entries(readRecords<R>(file)))
  let releaseIdle: (() => void) | undefined
  let closed = false
  let refreshing: Promise<void> | undefined
  const line = pool.line
  const humanTickets = new Set<string>()
  const saving = new Set<Promise<void>>()

  const keyOf = (taskId: string, repo: string, name: string) => `${taskId}/${repo}/${slug(name)}`
  const recordOf = (taskId: string, repo: string, name: string) =>
    records.get(keyOf(taskId, repo, name))
  const isLive = (record: R) => driver.isLive(record)
  const liveRecords = () => [...records.values()].filter(isLive)
  const liveCount = () => pool.liveCount()
  const ownerOf = (record: R) =>
    store.getTask(record.taskId)?.displayId ?? record.owner ?? record.taskId

  const serial = <T>(work: () => Promise<T>): Promise<T> => pool.serial(work)
  const holderOf = (app: SimulatorApp): TurnHolder => ({
    key: keyOf(app.taskId, app.repo, app.name),
    displayId: app.displayId,
    app: app.name,
  })

  async function save(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(records)), { mode: 0o600 })
    await rename(tmp, file)
  }

  const limit = () => pool.limit()
  const heldBusy = async (record: R) =>
    !isLive(record) && liveCount() > 0 && ((await options.busy?.()) ?? false)

  function ownLive(): BootedSimulator[] {
    return liveRecords().map((r) => {
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
        ...(driver.words.platform !== undefined && { platform: driver.words.platform }),
      }
    })
  }

  function slots(): SimulatorSlots {
    const list = pool.live().sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))
    return { supported, limit: limit(), booted: list }
  }

  function notify(): void {
    options.emit(driver.event(slots()))
    const tasks = new Set([...records.values()].map((r) => r.taskId))
    for (const taskId of tasks) options.emit({ type: 'apps-changed', taskId })
  }

  function changed(): void {
    if (liveRecords().length > 0) releaseIdle ??= options.idle?.hold()
    else {
      releaseIdle?.()
      releaseIdle = undefined
    }
    pool.changed()
  }

  async function fresh(): Promise<void> {
    if (await driver.refreshLive([...records.values()])) changed()
  }

  const recordAt = (slotId: string) => liveRecords().find((r) => driver.slotId(r) === slotId)

  pool.join({
    live: ownLive,
    fresh,
    owns: (slotId) => recordAt(slotId) !== undefined,
    async shutDownFor(slotId, forTask) {
      const target = recordAt(slotId)
      if (!target) throw new RequestError(409, `That ${noun} isn’t ${live} any more`)
      const owner = ownerOf(target)
      pool.endTurn(keyOf(target.taskId, target.repo, target.name))
      await shutDown(target, { for: forTask })
      return owner
    },
    notify,
  })

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

  function shutDownChoice(id: string, requester: R): string {
    const target = pool.find(id)
    if (!target) {
      throw new RequestError(409, 'That simulator or emulator has already shut down')
    }
    if (target.recording) {
      const kind = target.platform === 'android' ? 'emulator' : 'simulator'
      throw new RequestError(
        409,
        `${target.displayId}’s ${kind} is recording, so it can’t be shut down`,
      )
    }
    if (id === driver.slotId(requester)) {
      throw new RequestError(409, `Pick another ${noun} to shut down`)
    }
    return id
  }

  function touch(record: R): void {
    record.lastUsedAt = new Date().toISOString()
    const saved = save().catch(() => undefined)
    saving.add(saved)
    void saved.finally(() => saving.delete(saved))
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
    const blocked = () =>
      (!isLive(record) && (line[0] !== ticket || liveCount() >= limit())) ||
      !pool.turnFree(holderOf(app).key)
    if (blocked()) return { state: 'pending' }
    return serial(async () => {
      await pool.fresh()
      if (blocked()) return { state: 'pending' } as const
      if (!humanTickets.has(ticket) && (await heldBusy(record))) {
        return { state: 'pending' } as const
      }
      pool.takeTurn(holderOf(app))
      if (!isLive(record)) await boot(record)
      line.splice(line.indexOf(ticket), 1)
      humanTickets.delete(ticket)
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
      await pool.fresh()
      const queued = () => {
        const ticket = `${lineTicket}${randomUUID()}`
        line.push(ticket)
        if (by === 'human') humanTickets.add(ticket)
        return { waiting: ticket }
      }
      const turn = () => pool.startTurn(holderOf(app))
      if (isLive(record)) {
        if (!pool.takeTurn(holderOf(app))) return queued()
        touch(record)
        return granted(record)
      }
      if (liveCount() < limit()) {
        if (by !== 'human' && (await heldBusy(record))) return queued()
        if (!turn()) return queued()
        await boot(record)
        return granted(record)
      }
      if (by === 'automation') return queued()
      if (by === 'human' || runId === undefined) {
        if (chosen === undefined) {
          throw new RequestError(
            409,
            limit() === 1
              ? `The only simulator or emulator slot is taken. Choose one to shut down, then run ${app.name} again.`
              : `All ${limit()} simulators and emulators are running. Choose one to shut down, then run ${app.name} again.`,
          )
        }
        await pool.shutDownFor(shutDownChoice(chosen, record), app.displayId)
        if (!turn()) return queued()
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
        title: `${app.name} needs ${article} ${noun} · ${ask.booted.length} of ${ask.limit} running`,
        body: [
          reason?.trim() ?? '',
          `Pick a simulator or emulator to shut down, or deny and ${who} carries on without ${app.name}.`,
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
      const freed =
        answer.kind === 'approved' || (answer.kind === 'withdrawn' && 'slotFreed' in answer)
      if (freed) {
        return pool.takeTurn(holderOf(app)) ? { state: 'granted', udid: id } : { state: 'pending' }
      }
      if (answer.kind === 'denied') {
        return { state: 'denied', ...(answer.text !== undefined && { text: answer.text }) }
      }
      return { state: 'gone' }
    }
    if (liveCount() >= limit() || !pool.turnFree(holderOf(app).key)) return { state: 'pending' }
    return serial(async () => {
      if (store.getComment(commentId)?.answer) return { state: 'pending' } as const
      await pool.fresh()
      if (liveCount() >= limit() && !isLive(record)) return { state: 'pending' } as const
      if (await heldBusy(record)) return { state: 'pending' } as const
      if (!pool.takeTurn(holderOf(app))) return { state: 'pending' } as const
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
      humanTickets.delete(commentId)
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
          await pool.fresh()
          return isLive(record) || liveCount() < limit()
        },
        async boot() {
          const record = requester()
          if (!isLive(record)) await boot(record)
        },
        async shutDown(id) {
          const record = requester()
          const forTask = store.getTask(comment.taskId)?.displayId ?? comment.taskId
          return pool.shutDownFor(shutDownChoice(id, record), forTask)
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
      await Promise.all(saving)
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
