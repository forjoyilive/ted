import type { BootedSimulator } from '@ted/protocol'

export interface PoolMember {
  live(): BootedSimulator[]
  fresh(): Promise<void>
  owns(slotId: string): boolean
  shutDownFor(slotId: string, forTask: string): Promise<string>
  notify(): void
}

export interface TurnHolder {
  key: string
  displayId: string
  app: string
}

export interface PoolWaiter {
  key: string
  taskId: string
  displayId: string
  repo: string
  app: string
  device: string
  platform?: 'android'
  asking: boolean
}

export interface DevicePool {
  limit(): number
  serial<T>(work: () => Promise<T>): Promise<T>
  join(member: PoolMember): void
  live(): BootedSimulator[]
  liveCount(): number
  fresh(caller: PoolMember): Promise<void>
  find(slotId: string): BootedSimulator | undefined
  shutDownFor(slotId: string, forTask: string): Promise<string>
  changed(): void
  readonly line: string[]
  wait(id: string, waiter: PoolWaiter): void
  unwait(id: string): void
  waiters(): PoolWaiter[]
  waiter(id: string): PoolWaiter | undefined
  takeTurn(holder: TurnHolder): boolean
  startTurn(holder: TurnHolder): boolean
  turnFree(key: string): boolean
  endTurn(key: string): void
  holder(): TurnHolder | undefined
  beginBuild(key: string): number
  building(key: string): boolean
}

export const buildTurnMs = 15 * 60_000

export function createDevicePool(options: {
  limit(): number
  oneAtATime(): boolean
  turnMs?: number
  now?: () => number
}): DevicePool {
  const turnMs = options.turnMs ?? buildTurnMs
  const now = options.now ?? Date.now
  const members: PoolMember[] = []
  const line: string[] = []
  const waiters = new Map<string, PoolWaiter>()
  let queue: Promise<unknown> = Promise.resolve()
  let turn: (TurnHolder & { at: number }) | undefined
  const builds = new Map<string, number>()
  const buildsNow = () => {
    for (const [key, at] of builds) if (now() - at >= turnMs) builds.delete(key)
    return builds
  }

  const live = () => members.flatMap((m) => m.live())
  const current = () => {
    if (turn !== undefined && now() - turn.at >= turnMs) {
      turn = undefined
      queueMicrotask(notifyWaiters)
    }
    return turn
  }
  const turnFree = (key: string) => {
    if (!options.oneAtATime()) return true
    const held = current()
    return held === undefined || held.key === key
  }

  const notifyWaiters = () => {
    if (waiters.size === 0) return
    for (const member of members) member.notify()
  }

  const takeTurn = (holder: TurnHolder) => {
    if (!turnFree(holder.key)) return false
    if (!options.oneAtATime()) return true
    const changed = turn?.key !== holder.key
    turn = { ...holder, at: now() }
    if (changed) notifyWaiters()
    return true
  }

  return {
    limit: options.limit,
    serial<T>(work: () => Promise<T>): Promise<T> {
      const next = queue.catch(() => undefined).then(work)
      queue = next
      return next
    },
    join(member) {
      members.push(member)
    },
    live,
    liveCount: () => live().length,
    async fresh(caller) {
      for (const member of members) {
        if (member === caller) await member.fresh()
        else await member.fresh().catch(() => undefined)
      }
    },
    find: (slotId) => live().find((b) => b.udid === slotId),
    shutDownFor(slotId, forTask) {
      const member = members.find((m) => m.owns(slotId))
      if (!member) return Promise.reject(new Error(`No device ${slotId}`))
      return member.shutDownFor(slotId, forTask)
    },
    changed() {
      for (const member of members) member.notify()
    },
    line,
    wait(id, waiter) {
      if (waiters.get(id)?.asking === waiter.asking) return
      waiters.set(id, waiter)
      for (const member of members) member.notify()
    },
    unwait(id) {
      if (!waiters.delete(id)) return
      for (const member of members) member.notify()
    },
    waiters: () => [...waiters.values()],
    waiter: (id) => waiters.get(id),
    takeTurn,
    startTurn: (holder) => !options.oneAtATime() || (line.length === 0 && takeTurn(holder)),
    turnFree,
    endTurn(key) {
      builds.delete(key)
      if (turn?.key !== key) return
      turn = undefined
      notifyWaiters()
    },
    holder: () => (options.oneAtATime() ? current() : undefined),
    beginBuild(key) {
      buildsNow().set(key, now())
      return builds.size
    },
    building: (key) => buildsNow().has(key),
  }
}
