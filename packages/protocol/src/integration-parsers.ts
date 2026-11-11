import type { RunFixRequest } from './integrations.ts'
import { integrationFixes } from './integrations.ts'
import { RequestValidationError as HttpError } from './validation.ts'

export function parseRunFixRequest(value: unknown): RunFixRequest {
  const body = value as Partial<RunFixRequest> | null
  const fix = integrationFixes.find((f) => f === body?.fix)
  if (fix === undefined) throw new HttpError(400, `fix must be ${integrationFixes.join(', ')}`)
  const host = body?.host
  if (host !== undefined && typeof host !== 'string') {
    throw new HttpError(400, 'host must be text')
  }
  return { fix, ...(host !== undefined && { host }) }
}
