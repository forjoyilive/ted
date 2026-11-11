import type { AppRef, RecordAppRequest, StartAppRequest } from './app.ts'
import { RequestValidationError as HttpError } from './validation.ts'

export function parseAppRef(body: unknown): AppRef {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  if (name === '') throw new HttpError(400, 'name the App')
  if (fields.repo !== undefined && typeof fields.repo !== 'string') {
    throw new HttpError(400, 'repo must be a repo name')
  }
  return {
    name,
    ...(typeof fields.repo === 'string' && fields.repo !== '' && { repo: fields.repo }),
  }
}

export function parseStartAppRequest(body: unknown): StartAppRequest {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (fields.shutDown !== undefined && typeof fields.shutDown !== 'string') {
    throw new HttpError(400, 'shutDown must name a simulator')
  }
  if (fields.reason !== undefined && typeof fields.reason !== 'string') {
    throw new HttpError(400, 'reason must be text')
  }
  const reason = typeof fields.reason === 'string' ? fields.reason.trim().slice(0, 500) : ''
  return {
    ...parseAppRef(body),
    ...(typeof fields.shutDown === 'string' && { shutDown: fields.shutDown }),
    ...(reason !== '' && { reason }),
  }
}

export function parseRecordAppRequest(body: unknown): RecordAppRequest {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (fields.action !== 'start' && fields.action !== 'stop') {
    throw new HttpError(400, 'action must be start or stop')
  }
  return { ...parseAppRef(body), action: fields.action }
}
