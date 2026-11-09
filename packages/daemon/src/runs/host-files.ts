import path from 'node:path'

export interface LaunchFile {
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
  stop: () => void
}) => HostDriver

export type HostRecord =
  | { t: 'start'; v: 1; hostPid: number; agentPid: number | null }
  | { t: 'out'; line: string; at?: string }
  | { t: 'err'; line: string }
  | { t: 'exit'; code: number | null; signal: string | null; error?: string; stopped?: boolean }

export interface GenerationLine {
  forGeneration: number
  line: string
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
    pid: path.join(runDir, 'host.pid'),
  }
}
