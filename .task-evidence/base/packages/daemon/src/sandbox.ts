import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export interface SandboxScope {
  writable: readonly string[]
  readable: readonly string[]
  tmp: string
  cache: string
}

export interface Sandboxed {
  argv: [string, ...string[]]
  env: Record<string, string>
}

export interface Sandbox {
  problem(): Promise<string | undefined>
  wrap(argv: readonly [string, ...string[]], scope: SandboxScope): Promise<Sandboxed>
}

export class SandboxUnavailable extends Error {}

const probeTimeoutMs = 10_000

export function createSandbox(options: {
  tedHome: string
  env: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  program?: string
}): Sandbox {
  const platform = options.platform ?? process.platform
  let ready: string | undefined

  async function program(): Promise<string | undefined> {
    if (options.program !== undefined) return options.program
    if (platform === 'darwin') return '/usr/bin/sandbox-exec'
    return onPath('bwrap', options.env().PATH)
  }

  async function problem(): Promise<string | undefined> {
    if (ready !== undefined) return undefined
    if (platform !== 'darwin' && platform !== 'linux') {
      return `TED can’t sandbox commands on ${platform}`
    }
    const found = await program()
    if (found === undefined) {
      return 'bwrap (bubblewrap) isn’t installed, so TED can’t sandbox Checks and Apps or worktree setup and teardown. Install the bubblewrap package.'
    }
    const args =
      platform === 'darwin'
        ? ['-p', '(version 1)(allow default)', '/usr/bin/true']
        : ['--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev'].concat([
            '--proc',
            '/proc',
            'true',
          ])
    const result = await probe(found, args, options.env())
    if (result.ok) {
      ready = found
      return undefined
    }
    const name = platform === 'darwin' ? 'sandbox-exec' : 'bwrap'
    return `${name} doesn’t work on this machine, so TED can’t sandbox Checks and Apps or worktree setup and teardown${result.output === '' ? '' : `: ${result.output}`}`
  }

  return {
    problem,
    async wrap(argv, scope) {
      const why = await problem()
      if (why !== undefined || ready === undefined) throw new SandboxUnavailable(why)
      const paths = await sandboxPaths(platform, options.tedHome, scope)
      const env = options.env()
      const cache = (name: string) => path.join(paths.cache, name)
      const added: Record<string, string> = {
        TMPDIR: paths.tmp,
        TMP: paths.tmp,
        TEMP: paths.tmp,
        XDG_CACHE_HOME: paths.cache,
        COREPACK_HOME: corepackHome(env),
        npm_config_cache: cache('npm'),
        npm_config_store_dir: cache('pnpm-store'),
        YARN_CACHE_FOLDER: cache('yarn'),
        PIP_CACHE_DIR: cache('pip'),
        GOCACHE: cache('go-build'),
        GOMODCACHE: cache('go-mod'),
      }
      return platform === 'darwin'
        ? { argv: [ready, ...seatbeltArgs(paths), ...argv], env: added }
        : { argv: [ready, ...bwrapArgs(paths, env), '--', ...argv], env: added }
    },
  }
}

interface SandboxPaths {
  writable: string[]
  readable: string[]
  tmp: string
  cache: string
  tedHome: string
  sharedTmp?: string
}

async function sandboxPaths(
  platform: NodeJS.Platform,
  tedHome: string,
  scope: SandboxScope,
): Promise<SandboxPaths> {
  const daemonTmp = await real(tmpdir())
  const sharedTmp = platform === 'darwin' ? '/private/tmp' : undefined
  const home = await real(tedHome)
  const given = path.resolve(tedHome)
  const plain = (dir: string, create = false) => plainFolder(home, given, dir, create)
  const writable = await Promise.all(scope.writable.map((dir) => plain(dir)))
  const readable = await Promise.all(scope.readable.map((dir) => plain(dir)))
  const tmp = await plain(scope.tmp)
  const cache = await plain(scope.cache, true)
  const open = [...writable, tmp, cache]
  for (const dir of [...open, ...readable]) {
    const outer = open.find((other) => other !== dir && inside(other, dir))
    if (outer !== undefined) {
      throw new SandboxUnavailable(
        `${dir} sits inside ${outer}, so TED won’t sandbox a command with both open`,
      )
    }
  }
  return {
    writable,
    readable,
    tmp,
    cache,
    tedHome: home,
    ...(sharedTmp !== undefined && !inside(sharedTmp, daemonTmp) && { sharedTmp }),
  }
}

