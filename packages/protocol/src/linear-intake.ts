import type { LinearIntakeScope } from './linear.ts'
import { reader, type Untyped } from './parse.ts'
import { RequestValidationError } from './validation.ts'

export const maxLinearIntakeTasks = 100

export const linearIntakeStateTypes = ['triage', 'backlog', 'unstarted'] as const

export interface LinearIntakeRequest {
  factory?: string
}

export interface LinearIntakeImported {
  identifier: string
  title: string
  url: string
  task: { taskId: string; displayId: string }
}

export interface LinearIntakeSkipped {
  identifier: string
  url: string
  reason: string
}

export interface LinearIntakeResult {
  scope: LinearIntakeScope
  imported: LinearIntakeImported[]
  skipped: LinearIntakeSkipped[]
  tracked: number
  left: number
  incomplete?: string
  stopped?: string
}

const read = reader((message) => {
  throw new RequestValidationError(400, message)
})

export function parseLinearIntakeRequest(value: Untyped): LinearIntakeRequest {
  if (value === undefined || value === null) return {}
  const body = read.object(value, 'body', 'Send a JSON object')
  const factory = read.optional(body, 'factory', (object, field) =>
    read.string(object, field, 'factory must be a Factory key'),
  )
  if (factory === '') throw new RequestValidationError(400, 'factory must be a Factory key')
  return factory === undefined ? {} : { factory }
}
