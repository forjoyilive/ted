import type { BusyHold, RunSlots, SimulatorSlots, Task, TaskStatus } from '@ted/protocol'
import { busyHold, busyMarks, isChat } from '@ted/protocol/slots'
import { plural } from './words.ts'

const percent = (share: number) => `${Math.round(share * 100)}%`

export function busyDetail(busy: BusyHold): string {
  const { load, memory } = busyMarks
  return [
    busy.memoryAvailable !== undefined &&
      `Memory available: ${percent(busy.memoryAvailable)} · waits below ${percent(memory.holdBelow)}, starts again above ${percent(memory.resumeAbove)}`,
    busy.loadRatio !== undefined &&
      `CPU load: ${busy.loadRatio.toFixed(2)} per core · waits at ${load.holdAt}, starts again below ${load.resumeBelow}`,
  ]
    .filter((line) => line !== false)
    .join('\n')
}

export function statusDetail(status: TaskStatus | undefined): string | undefined {
  return status?.kind === 'queued' && 'busy' in status && status.busy !== undefined
    ? busyDetail(status.busy)
    : undefined
}

export function slotsDetail(slots: RunSlots | undefined): string | undefined {
  return slots?.busy === undefined ? undefined : busyDetail(slots.busy)
}

function counts(slots: RunSlots): string {
  const queued = slots.queued > 0 ? ` · ${slots.queued} queued` : ''
  const busy = slots.busy !== undefined ? ` · ${busyHold}` : ''
  return `${plural(slots.working, 'slot')} in use · limit ${slots.limit}${queued}${busy}`
}

export function runsLine(slots: RunSlots): string {
  return counts(slots)
}

export function nowLine(
  slots: RunSlots,
  simulators?: SimulatorSlots,
  emulators?: SimulatorSlots,
): string {
  const booted =
    simulators?.supported === true
      ? ` · ${simulators.booted.length} of ${simulators.limit} simulator${simulators.limit === 1 ? '' : 's'} booted`
      : ''
  const running =
    emulators?.supported === true
      ? ` · ${emulators.booted.length} of ${emulators.limit} emulator${emulators.limit === 1 ? '' : 's'} running`
      : ''
  return `Now: ${counts(slots)}${booted}${running}`
}

export function factoryCapLine(slots: RunSlots | undefined, factoryId: string): string | undefined {
  const factory = slots?.factories.find((f) => f.factoryId === factoryId)
  return factory && factory.working >= factory.cap
    ? `${factory.working} of ${factory.cap} working`
    : undefined
}

export function slotCount(runs: number): string {
  return runs === 0 ? '1 slot' : plural(runs, 'Run')
}

export function startSplit(
  slots: RunSlots,
  tasks: readonly Pick<Task, 'factoryId'>[],
): { now: number; wait: number } {
  let working = slots.working
  const caps = new Map(slots.factories.map((f) => [f.factoryId, f.cap]))
  const byFactory = new Map(slots.factories.map((f) => [f.factoryId, f.working]))
  const take = (factoryId: string) => {
    working++
    byFactory.set(factoryId, (byFactory.get(factoryId) ?? 0) + 1)
  }
  const starts = (factoryId: string) => {
    if (working >= slots.limit) return false
    if (slots.busy !== undefined && working > 0) return false
    const cap = caps.get(factoryId)
    if (cap !== undefined && (byFactory.get(factoryId) ?? 0) >= cap) return false
    take(factoryId)
    return true
  }
  for (const entry of slots.queue) {
    if (isChat(entry.kind)) continue
    if (entry.kind === 'automation' || entry.kind === 'automation-draft') take(entry.factoryId)
    else starts(entry.factoryId)
  }
  const now = tasks.filter((task) => starts(task.factoryId)).length
  return { now, wait: tasks.length - now }
}

export function startWaitLine(split: { now: number; wait: number }): string | undefined {
  const { now, wait } = split
  if (wait === 0) return undefined
  if (now === 0) return wait === 1 ? 'It waits for a Run slot' : `All ${wait} wait for a Run slot`
  return `${now} ${now === 1 ? 'starts' : 'start'} now, ${wait} ${wait === 1 ? 'waits' : 'wait'} for a Run slot`
}
