import { type DaemonClient, DaemonRequestError } from '@ted/protocol'

// Electron serializes errors without their status, so handle a missing brief before IPC.
export function taskBrief(client: DaemonClient, taskId: string) {
  return client.getBrief(taskId).catch((error: unknown) => {
    if (error instanceof DaemonRequestError && error.status === 404) return null
    throw error
  })
}
