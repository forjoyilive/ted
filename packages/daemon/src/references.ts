import { matchReference } from '@ted/protocol/reference'
import { RequestError } from './errors.ts'

export function resolveReference(
  reference: string,
  ids: readonly string[],
  kind: string,
  missingStatus = 404,
): string {
  const match = matchReference(reference, ids)
  if (match.kind === 'ambiguous')
    throw new RequestError(
      409,
      `More than one ${kind} matches. Use more characters or the full ID.`,
    )
  if (match.kind === 'missing') throw new RequestError(missingStatus, `no such ${kind}`)
  return match.id
}
