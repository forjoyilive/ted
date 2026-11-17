import { execFile, spawn } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { access, type FileHandle, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { outsideTedEnv } from '@ted/protocol'
import { redactSecrets } from './redact.ts'

export interface SandboxScope {
  writable: readonly string[]
  readable: readonly string[]
  tmp: string
  cache: string
  sockets?: readonly string[]
  electron?: boolean
}

export interface Sandboxed {
  argv: [string, ...string[]]
  env: Record<string, string>
  fds: readonly number[]
  close(): Promise<void>
}

export const firstBindFd = 3

export interface Sandbox {
  problem(): Promise<string | undefined>
  wrap(argv: readonly [string, ...string[]], scope: SandboxScope): Promise<Sandboxed>
  buildCaches(cache: string): Promise<Record<string, string>>
}

const buildFolders = {
  TED_DERIVED_DATA: 'DerivedData',
  TED_SWIFTPM_CACHE: 'swiftpm',
  CLANG_MODULE_CACHE_PATH: 'ModuleCache',
}

export function buildCacheEnv(cache: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(buildFolders).map(([name, dir]) => [name, path.join(cache, 'xcode', dir)]),
    ),
    GRADLE_USER_HOME: path.join(cache, 'gradle'),
  }
}

async function makeBuildCaches(
  home: string,
  given: string,
  cache: string,
): Promise<Record<string, string>> {
  const env = buildCacheEnv(cache)
  for (const dir of Object.values(env)) await plainFolder(home, given, dir, true)
  return env
}

export class SandboxUnavailable extends Error {}

const probeTimeoutMs = 10_000

