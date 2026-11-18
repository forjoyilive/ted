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
  takeTurn(holder: TurnHolder): boolean
  startTurn(holder: TurnHolder): boolean
  turnFree(key: string): boolean
  endTurn(key: string): void
  holder(): TurnHolder | undefined
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
  let queue: Promise<unknown> = Promise.resolve()
  let turn: (TurnHolder & { at: number }) | undefined

  const live = () => members.flatMap((m) => m.live())
  const current = () => {
    if (turn !== undefined && now() - turn.at >= turnMs) turn = undefined
    return turn
  }
  const turnFree = (key: string) => {
    if (!options.oneAtATime()) return true
    const held = current()
    return held === undefined || held.key === key
  }

  const takeTurn = (holder: TurnHolder) => {
    if (!turnFree(holder.key)) return false
    if (options.oneAtATime()) turn = { ...holder, at: now() }
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
    takeTurn,
    startTurn: (holder) => !options.oneAtATime() || (line.length === 0 && takeTurn(holder)),
    turnFree,
    endTurn(key) {
      if (turn?.key === key) turn = undefined
    },
    holder: () => (options.oneAtATime() ? current() : undefined),
  }
}
