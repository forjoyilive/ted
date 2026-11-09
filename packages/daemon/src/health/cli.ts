import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

export const cliTimeoutMs = 10_000

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (name.includes('/')) return isExecutableFile(name) ? path.resolve(name) : undefined
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export function runCli(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number },
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs ?? cliTimeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
        const code = failure === null ? 0 : typeof failure.code === 'number' ? failure.code : null
        resolve({ code, stdout, stderr, timedOut: failure?.killed === true })
      },
    )
    child.stdin?.end()
  })
}

export function versionIn(text: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1]
}

export function isBelow(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const a = parts(version)
  const b = parts(minimum)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff < 0
  }
  return false
}
