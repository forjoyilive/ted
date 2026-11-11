import {
  maxShellInputChars,
  type OpenInEditorRequest,
  type ShellInputRequest,
  type ShellSize,
  shellSizeLimits,
} from './shell.ts'
import { RequestValidationError as HttpError } from './validation.ts'

function whole(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`)
  }
  return value
}

export function parseShellSize(body: unknown): ShellSize {
  const given = (body ?? {}) as Partial<Record<keyof ShellSize, unknown>>
  const { min, max } = shellSizeLimits
  return { cols: whole('cols', given.cols, min, max), rows: whole('rows', given.rows, min, max) }
}

const maxPosition = 10_000_000

export function parseOpenInEditorRequest(body: unknown): OpenInEditorRequest {
  if (body === null || body === undefined) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be an object')
  }
  const given = body as Record<string, unknown>
  if (given.snapshot !== undefined && typeof given.snapshot !== 'boolean') {
    throw new HttpError(400, 'snapshot must be a boolean')
  }
  if (given.file === undefined) {
    if (given.line !== undefined || given.column !== undefined || given.snapshot === true) {
      throw new HttpError(400, 'line, column and snapshot need a file')
    }
    return {}
  }
  if (typeof given.file !== 'string') throw new HttpError(400, 'file must be a path')
  return {
    file: given.file,
    ...(given.snapshot !== undefined && { snapshot: given.snapshot }),
    ...(given.line !== undefined && { line: whole('line', given.line, 1, maxPosition) }),
    ...(given.column !== undefined && { column: whole('column', given.column, 1, maxPosition) }),
  }
}

export function parseShellInputRequest(value: unknown): ShellInputRequest {
  const body = value as { data?: unknown } | null
  const data = body?.data
  if (typeof data !== 'string' || data.length === 0 || data.length > maxShellInputChars)
    throw new HttpError(400, `data must be text of 1 to ${maxShellInputChars} characters`)
  return { data }
}
