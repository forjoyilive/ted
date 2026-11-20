import { reader, type Untyped } from './parse.ts'

export const phoneProblemTextMax = 500
export const phoneProblemsMax = 50

export interface PhoneProblem {
  id: string
  factory?: string
  text: string
  raisedAt: string
}

export interface PhoneProblemsBody {
  problems: PhoneProblem[]
}

const read = reader()

export function parsePhoneProblem(value: Untyped): PhoneProblem {
  const object = read.object(value, 'problem')
  const factory = read.optional(object, 'factory', read.string)
  return {
    id: read.string(object, 'id'),
    ...(factory !== undefined && { factory }),
    text: read.string(object, 'text'),
    raisedAt: read.string(object, 'raisedAt'),
  }
}

export function parsePhoneProblemsBody(value: Untyped): PhoneProblemsBody {
  const object = read.object(value, 'body')
  return { problems: read.list(object, 'problems').map(parsePhoneProblem) }
}
