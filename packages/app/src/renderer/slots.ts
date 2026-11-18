import type { BusyHold, DeviceWait, RunSlots, SimulatorSlots, Task } from '@ted/protocol'
import { busyHold, busyMarks, isChat } from '@ted/protocol/slots'
import { plural } from './words.ts'

export const percent = (share: number) => `${Math.round(share * 100)}%`

export type BusyZone = 'fine' | 'close' | 'over'

export interface BusyMeter {
  name: 'CPU' | 'Memory'
  inUse: number | undefined
  holdAbove: number
  resumeBelow: number
  held: boolean
  zone: BusyZone
  rule: string
}

export function busyMeters(busy: BusyHold): BusyMeter[] {
  const meter = (
    name: BusyMeter['name'],
    inUse: number | undefined,
    marks: { holdAbove: number; resumeBelow: number },
    held: boolean,
  ): BusyMeter => {
    const zone: BusyZone =
      inUse === undefined || inUse < marks.resumeBelow
        ? 'fine'
        : inUse > marks.holdAbove
          ? 'over'
          : 'close'
    const rule = held
      ? `Starts again below ${percent(marks.resumeBelow)}`
      : `${zone === 'close' ? 'Close' : 'Fine'} · waits above ${percent(marks.holdAbove)}`
    return { name, inUse, ...marks, held, zone, rule }
  }
  return [
    meter('CPU', busy.cpuInUse, busyMarks.cpu, busy.cpuHeld === true),
    meter('Memory', busy.memoryInUse, busyMarks.memory, busy.memoryHeld === true),
  ]
}

export function busyReason(busy: BusyHold): string {
  if (busy.cpuHeld && busy.memoryHeld) return 'CPU and memory are both past their marks.'
  return busy.cpuHeld ? 'The CPU is busy.' : 'Memory is nearly full.'
}

export function waitedFor(since: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000)
  if (!(minutes >= 1)) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
}

export function checkedAgo(checkedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 1000))
  return seconds < 60 ? `${seconds} s ago` : `${Math.floor(seconds / 60)} min ago`
}

export function busyDetail(busy: BusyHold): string {
  return busyMeters(busy)
    .filter((meter) => meter.held)
    .map(
      ({ name, inUse, holdAbove, resumeBelow }) =>
        `${name}: ${inUse === undefined ? 'unknown' : percent(inUse)} in use · waits above ${percent(holdAbove)}, starts again below ${percent(resumeBelow)}`,
    )
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
