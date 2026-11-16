import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { type PlanWindow, type PlanWindowKind, tedVersion } from '@ted/protocol'
import { fromEpoch } from './agent.ts'

const windowByMinutes: Record<number, PlanWindowKind> = { 300: 'five-hour', 10080: 'weekly' }

function planWindow(value: unknown, fallback: PlanWindowKind): PlanWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { usedPercent, windowDurationMins, resetsAt } = value as Record<string, unknown>
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return undefined
  const window =
    typeof windowDurationMins === 'number' ? windowByMinutes[windowDurationMins] : fallback
  if (window === undefined) return undefined
  const reset = fromEpoch(resetsAt)
  return {
    window,
    percent: Math.min(100, Math.max(0, usedPercent)),
    ...(reset !== undefined && { resetsAt: reset }),
  }
}

export function codexPlanWindows(limits: unknown): PlanWindow[] | undefined {
  if (typeof limits !== 'object' || limits === null) return undefined
  const { primary, secondary } = limits as { primary?: unknown; secondary?: unknown }
  if (primary === undefined && secondary === undefined) return undefined
  for (const value of [primary, secondary]) {
    if (value === undefined || value === null) continue
    if (
      typeof value !== 'object' ||
      !('usedPercent' in value) ||
      typeof value.usedPercent !== 'number' ||
      !Number.isFinite(value.usedPercent)
    )
      return undefined
  }
  return [planWindow(primary, 'five-hour'), planWindow(secondary, 'weekly')].filter(
    (window): window is PlanWindow => window !== undefined,
  )
}

export function readCodexPlanUsage(options: {
  binary: string
  env: NodeJS.ProcessEnv
  cwd: string
  signal: AbortSignal
  timeoutMs?: number
}): Promise<PlanWindow[] | undefined> {
  if (options.signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const child = spawn(options.binary, ['app-server'], {
      env: options.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,
    })
    let result: PlanWindow[] | undefined
    let finished = false
    const finish = (windows?: PlanWindow[]) => {
      if (finished) return
      finished = true
      result = windows
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      child.stdin.destroy()
      child.stdout.destroy()
    }
    const abort = () => finish()
    const timer = setTimeout(abort, options.timeoutMs ?? 10_000)
    timer.unref()
    options.signal.addEventListener('abort', abort, { once: true })
    const lines = createInterface({ input: child.stdout })
    let received = 0
    child.stdout.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > 1024 * 1024) finish()
    })
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.on('error', abort)
    child.on('error', abort)
    child.on('close', () => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      lines.close()
      resolve(result)
    })
    lines.on('line', (line) => {
      if (finished) return
      try {
        const message = JSON.parse(line)
        if (message.id === 1) {
          if (message.error !== undefined || message.result === undefined) return finish()
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        } else if (message.id === 2) {
          finish(
            message.error === undefined ? codexPlanWindows(message.result?.rateLimits) : undefined,
          )
        }
      } catch {
        finish()
      }
    })
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'ted', title: 'Ted', version: tedVersion },
        capabilities: null,
      },
    })
  })
}
