import type { TaskApp } from '@ted/protocol'
import { deviceBuilding } from '@ted/protocol/app'

export function appWaitLine(
  app: Pick<
    TaskApp,
    'name' | 'state' | 'kind' | 'waitingOn' | 'asking' | 'builtAt' | 'notReady' | 'simulator'
  >,
  automationRun: boolean,
): string | undefined {
  if (deviceBuilding(app)) {
    const on = app.simulator === undefined ? '' : ` on ${app.simulator.device}`
    return `Waiting for ${app.name} to finish building and launch${on}…`
  }
  if (app.state !== 'waiting') return undefined
  if (app.waitingOn !== undefined) {
    return `Waiting for ${app.waitingOn.displayId}’s ${app.waitingOn.app} to finish building…`
  }
  if (automationRun) {
    return `Waiting for ${app.kind === 'android-emulator' ? 'an emulator' : 'a simulator'} slot to free up…`
  }
  if (app.asking === true) {
    return 'Every simulator and emulator slot is taken, so Ted asked the human which one to shut down. Waiting for an answer…'
  }
  return undefined
}
