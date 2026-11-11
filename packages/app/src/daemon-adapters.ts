import { type DaemonClient, DaemonRequestError } from '@ted/protocol'

// Electron serializes errors without their status, so handle missing app data before IPC.
function missingAsNull<T>(request: Promise<T>): Promise<T | null> {
  return request.catch((error: unknown) => {
    if (error instanceof DaemonRequestError && error.status === 404) return null
    throw error
  })
}

export function taskBrief(client: DaemonClient, taskId: string) {
  return missingAsNull(client.getBrief(taskId))
}

export function getAutomation(client: DaemonClient, id: string) {
  return missingAsNull(client.getAutomation(id))
}
