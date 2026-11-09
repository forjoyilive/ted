import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export interface SandboxScope {
  writable: readonly string[]
  tmp: string
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
      return 'bwrap (bubblewrap) isn’t installed, so TED can’t sandbox Checks and Apps. Install the bubblewrap package.'
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
    return `${name} doesn’t work on this machine, so TED can’t sandbox Checks and Apps${result.output === '' ? '' : `: ${result.output}`}`
  }

  return {
    problem,
    async wrap(argv, scope) {
      const why = await problem()
      if (why !== undefined || ready === undefined) throw new SandboxUnavailable(why)
      const env = options.env()
      const home = env.HOME?.startsWith('/') ? env.HOME : homedir()
      const paths = await sandboxPaths(platform, home, env, options.tedHome, scope)
      const added: Record<string, string> = {
        TMPDIR: paths.tmp,
        TMP: paths.tmp,
        TEMP: paths.tmp,
        ...(!hasName(env, 'npm_config_cache') && { npm_config_cache: path.join(home, '.npm') }),
      }
      return platform === 'darwin'
        ? { argv: [ready, ...seatbeltArgs(paths), ...argv], env: added }
        : { argv: [ready, ...bwrapArgs(paths, env), '--', ...argv], env: added }
    },
  }
}

interface SandboxPaths {
  writable: string[]
  tmp: string
  caches: string[]
  programs: string[]
  tedHome: string
  pnpmHome?: string
  sharedTmp?: string
}

async function sandboxPaths(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
  tedHome: string,
  scope: SandboxScope,
): Promise<SandboxPaths> {
  const pnpmHome = env.PNPM_HOME?.startsWith('/')
    ? env.PNPM_HOME
    : platform === 'darwin'
      ? path.join(home, 'Library', 'pnpm')
      : path.join(
          env.XDG_DATA_HOME?.startsWith('/')
            ? env.XDG_DATA_HOME
            : path.join(home, '.local', 'share'),
          'pnpm',
        )
  const caches = [
    ...(platform === 'darwin' ? [path.join(home, 'Library', 'Caches')] : []),
    path.join(home, '.cache'),
    path.join(home, '.npm'),
    path.join(pnpmHome, 'store'),
  ]
  const programs = [
    env.COREPACK_HOME?.startsWith('/')
      ? env.COREPACK_HOME
      : path.join(home, '.cache', 'node', 'corepack'),
    path.join(home, '.cache', 'ms-playwright'),
    path.join(home, '.cache', 'puppeteer'),
    ...(platform === 'darwin' ? [path.join(home, 'Library', 'Caches', 'ms-playwright')] : []),
  ]
  const daemonTmp = await real(tmpdir())
  const sharedTmp = platform === 'darwin' ? '/private/tmp' : undefined
  return {
    writable: await Promise.all(scope.writable.map(real)),
    tmp: await real(scope.tmp),
    caches: await Promise.all(caches.map(real)),
    programs: await Promise.all(programs.map(real)),
    tedHome: await real(tedHome),
    ...(platform === 'darwin' && { pnpmHome: await real(pnpmHome) }),
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
  const pnpmProbe =
    paths.pnpmHome !== undefined && !/["\\]/.test(paths.pnpmHome)
      ? `(regex #"^${escapeRegex(paths.pnpmHome)}/_tmp_[0-9a-f_]+(/_tmp_[0-9a-f_]+)?$")`
      : ''
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") ${param('C', paths.caches)} ${pnpmProbe} ${paths.sharedTmp === undefined ? '' : `(subpath "${paths.sharedTmp}")`})`,
    `(deny file-write* ${param('P', paths.programs)} ${param('H', [paths.tedHome])})`,
    `(allow file-write* ${param('W', [...paths.writable, paths.tmp])})`,
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
    ...paths.caches.flatMap((dir) => ['--bind-try', dir, dir]),
    ...paths.programs.flatMap((dir) => ['--ro-bind-try', dir, dir]),
    '--ro-bind',
    paths.tedHome,
    paths.tedHome,
    ...[...paths.writable, paths.tmp].flatMap((dir) => ['--bind', dir, dir]),
    '--unsetenv',
    'DBUS_SESSION_BUS_ADDRESS',
  ]
}

function escapeRegex(text: string): string {
  return text.replace(/[.^$*+?()[\]{}|]/g, '\\$&')
}

async function real(file: string): Promise<string> {
  return realpath(file).catch(() => path.resolve(file))
}

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function hasName(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.keys(env).some((key) => key.toLowerCase() === name.toLowerCase())
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
