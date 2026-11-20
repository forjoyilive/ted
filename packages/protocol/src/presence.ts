import { reader, type Untyped } from './parse.ts'
import { RequestValidationError } from './validation.ts'

export interface PresenceReport {
  away: boolean
}

export function parsePresenceReport(value: Untyped): PresenceReport {
  const read = reader((message) => {
    throw new RequestValidationError(400, message)
  })
  const body = read.object(value, 'presence', 'presence must be an object')
  return { away: read.boolean(body, 'away', 'away must be true or false') }
}
