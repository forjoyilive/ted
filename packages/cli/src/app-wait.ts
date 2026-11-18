import type { TaskApp } from '@ted/protocol'

export function appWaitLine(
  app: Pick<TaskApp, 'state' | 'kind' | 'waitingOn' | 'asking'>,
  automationRun: boolean,
): string | undefined {
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
