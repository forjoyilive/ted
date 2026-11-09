import { DaemonUnreachableError } from '@ted/protocol'

const connectionCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

export interface UncaughtSink {
  hidden: boolean
  log: (...args: unknown[]) => void
  show: (title: string, detail: string) => void
}

export function isConnectionError(error: unknown): boolean {
  if (error instanceof DaemonUnreachableError) return true
  const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException
  return syscall === 'setTypeOfService' || (code !== undefined && connectionCodes.has(code))
}

export function handleUncaught(error: unknown, sink: UncaughtSink): void {
  const connection = isConnectionError(error)
  sink.log(connection ? 'Lost a connection:' : 'Uncaught exception:', error)
  if (connection || sink.hidden) return
  sink.show(
    'TED hit an unexpected error',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
}