function seatbeltArgs(paths: SandboxPaths): string[] {
  const params: string[] = []
  const param = (prefix: string, values: readonly string[]) =>
    values
      .map((value, i) => {
        params.push('-D', `${prefix}${i}=${value}`)
        return `(subpath (param "${prefix}${i}"))`
      })
      .join(' ')
  const own = [...paths.writable, paths.tmp, paths.cache]
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") ${paths.sharedTmp === undefined ? '' : `(subpath "${paths.sharedTmp}")`})`,
    `(deny file-write* file-read-data file-read-xattr ${param('H', [paths.tedHome])})`,
    `(allow file-read-data file-read-xattr ${param('R', [...paths.readable, ...own])})`,
    `(allow file-write* ${param('W', own)})`,
    '(deny appleevent-send)',
    '(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd") (global-name "com.apple.CoreServices.coreservicesd"))',
    '(deny user-preference-write)',
  ].join('\n')
  return [...params, '-p', profile]
}

function bwrapArgs(paths: SandboxPaths, env: NodeJS.ProcessEnv): string[] {
  const runtime = env.XDG_RUNTIME_DIR?.startsWith('/') ? [env.XDG_RUNTIME_DIR] : []
  return [
    '--die-with-parent',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--bind',
    paths.tmp,
    '/tmp',
    ...runtime.flatMap((dir) => ['--tmpfs', dir]),
    '--tmpfs',
    paths.tedHome,
    ...paths.readable.flatMap((dir) => ['--ro-bind', dir, dir]),
    ...[...paths.writable, paths.tmp, paths.cache].flatMap((dir) => ['--bind', dir, dir]),
    '--unsetenv',
    'DBUS_SESSION_BUS_ADDRESS',
  ]
}

function corepackHome(env: NodeJS.ProcessEnv): string {
  if (env.COREPACK_HOME?.startsWith('/')) return env.COREPACK_HOME
  const cache = env.XDG_CACHE_HOME?.startsWith('/')
    ? env.XDG_CACHE_HOME
    : path.join(env.HOME?.startsWith('/') ? env.HOME : homedir(), '.cache')
  return path.join(cache, 'node', 'corepack')
}

async function plainFolder(
  home: string,
  given: string,
  dir: string,
  create: boolean,
): Promise<string> {
  const resolved = path.resolve(dir)
  const relative = inside(given, resolved)
    ? path.relative(given, resolved)
    : inside(home, resolved)
      ? path.relative(home, resolved)
      : undefined
  const parts = relative?.split(path.sep).filter((part) => part !== '') ?? []
  if (relative === undefined || parts.length === 0 || parts.includes('..')) {
    throw new SandboxUnavailable(`${dir} isn’t inside TED’s folder`)
  }
  let current = home
  for (const part of parts) {
    current = path.join(current, part)
    let found = await lstat(current).catch(() => undefined)
    if (!found && create) {
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      found = await lstat(current)
    }
    if (!found?.isDirectory() || found.isSymbolicLink()) {
      throw new SandboxUnavailable(
        `${current} isn’t a plain folder, so TED won’t sandbox a command in it`,
      )
    }
  }
  return current
}

async function real(file: string): Promise<string> {
  return realpath(file).catch(() => path.resolve(file))
}

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function onPath(name: string, searchPath: string | undefined): Promise<string | undefined> {
  for (const dir of (searchPath ?? '/usr/bin:/bin').split(':')) {
    if (!dir.startsWith('/')) continue
    const candidate = path.join(dir, name)
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate
  }
  return undefined
}

function probe(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), probeTimeoutMs)
    child.stderr.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-500)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: error.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: output.trim() })
    })
  })
}
