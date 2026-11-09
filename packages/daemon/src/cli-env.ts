import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const marker = '__TED_LOGIN_ENV__'
const timeoutMs = 10_000

export async function readLoginEnv(
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const shell = base.SHELL
  if (shell && path.isAbsolute(shell)) {
    const read = await shellEnv(shell, base).catch(() => undefined)
    if (read?.PATH) return { ...read, GIT_TERMINAL_PROMPT: '0' }
  }
  return { ...base, PATH: withFallbackDirs(base.PATH), GIT_TERMINAL_PROMPT: '0' }
}

function shellEnv(shell: string, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      shell,
      ['-l', '-i', '-c', `printf '%s' '${marker}'; /usr/bin/env -0`],
      { env: base, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        const start = stdout.indexOf(marker)
        if (start === -1) return reject(error ?? new Error('no environment from the login shell'))
        const env: NodeJS.ProcessEnv = {}
        for (const entry of stdout.slice(start + marker.length).split('\0')) {
          const at = entry.indexOf('=')
          if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1)
        }
        resolve(env)
      },
    )
    child.stdin?.end()
  })
}

function withFallbackDirs(current: string | undefined): string {
  const home = homedir()
  const fallback = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/usr/bin',
    '/bin',
  ]
  const dirs = [...(current ?? '').split(path.delimiter), ...fallback].filter((d) => d !== '')
  return [...new Set(dirs)].join(path.delimiter)
}

export async function findBin(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue
    const candidate = path.join(dir, name)
    const found = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    )
    if (found) return candidate
  }
  return undefined
}
