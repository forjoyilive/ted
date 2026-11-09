import { execFile } from 'node:child_process'

export const cliTimeoutMs = 10_000

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
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
