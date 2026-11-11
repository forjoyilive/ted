import path from 'node:path'
import type { PermissionMode } from '@ted/protocol'
import type { LaunchAuthority } from './launch-authority.ts'

export interface LaunchFile {
  launchId?: string
  permissions?: PermissionMode
  authority?: LaunchAuthority
  command: string
  args: string[]
  cwd: string
  input: string
  driver?: string
  inputFrom?: number
}

export interface HostDriver {
  onLine(line: string): void
  onInput?(line: string): void
}

export type DriveAgent = (io: {
  input: string
  send: (line: string) => void
  emit?: (line: string) => void
  stop: () => void
}) => HostDriver

export const hostProtocol = 6
export const oldestHostProtocol = 6

export type HostRecord =
  | {
      t: 'start'
      v: number
      hostPid: number
      agentPid: number | null
      permissions?: PermissionMode
    }
  | { t: 'out'; line: string; at?: string }
  | { t: 'err'; line: string }
  | { t: 'exit'; code: number | null; signal: string | null; error?: string; stopped?: boolean }

export interface GenerationLine {
  forGeneration: number
  line: string
}

export interface QueuedInput extends GenerationLine {
  deliveryIds: string[]
  text: string
  outputFrom: number
}

export function readQueuedInput(line: string): QueuedInput | undefined {
  const tagged = readGenerationLine(line)
  if (!tagged) return undefined
  const value = JSON.parse(line) as Partial<QueuedInput>
  return Array.isArray(value.deliveryIds) &&
    value.deliveryIds.every((id) => typeof id === 'string') &&
    typeof value.text === 'string' &&
    typeof value.outputFrom === 'number' &&
    Number.isFinite(value.outputFrom) &&
    value.outputFrom >= 0
    ? { ...tagged, deliveryIds: value.deliveryIds, text: value.text, outputFrom: value.outputFrom }
    : undefined
}

export const forGeneration = (generation: number, line: string) =>
  JSON.stringify({ forGeneration: generation, line } satisfies GenerationLine)

export function readGenerationLine(line: string): GenerationLine | undefined {
  if (!line.startsWith('{"forGeneration":')) return undefined
  try {
    const parsed = JSON.parse(line) as Partial<GenerationLine>
    return typeof parsed.forGeneration === 'number' && typeof parsed.line === 'string'
      ? { forGeneration: parsed.forGeneration, line: parsed.line }
      : undefined
  } catch {
    return undefined
  }
}

export function runFiles(runDir: string) {
  return {
    launch: path.join(runDir, 'launch.json'),
    log: path.join(runDir, 'host.log'),
    lock: path.join(runDir, 'host.lock'),
    input: path.join(runDir, 'input.jsonl'),
    promptInputs: path.join(runDir, 'prompt-inputs.jsonl'),
    queued: path.join(runDir, 'queued'),
    pid: path.join(runDir, 'host.pid'),
    env: path.join(runDir, 'env.json'),
  }
}
