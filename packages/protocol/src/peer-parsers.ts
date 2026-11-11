import type { SendPeerMessage } from './peers.ts'
import { bodyObject, RequestValidationError as HttpError } from './validation.ts'

export function parseSendPeerMessage(value: unknown): SendPeerMessage {
  const body = bodyObject(value)
  if (typeof body.operation !== 'string' || typeof body.text !== 'string')
    throw new HttpError(400, 'operation and text are required')
  return { operation: body.operation, text: body.text }
}
