import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

export const loginShellTimeoutMs = 10_000

const marker = '__TED_LOGIN_ENV__'

export interface Environment {
  current(): NodeJS.ProcessEnv
  source(): 'login-shell' | 'fallback'
  reload(): Promise<NodeJS.ProcessEnv>
}

export function fallbackBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? homedir()
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    ...(env.npm_config_prefix ? [path.join(env.npm_config_prefix, 'bin')] : []),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
  ]
}

export function withFallbackPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const added = fallbackBinDirs(env).filter((dir) => !dirs.includes(dir))
  return { ...env, PATH: [...dirs, ...added].join(path.delimiter) }
}

export function readLoginShellEnv(
  options: { shell?: string; base?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<NodeJS.ProcessEnv> {
  const base = options.base ?? process.env
  const shell = options.shell ?? base.SHELL
  if (!shell || !path.isAbsolute(shell)) {
    return Promise.reject(new Error('no login shell is set'))
  }
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const dump = `process.stdout.write(${JSON.stringify(marker)}+JSON.stringify(process.env)+${JSON.stringify(marker)})`
  const command = `${quote(process.execPath)} -e ${quote(dump)}`
  return new Promise((resolve, reject) => {
    const child = execFile(
      shell,
      ['-l', '-i', '-c', command],
      {
        env: { ...base, ELECTRON_RUN_AS_NODE: '1' },
        timeout: options.timeoutMs ?? loginShellTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        cwd: base.HOME ?? homedir(),
      },
      (error, stdout) => {
        const found = stdout.split(marker)
        if (found.length < 3) {
          reject(error ?? new Error('the login shell printed no environment'))
          return
        }
        try {
          const env = JSON.parse(found[1] ?? '') as NodeJS.ProcessEnv
          if (base.ELECTRON_RUN_AS_NODE === undefined) delete env.ELECTRON_RUN_AS_NODE
          resolve(env)
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
    child.stdin?.end()
  })
}

export function createEnvironment(options: {
  loginShell: boolean
  base?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Environment {
  const base = options.base ?? process.env
  let env = withFallbackPath(base)
  let from: 'login-shell' | 'fallback' = 'fallback'
  let loading: Promise<NodeJS.ProcessEnv> | undefined

  async function load(): Promise<NodeJS.ProcessEnv> {
    if (!options.loginShell) {
      env = withFallbackPath(base)
      from = 'fallback'
      return env
    }
    try {
      env = await readLoginShellEnv({
        base,
        ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      })
      from = 'login-shell'
    } catch (error) {
      console.error(
        `couldn’t read the login shell’s environment; using the usual bin folders: ${error instanceof Error ? error.message : String(error)}`,
      )
      env = withFallbackPath(base)
      from = 'fallback'
    }
    return env
  }

  return {
    current: () => env,
    source: () => from,
    reload() {
      loading ??= load().finally(() => {
        loading = undefined
      })
      return loading
    },
  }
}
