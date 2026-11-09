import { execFile } from 'node:child_process'
import { redactSecrets } from '../redact.ts'

export type GhErrorKind = 'missing' | 'auth' | 'rate-limit' | 'failed'

export class GhError extends Error {
  readonly kind: GhErrorKind
  constructor(kind: GhErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export interface GhRunOptions {
  host?: string
  cwd?: string
  input?: string
  timeoutMs?: number
}

export interface Gh {
  run(args: readonly string[], options?: GhRunOptions): Promise<string>
  api(path: string, options?: { host?: string; method?: string; body?: unknown }): Promise<unknown>
  graphql(
    query: string,
    variables?: Record<string, unknown>,
    options?: { host?: string },
  ): Promise<unknown>
}

export interface RateLimitWatch {
  limited(host: string, since: Date, retryAt: Date): void
  cleared(host: string): void
}

export interface GhOptions {
  locate(): Promise<{ bin: string; env: NodeJS.ProcessEnv }>
  onAuthError?: (host: string) => void
  rateLimit?: RateLimitWatch
  now?: () => Date
}

const defaultHost = 'github.com'
const firstBackoffMs = 60_000
const maxBackoffMs = 15 * 60_000
const maxOutput = 32 * 1024 * 1024

export function createGh(options: GhOptions): Gh {
  const now = options.now ?? (() => new Date())
  const limits = new Map<string, { since: Date; retryAt: Date; backoffMs: number }>()

  async function run(args: readonly string[], runOptions: GhRunOptions = {}): Promise<string> {
    checkAllowed(args)
    const host = runOptions.host ?? defaultHost
    const limit = limits.get(host)
    if (limit && now() < limit.retryAt) {
      throw new GhError('rate-limit', `GitHub rate limit on ${host}`)
    }
    const { bin, env } = await options.locate()
    try {
      const stdout = await runFile(bin, args, {
        env: {
          ...env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          ...(runOptions.host !== undefined && { GH_HOST: runOptions.host }),
        },
        ...(runOptions.cwd !== undefined && { cwd: runOptions.cwd }),
        ...(runOptions.input !== undefined && { input: runOptions.input }),
        timeoutMs: runOptions.timeoutMs ?? 60_000,
      })
      if (limits.delete(host)) options.rateLimit?.cleared(host)
      return stdout
    } catch (error) {
      const failure = classify(error, args)
      if (failure.kind === 'rate-limit') {
        const backoffMs = limit ? Math.min(limit.backoffMs * 2, maxBackoffMs) : firstBackoffMs
        const next = {
          since: limit?.since ?? now(),
          retryAt: new Date(now().getTime() + backoffMs),
          backoffMs,
        }
        limits.set(host, next)
        options.rateLimit?.limited(host, next.since, next.retryAt)
      }
      if (failure.kind === 'auth') options.onAuthError?.(host)
      throw failure
    }
  }

  return {
    run,
    async api(path, { host, method = 'GET', body } = {}) {
      const args = ['api', '--method', method, path]
      const out = await run(body === undefined ? args : [...args, '--input', '-'], {
        ...(host !== undefined && { host }),
        ...(body !== undefined && { input: JSON.stringify(body) }),
      })
      return out.trim() === '' ? undefined : JSON.parse(out)
    },
    async graphql(query, variables = {}, { host } = {}) {
      const out = await run(['api', 'graphql', '--input', '-'], {
        ...(host !== undefined && { host }),
        input: JSON.stringify({ query, variables }),
      })
      return JSON.parse(out)
    },
  }
}

const authStatus = ['auth', 'status', '--json', 'hosts']

function checkAllowed(args: readonly string[]): void {
  if (args[0] !== 'auth') return
  const extra = args.slice(authStatus.length)
  const isStatus = authStatus.every((arg, i) => args[i] === arg)
  const hostOnly = extra.length === 0 || (extra.length === 2 && extra[0] === '--hostname')
  if (!isStatus || !hostOnly) {
    throw new GhError('failed', 'TED runs only `gh auth status --json hosts` itself')
  }
}

function runFile(
  bin: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: maxOutput,
        ...(options.cwd !== undefined && { cwd: options.cwd }),
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }))
        else resolve(stdout)
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
  })
}

function classify(error: unknown, args: readonly string[]): GhError {
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT' || code === 'EACCES') {
    return new GhError('missing', 'GitHub CLI not found')
  }
  const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
  const message = redactSecrets(`gh ${args[0]} failed${stderr ? `: ${stderr}` : ''}`)
  if (/rate limit/i.test(stderr)) return new GhError('rate-limit', message)
  if (/HTTP 401|Bad credentials|gh auth login|not logged in|authentication/i.test(stderr)) {
    return new GhError('auth', message)
  }
  return new GhError('failed', message)
}
