import type { DraftLineCommentRequest, EditLineCommentRequest, LineAnchor } from './changes.ts'
import { RequestValidationError as HttpError } from './validation.ts'

export const maxLineCommentLength = 20_000
export function parseDraftLineCommentRequest(body: unknown): DraftLineCommentRequest {
  const request = (body ?? {}) as Partial<DraftLineCommentRequest>
  const text = typeof request.body === 'string' ? request.body.trim() : ''
  if (typeof request.repo !== 'string' || request.repo === '') {
    throw new HttpError(400, 'repo is required')
  }
  if (typeof request.path !== 'string' || request.path === '') {
    throw new HttpError(400, 'path is required')
  }
  const from = anchor(request.from, 'from')
  const to = request.to === undefined ? undefined : anchor(request.to, 'to')
  return { repo: request.repo, path: request.path, from, ...(to && { to }), body: lineText(text) }
}

function lineText(text: unknown): string {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') throw new HttpError(400, 'a line comment needs some text')
  if (trimmed.length > maxLineCommentLength) {
    throw new HttpError(400, `a line comment is limited to ${maxLineCommentLength} characters`)
  }
  return trimmed
}

function anchor(value: unknown, name: string): LineAnchor {
  const given = (value ?? {}) as Record<string, unknown>
  const line = (key: 'old' | 'new') => {
    const n = given[key]
    if (n === undefined) return undefined
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new HttpError(400, `${name}.${key} must be a line number`)
    }
    return n
  }
  const old = line('old')
  const added = line('new')
  if (old === undefined && added === undefined) {
    throw new HttpError(400, `${name} needs an old or new line number`)
  }
  return { ...(old !== undefined && { old }), ...(added !== undefined && { new: added }) }
}

export function parseEditLineCommentRequest(value: unknown): EditLineCommentRequest {
  const body = value as { body?: unknown } | null
  return { body: lineText(body?.body) }
}