export function createSandbox(options: {
  tedHome: string
  env: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  program?: string
  bindFds?: boolean
  unixSockets?: () => Promise<string>
}): Sandbox {
  const platform = options.platform ?? process.platform
  let ready: string | undefined
  let bindFds = false
  let saves: Promise<string | undefined> | undefined

  async function program(): Promise<string | undefined> {
    if (options.program !== undefined) return options.program
    if (platform === 'darwin') return '/usr/bin/sandbox-exec'
    return onPath('bwrap', options.env().PATH)
  }

  async function socketTable(): Promise<string> {
    return (options.unixSockets ?? (() => readFile('/proc/net/unix', 'utf8')))().catch(
      (error: unknown) => {
        throw new SandboxUnavailable(
          `TED couldn’t list this machine’s Unix sockets, so it can’t sandbox checks and Apps or worktree setup and teardown: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    )
  }

  async function problem(): Promise<string | undefined> {
    const why = await setUp()
    if (why !== undefined || platform !== 'linux') return why
    return socketTable().then(
      () => undefined,
      (error: Error) => error.message,
    )
  }

  async function setUp(): Promise<string | undefined> {
    if (ready !== undefined) return undefined
    if (platform !== 'darwin' && platform !== 'linux') {
      return `TED can’t sandbox commands on ${platform}`
    }
    const found = await program()
    if (found === undefined) {
      return 'bwrap (bubblewrap) isn’t installed, so TED can’t sandbox checks and Apps or worktree setup and teardown. Install the bubblewrap package.'
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
      if (platform === 'linux') {
        bindFds = options.bindFds ?? (await helpText(found, options.env())).includes('--bind-fd')
        if (!bindFds) {
          console.error(
            'bwrap on this machine has no --bind-fd, so TED checks the Task’s folders by path before bwrap opens them',
          )
        }
      }
      ready = found
      return undefined
    }
    const name = platform === 'darwin' ? 'sandbox-exec' : 'bwrap'
    return `${name} doesn’t work on this machine, so TED can’t sandbox checks and Apps or worktree setup and teardown${result.output === '' ? '' : `: ${result.output}`}`
  }

  return {
    problem,
    async wrap(argv, scope) {
      const why = await problem()
      if (why !== undefined || ready === undefined) throw new SandboxUnavailable(why)
      const env = options.env()
      const paths = await sandboxPaths(platform, options.tedHome, scope)
      if (platform === 'darwin') {
        saves ??= savesFolder()
        const found = await saves
        if (found !== undefined && !inside(found, paths.tedHome) && !inside(paths.tedHome, found)) {
          paths.saves = found
        }
      }
      const sockets = await allowedSockets(scope.sockets ?? [], env)
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
        TED_SANDBOX: '1',
        // Chromium on macOS ignores TMPDIR and makes its single-instance socket in the user temp folder.
        ...(platform === 'darwin' && { MAC_CHROMIUM_TMPDIR: paths.tmp }),
        ...(scope.electron === true && { TED_SANDBOX_ELECTRON: '1' }),
        ...(await makeBuildCaches(paths.tedHome, path.resolve(options.tedHome), paths.cache)),
      }
      if (platform === 'darwin') {
        return {
          argv: [ready, ...seatbeltArgs(paths, sockets, scope.electron === true), ...argv],
          env: added,
          fds: [],
          close: async () => {},
        }
      }
      const table = await socketTable()
      const linux = await linuxSockets(table, paths, sockets, env)
      const binds = bwrapBinds(paths)
      const handles: FileHandle[] = []
      const close = async () => {
        await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => {})))
      }
      try {
        if (bindFds) {
          for (const bind of binds) handles.push(await openPinned(bind.source, paths))
        }
      } catch (error) {
        await close()
        throw error
      }
      return {
        argv: [ready, ...bwrapArgs(paths, env, linux, binds, bindFds), '--', ...argv],
        env: added,
        fds: handles.map((handle) => handle.fd),
        close,
      }
    },
    async buildCaches(cache) {
      const home = await real(options.tedHome)
      const given = path.resolve(options.tedHome)
      return makeBuildCaches(home, given, await plainFolder(home, given, cache, true))
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
  saves?: string
}

const xcodeSavers = 'xcodebuild|SWBBuildService|XCBBuildService'

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function savesFolder(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], (error, stdout) => {
      const dir = stdout.trim()
      if (error || !dir.startsWith('/')) return resolve(undefined)
      real(dir).then((found) =>
        resolve(/["\n\r]/.test(found) ? undefined : path.join(found, 'TemporaryItems')),
      )
    })
  })
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

async function allowedSockets(
  entries: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const home = env.HOME?.startsWith('/') ? env.HOME : homedir()
  const found = new Set<string>()
  for (const entry of entries) {
    const expanded = entry.startsWith('$')
      ? outsideTedEnv(entry.slice(1), env)
      : entry.startsWith('~/')
        ? path.join(home, entry.slice(2))
        : entry
    if (expanded === undefined || !expanded.startsWith('/') || expanded.includes('\0')) {
      console.error(
        redactSecrets(
          `sandbox_sockets entry ${entry} isn’t an absolute path here, so TED skips it`,
        ),
      )
      continue
    }
    found.add(path.resolve(expanded))
    found.add(await real(expanded))
  }
  return [...found]
}

function seatbeltArgs(
  paths: SandboxPaths,
  sockets: readonly string[],
  electron: boolean,
): string[] {
  const params: string[] = []
  const param = (prefix: string, values: readonly string[]) =>
    values
      .map((value, i) => {
        params.push('-D', `${prefix}${i}=${value}`)
        return `(subpath (param "${prefix}${i}"))`
      })
      .join(' ')
  const own = [...paths.writable, paths.tmp, paths.cache]
  const literal = (prefix: string, values: readonly string[]) =>
    values
      .map((value, i) => {
        params.push('-D', `${prefix}${i}=${value}`)
        return `(remote unix-socket (path-literal (param "${prefix}${i}")))`
      })
      .join(' ')
  const ownSockets = own.map((_, i) => `(remote unix-socket (subpath (param "W${i}")))`).join(' ')
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") ${paths.sharedTmp === undefined ? '' : `(subpath "${paths.sharedTmp}")`})`,
    `(deny file-write* file-read-data file-read-xattr ${param('H', [paths.tedHome])})`,
    `(allow file-read-data file-read-xattr ${param('R', [...paths.readable, ...own])})`,
    `(allow file-write* ${param('W', own)})`,
    ...(paths.saves === undefined
      ? []
      : [`(allow file-write* (regex #"^${escapeRegex(paths.saves)}/NSIRD_(${xcodeSavers})_"))`]),
    '(deny appleevent-send)',
    '(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd") (global-name "com.apple.CoreServices.coreservicesd"))',
    '(allow mach-lookup (global-name "com.apple.lsd.mapdb"))',
    // Electron aborts at launch unless it can check in with launchservicesd.
    ...(electron
      ? ['(allow mach-lookup (global-name "com.apple.coreservices.launchservicesd"))']
      : []),
    '(deny user-preference-write)',
    '(deny network-outbound (remote unix-socket))',
    `(allow network-outbound ${ownSockets} ${literal('S', [...macSystemSockets, ...sockets])})`,
  ].join('\n')
  return [...params, '-p', profile]
}

interface Bind {
  source: string
  dest: string
  writable: boolean
}

function bwrapBinds(paths: SandboxPaths): Bind[] {
  return [
    { source: paths.tmp, dest: '/tmp', writable: true },
    ...paths.readable.map((dir) => ({ source: dir, dest: dir, writable: false })),
    ...[...paths.writable, paths.tmp, paths.cache].map((dir) => ({
      source: dir,
      dest: dir,
      writable: true,
    })),
  ]
}

function bwrapArgs(
  paths: SandboxPaths,
  env: NodeJS.ProcessEnv,
  sockets: LinuxSockets,
  binds: readonly Bind[],
  byFd: boolean,
): string[] {
  const runtime = runtimeDir(env)
  const bind = (b: Bind, i: number) =>
    byFd
      ? [b.writable ? '--bind-fd' : '--ro-bind-fd', String(firstBindFd + i), b.dest]
      : [b.writable ? '--bind' : '--ro-bind', b.source, b.dest]
  const [tmpBind, ...taskBinds] = binds.map(bind)
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
    ...(tmpBind ?? []),
    ...(runtime === undefined ? [] : ['--tmpfs', runtime]),
    '--tmpfs',
    paths.tedHome,
    ...taskBinds.flat(),
    ...sockets.restores.flatMap((socket) => ['--ro-bind', socket, socket]),
    ...sockets.masks.flatMap((socket) => ['--ro-bind', '/dev/null', socket]),
    '--unsetenv',
    'DBUS_SESSION_BUS_ADDRESS',
  ]
}

function runtimeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.XDG_RUNTIME_DIR?.startsWith('/') ? env.XDG_RUNTIME_DIR : undefined
}

const macSystemSockets = ['/private/var/run/mDNSResponder', '/private/var/run/syslog']

interface LinuxSockets {
  masks: string[]
  restores: string[]
}

async function linuxSockets(
  procNetUnix: string,
  paths: SandboxPaths,
  allowed: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<LinuxSockets> {
  const runtime = runtimeDir(env)
  const covered = [
    '/tmp',
    '/dev',
    '/proc',
    ...(runtime === undefined ? [] : [runtime, await real(runtime)]),
  ]
  const own = [...paths.writable, paths.tmp, paths.cache]
  const hidden = (file: string) =>
    !paths.readable.some((dir) => inside(dir, file)) &&
    (covered.some((dir) => inside(dir, file)) || inside(paths.tedHome, file))
  const socketAt = async (file: string) =>
    (await lstat(file).catch(() => undefined))?.isSocket() === true

  const masks = new Set<string>()
  for (const name of unixSocketPaths(procNetUnix)) {
    const resolved = await real(name)
    if (masks.has(resolved) || allowed.includes(resolved)) continue
    if (hidden(resolved) || own.some((dir) => inside(dir, resolved))) continue
    if (await socketAt(resolved)) masks.add(resolved)
  }

  const restores = new Set<string>()
  for (const socket of allowed) {
    if (inside(paths.tedHome, socket) || !covered.some((dir) => inside(dir, socket))) continue
    if (socket !== (await real(socket)) || !(await socketAt(socket))) continue
    restores.add(socket)
  }
  return { masks: [...masks], restores: [...restores] }
}

export function unixSocketPaths(procNetUnix: string): string[] {
  const found: string[] = []
  for (const line of procNetUnix.split('\n').slice(1)) {
    const match = /^\s*\S+:\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s(.+)$/.exec(line)
    const socket = match?.[1]
    if (socket?.startsWith('/')) found.push(socket)
  }
  return found
}

async function openPinned(dir: string, paths: SandboxPaths): Promise<FileHandle> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    const checked = await plainFolderStats(paths.tedHome, paths.tedHome, dir)
    if (opened.dev !== checked.dev || opened.ino !== checked.ino) {
      throw new SandboxUnavailable(
        `${dir} changed while TED opened it, so TED won’t sandbox a command in it`,
      )
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

async function helpText(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, ['--help'], { env, timeout: probeTimeoutMs }, (_error, stdout, stderr) =>
      resolve(`${stdout}${stderr}`),
    )
  })
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
  await plainFolderStats(home, given, dir, create)
  return path.join(home, ...folderParts(home, given, dir))
}

function folderParts(home: string, given: string, dir: string): string[] {
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
  return parts
}

async function plainFolderStats(
  home: string,
  given: string,
  dir: string,
  create = false,
): Promise<Stats> {
  let current = home
  let found: Stats | undefined
  for (const part of folderParts(home, given, dir)) {
    current = path.join(current, part)
    found = await lstat(current).catch(() => undefined)
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
  if (found === undefined) throw new SandboxUnavailable(`${dir} isn’t inside TED’s folder`)
  return found
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
