import type { BusyHold, DeviceWait, RunSlots, SimulatorSlots, Task } from '@ted/protocol'
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

export function slotsDetail(slots: RunSlots | undefined): string | undefined {
  return slots?.busy === undefined ? undefined : busyDetail(slots.busy)
}

function checksPart({ running, waiting }: RunSlots['checks']): string {
  if (running > 0 && waiting > 0)
    return ` · ${plural(running, 'check')} running, ${waiting} waiting`
  if (running > 0) return ` · ${plural(running, 'check')} running`
  if (waiting > 0) return ` · ${plural(waiting, 'check')} waiting`
  return ''
}

function counts(slots: RunSlots): string {
  const queued = slots.queued > 0 ? ` · ${slots.queued} queued` : ''
  return `${slots.working} of ${plural(slots.limit, 'slot')} in use${checksPart(slots.checks)}${queued}`
}

export function runsLine(slots: RunSlots): string {
  return counts(slots)
}

export function nowLine(
  slots: RunSlots,
  simulators?: SimulatorSlots,
  emulators?: SimulatorSlots,
): string {
  const devices = simulators?.supported === true ? simulators : emulators
  const running =
    devices?.supported === true
      ? ` · ${devices.booted.length} of ${devices.limit} simulators and emulators running`
      : ''
  const busy = slots.busy !== undefined ? ` · ${busyHold}` : ''
  return `Now: ${counts(slots)}${busy}${running}`
}

export function deviceWaitText(wait: DeviceWait, machine: string): string {
  if (wait.kind === 'answer') return 'Waiting for your answer'
  if (wait.kind === 'build') return `Waiting for ${wait.displayId}’s build`
  if (wait.kind === 'device') return 'Waiting for a free device'
  if (wait.kind === 'busy') return `Waiting while ${machine} is busy`
  return 'Waiting for the Apps ahead'
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
