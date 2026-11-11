import type { RestoreBackupRequest, ShutdownRequest } from './data.ts'

export function parseRestoreBackupRequest(value: unknown): RestoreBackupRequest {
  const body = value as Partial<RestoreBackupRequest> | null
  return {
    name: typeof body?.name === 'string' ? body.name : '',
    stopRuns: body?.stopRuns === true,
  }
}
export function parseShutdownRequest(value: unknown): ShutdownRequest {
  const body = value as Partial<ShutdownRequest> | null
  return { keepRuns: body?.keepRuns === true }
}
