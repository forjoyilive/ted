import { type ProfileRequest, profileSeconds } from './slow.ts'
import { RequestValidationError } from './validation.ts'

export function parseProfileRequest(value: unknown): ProfileRequest {
  const seconds = (value as { seconds?: unknown } | null)?.seconds
  if (seconds === undefined) return { seconds: profileSeconds.default }
  const { min, max } = profileSeconds
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < min || seconds > max) {
    throw new RequestValidationError(400, `seconds must be a whole number from ${min} to ${max}`)
  }
  return { seconds }
}
