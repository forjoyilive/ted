import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'
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
  const { code, syscall, stack } = (error ?? {}) as NodeJS.ErrnoException
  if (syscall === 'setTypeOfService') return true
  if (code === 'ERR_OUT_OF_RANGE' && stack?.includes('getSystemErrorName')) return true
  return code !== undefined && connectionCodes.has(code)
}

export function handleUncaught(error: unknown, sink: UncaughtSink): void {
  const connection = isConnectionError(error)
  sink.log(connection ? 'Lost a connection:' : 'Uncaught exception:', error)
  if (connection || sink.hidden) return
  sink.show(
    'Ted hit an unexpected error',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
}

export function fileLog(file: string): (...args: unknown[]) => void {
  return (...args) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      appendFileSync(file, `${new Date().toISOString()} ${format(...args)}\n`, { mode: 0o600 })
    } catch {}
  }
}

export function startupLog(file: string, enabled: boolean): (stage: string) => void {
  const started = performance.now()
  const write = fileLog(file)
  let remaining = 48
  return (stage) => {
    if (!enabled || remaining-- <= 0) return
    write(JSON.stringify({ pid: process.pid, ms: performance.now() - started, stage }))
  }
}

export function ignoreBrokenPipes(
  streams: NodeJS.EventEmitter[],
  onBroken: (error: NodeJS.ErrnoException) => void,
): void {
  for (const stream of streams) stream.on('error', onBroken)
}

export function watchParent(
  onGone: () => void,
  { ppid = () => process.ppid, intervalMs = 1000 } = {},
): () => void {
  const parent = ppid()
  const timer = setInterval(() => {
    if (ppid() === parent) return
    clearInterval(timer)
    onGone()
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
