import { isString, reader, type Untyped } from './parse.ts'

export const crashSources = ['uncaught', 'rejection', 'render', 'gone'] as const
export type CrashSource = (typeof crashSources)[number]

export const rendererCrashSources = ['uncaught', 'rejection', 'render'] as const

export interface Crash {
  source: CrashSource
  type: string
  message: string
  stack?: string
}

export const maxCrashType = 200
export const maxCrashText = 16_384

export function crashFrom(source: CrashSource, error: Untyped): Crash {
  if (error instanceof Error) {
    return {
      source,
      type: error.name === '' ? 'Error' : error.name,
      message: error.message,
      ...(isString(error.stack) && { stack: error.stack }),
    }
  }
  return { source, type: 'NonError', message: isString(error) ? error : describe(error) }
}

function describe(value: Untyped): string {
  try {
    return String(value)
  } catch {
    return 'A value that couldn’t be shown'
  }
}

export function parseRendererCrash(body: Untyped): Crash {
  const read = reader()
  const input = read.object(body, 'crash')
  const stack = read.optional(input, 'stack', (object, field) => read.string(object, field))
  return {
    source: read.oneOf(input, 'source', rendererCrashSources),
    type: read.string(input, 'type').slice(0, maxCrashType),
    message: read.string(input, 'message').slice(0, maxCrashText),
    ...(stack !== undefined && { stack: stack.slice(0, maxCrashText) }),
  }
}
