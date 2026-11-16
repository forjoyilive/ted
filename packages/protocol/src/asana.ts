import { bodyObject, RequestValidationError } from './validation.ts'

export const asanaScopes = [
  'attachments:read',
  'projects:read',
  'stories:read',
  'stories:write',
  'tasks:read',
  'tasks:write',
  'users:read',
  'workspaces:read',
]

export interface AsanaConfiguration {
  clientId: string
  clientSecret: string
  inFile: boolean
}

export interface AsanaStatus {
  state: 'unconfigured' | 'disconnected' | 'authorizing' | 'connected' | 'error'
  configured: boolean
  redirectUri: string
  storedIn?: 'keyring' | 'file'
  user?: { gid: string; name: string; email: string }
  extraScopes?: string[]
  error?: string
  storageProblem?: 'locked' | 'no-keyring'
}

export function parseAsanaConfiguration(value: unknown): AsanaConfiguration {
  const body = bodyObject(value)
  if (typeof body.clientId !== 'string' || !/^[0-9]{1,100}$/.test(body.clientId)) {
    throw new RequestValidationError(400, 'Asana client ID must contain digits')
  }
  if (typeof body.clientSecret !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(body.clientSecret)) {
    throw new RequestValidationError(400, 'Choose an Asana configuration with a client secret')
  }
  if (body.inFile !== undefined && typeof body.inFile !== 'boolean') {
    throw new RequestValidationError(400, 'inFile must be true or false')
  }
  return { clientId: body.clientId, clientSecret: body.clientSecret, inFile: body.inFile === true }
}
