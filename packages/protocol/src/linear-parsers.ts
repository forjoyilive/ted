import type {
  AllowLinearTeamRequest,
  LinearLookupRequest,
  SaveLinearKeyRequest,
  SetFactoryLinearIntakeRequest,
} from './linear.ts'
import { isLinearIntakeScope, isLinearTeamKey } from './linear.ts'
import { bodyObject, RequestValidationError as HttpError } from './validation.ts'

export function parseSaveLinearKeyRequest(value: unknown): SaveLinearKeyRequest {
  const body = value as Partial<Record<'key' | 'inFile', unknown>> | null
  if (typeof body?.key !== 'string') throw new HttpError(400, 'key must be text')
  if (body.inFile !== undefined && typeof body.inFile !== 'boolean') {
    throw new HttpError(400, 'inFile must be true or false')
  }
  return { key: body.key, inFile: body.inFile === true }
}

export function parseLinearLookupRequest(value: unknown): LinearLookupRequest {
  const body = value as Partial<Record<'url', unknown>> | null
  if (typeof body?.url !== 'string') throw new HttpError(400, 'url must be text')
  return { url: body.url }
}

export function parseAllowLinearTeamRequest(value: unknown): AllowLinearTeamRequest {
  const body = value as Partial<Record<'factoryId' | 'team', unknown>> | null
  if (typeof body?.factoryId !== 'string') throw new HttpError(400, 'factoryId must be text')
  if (typeof body.team !== 'string' || !isLinearTeamKey(body.team)) {
    throw new HttpError(400, 'team must be a Linear team key like ENG')
  }
  return { factoryId: body.factoryId, team: body.team }
}

export function parseSetFactoryLinearIntakeRequest(value: unknown): SetFactoryLinearIntakeRequest {
  const body = bodyObject(value)
  if (body.scope !== null && !isLinearIntakeScope(body.scope)) {
    throw new HttpError(400, 'Choose a valid Linear scope or null for Unscoped')
  }
  return { scope: body.scope }
}
