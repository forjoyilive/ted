import type { RunSlots, SimulatorSlots } from '@ted/protocol'
import { busyHold } from '@ted/protocol/slots'
import { plural } from './words.ts'

function counts(slots: RunSlots): string {
  const queued = slots.queued > 0 ? ` · ${slots.queued} queued` : ''
  const busy = slots.heldForLoad ? ` · ${busyHold}` : ''
  return `${plural(slots.working, 'slot')} in use · limit ${slots.limit}${queued}${busy}`
}

export function runsLine(slots: RunSlots): string {
  return counts(slots)
}

export function nowLine(slots: RunSlots, simulators?: SimulatorSlots): string {
  const booted =
    simulators?.supported === true
      ? ` · ${simulators.booted.length} of ${simulators.limit} simulator${simulators.limit === 1 ? '' : 's'} booted`
      : ''
  return `Now: ${counts(slots)}${booted}`
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
