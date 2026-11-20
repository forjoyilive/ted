import { execFile, spawn } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { access, type FileHandle, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import {
  accessGroups,
  accessSockets,
  defaultNetwork,
  type NamedSocket,
  type NetworkLevel,
  outsideTedEnv,
  type SandboxAccess,
} from '@ted/protocol'
import { protectedPaths } from './protected-folders.ts'
import { redactSecrets } from './redact.ts'

export interface SandboxScope {
  writable: readonly string[]
  readable: readonly string[]
  tmp: string
  cache: string
  sockets?: readonly NamedSocket[]
  reads?: readonly string[]
  network?: NetworkLevel
  serves?: boolean
  ownTempOnly?: boolean
  hideProtected?: boolean
  groups?: readonly SandboxAccess[]
}

export interface Sandboxed {
  argv: [string, ...string[]]
  env: Record<string, string>
  fds: readonly number[]
  missingSockets: readonly string[]
  close(): Promise<void>
}

export const firstBindFd = 3

export interface SandboxGrants {
  sockets: readonly NamedSocket[]
  reads: readonly string[]
  network: NetworkLevel
}

export function sandboxGrants(settings: {
  sandbox_sockets?: readonly NamedSocket[]
  sandbox_reads?: readonly string[]
  sandbox_network?: NetworkLevel
}): SandboxGrants {
  return {
    sockets: settings.sandbox_sockets ?? [],
    reads: settings.sandbox_reads ?? [],
    network: settings.sandbox_network ?? defaultNetwork,
  }
}

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
    CP_HOME_DIR: path.join(cache, 'cocoapods'),
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

export function withSandboxEnv(
  base: NodeJS.ProcessEnv,
  sandboxed: Record<string, string>,
): NodeJS.ProcessEnv {
  const given = base.JAVA_TOOL_OPTIONS?.trim()
  const own = sandboxed.JAVA_TOOL_OPTIONS
  return {
    ...base,
    ...sandboxed,
    ...(given && own !== undefined && { JAVA_TOOL_OPTIONS: `${given} ${own}` }),
  }
}

const probeTimeoutMs = 10_000

export function createSandbox(options: {
  tedHome: string
  env: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  program?: string
  bindFds?: boolean
  unixSockets?: () => Promise<string>
  simulatorRuntimes?: string
}): Sandbox {
  const platform = options.platform ?? process.platform
  let ready: string | undefined
  let bindFds = false
  let userTemp: Promise<string | undefined> | undefined

  async function program(): Promise<string | undefined> {
    if (options.program !== undefined) return options.program
    if (platform === 'darwin') return '/usr/bin/sandbox-exec'
    return onPath('bwrap', options.env().PATH)
  }

  async function socketTable(): Promise<string> {
    return (options.unixSockets ?? (() => readFile('/proc/net/unix', 'utf8')))().catch(
      (error: unknown) => {
        throw new SandboxUnavailable(
          `Ted couldn’t list this machine’s Unix sockets, so it can’t sandbox checks and Apps or worktree setup and teardown: ${error instanceof Error ? error.message : String(error)}`,
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
      return `Ted can’t sandbox commands on ${platform}`
    }
    const found = await program()
    if (found === undefined) {
      return 'bwrap (bubblewrap) isn’t installed, so Ted can’t sandbox checks and Apps or worktree setup and teardown. Install the bubblewrap package.'
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
            'bwrap on this machine has no --bind-fd, so Ted checks the Task’s folders by path before bwrap opens them',
          )
        }
      }
      ready = found
      return undefined
    }
    const name = platform === 'darwin' ? 'sandbox-exec' : 'bwrap'
    return `${name} doesn’t work on this machine, so Ted can’t sandbox checks and Apps or worktree setup and teardown${result.output === '' ? '' : `: ${result.output}`}`
  }

  return {
    problem,
    async wrap(argv, scope) {
      const why = await problem()
      if (why !== undefined || ready === undefined) throw new SandboxUnavailable(why)
      const env = options.env()
      const paths = await sandboxPaths(platform, options.tedHome, scope)
      const groups = accessGroups(scope.groups)
      const electron = groups.includes('electron')
      const xcode = scope.ownTempOnly !== true && groups.includes('ios-xcode')
      const simulator = groups.includes('ios-simulator')
      const android = groups.includes('android-emulator')
      const sdk = await androidSdkFolders(env)
      const asked = accessSockets(scope.groups)
      const named = new Map((scope.sockets ?? []).map((socket) => [socket.name, socket.path]))
      const missingSockets = asked.filter((name) => !named.has(name))
      let perUserTemp: string | undefined
      if (platform === 'darwin') {
        userTemp ??= userTempFolder()
        perUserTemp = await userTemp
        if (perUserTemp !== undefined) {
          const saves = path.join(perUserTemp, 'TemporaryItems')
          paths.unlisted = [perUserTemp, saves]
          const [first = ''] = path.relative(perUserTemp, paths.tedHome).split(path.sep)
          if (xcode) {
            if (!inside(saves, paths.tedHome) && !inside(paths.tedHome, saves)) paths.saves = saves
            if (!inside(paths.tedHome, perUserTemp) && !xcodeTempNames.test(first))
              paths.userTemp = perUserTemp
          }
        }
        if (xcode || simulator)
          paths.simulatorRuntimes = options.simulatorRuntimes ?? simulatorRuntimeMounts
        const logs = xcode ? await manifestLogFolder(env) : undefined
        if (logs !== undefined && !inside(paths.tedHome, logs) && !inside(logs, paths.tedHome))
          paths.manifestLogs = logs
      }
      const sockets = await listedPaths(
        'sandbox_sockets',
        asked.flatMap((name) => named.get(name) ?? []),
        env,
      )
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
        // The JVM on macOS ignores TMPDIR and uses the per-user temp folder.
        JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir="${paths.tmp}"`,
        ...(electron && { TED_SANDBOX_ELECTRON: '1' }),
        ...(await makeBuildCaches(paths.tedHome, path.resolve(options.tedHome), paths.cache)),
      }
      if (platform === 'darwin') {
        const umask = process.umask()
        const pipeMode =
          paths.userTemp !== undefined && (umask & 0o001) === 0
            ? 0o777 & ~(umask | 0o001)
            : undefined
        return {
          argv: [
            ready,
            ...seatbeltArgs(
              paths,
              sockets,
              [
                ...(await baseReads(env, perUserTemp)),
                ...(android ? sdk : []),
                ...(await listedPaths('sandbox_reads', scope.reads ?? [], env)),
              ],
              [...(android ? [] : sdk), ...(simulator ? [] : await simulatorFolders(env))],
              [
                ...macServices,
                ...(electron ? macElectronServices : []),
                ...(simulator ? macSimulatorServices : []),
              ],
              await personalFolders(env),
              pipeMode,
              networkOf(scope),
              android,
            ),
            ...(pipeMode === undefined
              ? []
              : ['/bin/sh', '-c', `umask ${(umask | 0o001).toString(8)} && exec "$@"`, 'sh']),
            ...argv,
          ],
          env: added,
          fds: [],
          missingSockets,
          close: async () => {},
        }
      }
      const table = await socketTable()
      const linux = await linuxSockets(table, paths, sockets, env)
      const binds = bwrapBinds(paths)
      const personal = await personalFolders(env)
      const hidden = scope.hideProtected === true ? await existingFolders(personal) : []
      const listed = await listedPaths('sandbox_reads', scope.reads ?? [], env)
      const reads = await linuxReads(
        env,
        [...(android ? sdk : []), ...listed],
        [...personal, paths.tedHome, ...(android ? [] : sdk)],
      )
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
        argv: [
          ready,
          ...bwrapArgs(
            paths,
            env,
            linux,
            binds,
            bindFds,
            hidden,
            reads,
            ownNetwork(scope, android),
          ),
          '--',
          ...argv,
        ],
        env: added,
        fds: handles.map((handle) => handle.fd),
        missingSockets,
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
  userTemp?: string
  unlisted?: string[]
  manifestLogs?: string
  simulatorRuntimes?: string
}

const simulatorRuntimeMounts = '/private/var/run/com.apple.security.cryptexd/mnt'

const xcodeSavers =
  'xcodebuild|SWBBuildService|XCBBuildService|actool|ibtool|ibtoold|swift-build|swift-run|swift-test'
const xcodeTempNames =
  /^(TemporaryDirectory\.[A-Za-z0-9]{6}|swbuild\.tmp\.[A-Za-z0-9]{8}|(actool-sprite-atlas-scratch-)?[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}|ibtoold-[0-9]+)$/i
const ownTemp = 'file-read-data file-read-xattr file-write*'
const chars = (set: string, count: number) => `[${set}]`.repeat(count)
const uuid = [8, 4, 4, 4, 12].map((count) => chars('0-9A-F', count)).join('-')

// The user's own ibtoold pipes are named in its arguments, which a sandboxed command can read. Sandboxed commands
// run with others-execute masked, so only items with exactly the mode that umask gives are writable.
function ownPipes(pattern: string, mode: number): string[] {
  const types = '(require-any (vnode-type DIRECTORY) (vnode-type FIFO))'
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  const exact = [
    `(file-mode #o${mode.toString(8).padStart(4, '0')})`,
    ...bits.flatMap((bit) =>
      (mode & bit) === 0 ? [`(require-not (file-mode #o${bit.toString(8).padStart(4, '0')}))`] : [],
    ),
  ].join(' ')
  return [
    `(allow file-read-data file-read-xattr (require-all (regex #"${pattern}") ${types}))`,
    `(allow file-write-create (require-all (regex #"${pattern}") ${types}))`,
    `(allow file-write* (require-all (regex #"${pattern}") ${types} ${exact}))`,
    `(deny file-link (regex #"${pattern}"))`,
  ]
}

function actoolTempRules(userTemp: string, pipeMode: number | undefined): string[] {
  const at = (pattern: string) => `^${escapeRegex(userTemp)}/${pattern}`
  const noLinks = (pattern: string, types: string[]) => [
    `(allow ${ownTemp} (require-all (regex #"${pattern}") (require-any ${types.map((type) => `(vnode-type ${type})`).join(' ')})))`,
    `(deny file-link (regex #"${pattern}"))`,
  ]
  return [
    ...noLinks(at(`actool-sprite-atlas-scratch-${uuid}(/|$)`), ['DIRECTORY', 'REGULAR-FILE']),
    ...noLinks(at(`${uuid}$`), ['DIRECTORY']),
    ...noLinks(at(`${uuid}/assets\\.uicatalog(-journal)?$`), ['REGULAR-FILE']),
    ...noLinks(at(`${uuid}/[^/]+\\.icon\\.xcassets(/|$)`), ['DIRECTORY', 'REGULAR-FILE']),
    ...(pipeMode !== undefined
      ? ownPipes(at(`ibtoold-[0-9]+(/IB(/${uuid}\\.(HostToRemote|RemoteToHost))?)?$`), pipeMode)
      : []),
    `(deny file-read-data (regex #"${at('ibtoold-[0-9]+(/IB)?/?$')}"))`,
    ...noLinks(at(`${uuid}\\.storyboard$`), ['REGULAR-FILE']),
    ...noLinks(at(`Untitled-${chars('A-Za-z0-9', 8)}\\.uicatalog(-journal)?$`), ['REGULAR-FILE']),
    ...noLinks(
      at(
        `(${uuid}/)?\\.?[^/]+_${uuid}-[0-9]+-${chars('0-9A-F', 16)}\\.png(-${chars('A-Za-z0-9', 6)})?$`,
      ),
      ['REGULAR-FILE'],
    ),
  ]
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function userTempFolder(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], (error, stdout) => {
      const dir = stdout.trim()
      if (error || !dir.startsWith('/')) return resolve(undefined)
      real(dir).then((found) => resolve(/["\n\r]/.test(found) ? undefined : found))
    })
  })
}

async function sandboxPaths(
  platform: NodeJS.Platform,
  tedHome: string,
  scope: SandboxScope,
): Promise<SandboxPaths> {
  const daemonTmp = await real(tmpdir())
  const sharedTmp =
    platform === 'darwin' && scope.ownTempOnly !== true && scope.groups?.includes('shared-tmp')
      ? '/private/tmp'
      : undefined
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
        `${dir} sits inside ${outer}, so Ted won’t sandbox a command with both open`,
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

async function manifestLogFolder(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const home = await real(env.HOME?.startsWith('/') ? env.HOME : homedir())
  const dir = path.join(
    home,
    'Library',
    'Caches',
    'org.swift.swiftpm',
    'manifests',
    'ManifestLoading',
  )
  const made = await mkdir(dir, { recursive: true }).then(
    () => true,
    () => false,
  )
  if (!made || /["\n\r]/.test(dir)) return undefined
  const found = await realpath(dir).catch(() => undefined)
  return found === dir ? dir : undefined
}

async function personalFolders(env: NodeJS.ProcessEnv): Promise<string[]> {
  return protectedPaths(await real(env.HOME?.startsWith('/') ? env.HOME : homedir()))
}

async function existingFolders(dirs: readonly string[]): Promise<string[]> {
  const found = await Promise.all(
    dirs.map(async (dir) => {
      const resolved = await realpath(dir).catch(() => undefined)
      const info = resolved === undefined ? undefined : await lstat(resolved).catch(() => undefined)
      return info?.isDirectory() === true ? resolved : undefined
    }),
  )
  return [...new Set(found.filter((dir) => dir !== undefined))]
}

async function listedPaths(
  setting: 'sandbox_sockets' | 'sandbox_reads',
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
        redactSecrets(`${setting} entry ${entry} isn’t an absolute path here, so Ted skips it`),
      )
      continue
    }
    found.add(path.resolve(expanded))
    found.add(await real(expanded))
  }
  return [...found]
}

const systemReads = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/Applications',
  '/opt',
  '/nix',
  '/private/etc',
  '/private/var/db',
  '/private/var/select',
  '/private/var/run/resolv.conf',
  '/dev',
]

const toolchainReads = [
  '.gitconfig',
  '.config/git/config',
  '.config/git/ignore',
  '.config/git/attributes',
  '.nvm',
  '.fnm',
  '.local/share/fnm',
  '.volta',
  '.local/share/mise',
  '.asdf',
  '.rbenv',
  '.pyenv',
  '.gem/ruby',
  '.rustup',
  '.cargo/bin',
  '.bun/bin',
  'Library/pnpm',
  'Library/Developer',
]

async function androidSdkFolders(env: NodeJS.ProcessEnv): Promise<string[]> {
  const home = await homeFolder(env)
  const given = [
    path.join(home, 'Library/Android/sdk'),
    ...[env.ANDROID_HOME, env.ANDROID_SDK_ROOT].flatMap((value) =>
      value?.startsWith('/') === true ? [value] : [],
    ),
  ]
  return existingReals(given, home)
}

async function simulatorFolders(env: NodeJS.ProcessEnv): Promise<string[]> {
  const home = await homeFolder(env)
  return existingReals([path.join(home, 'Library/Developer/CoreSimulator')], home)
}

async function existingReals(candidates: readonly string[], home: string): Promise<string[]> {
  const found = new Set<string>()
  for (const candidate of candidates) {
    if (/["\n\r\0]/.test(candidate)) continue
    const resolved = await realpath(candidate).catch(() => undefined)
    if (resolved === undefined || resolved === '/' || inside(resolved, home)) continue
    found.add(resolved)
  }
  return [...found]
}

const linuxSystemReads = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc',
  '/opt',
  '/nix',
  '/snap',
  '/sys',
  '/etc/resolv.conf',
  '/run/systemd/resolve',
]

async function homeFolder(env: NodeJS.ProcessEnv): Promise<string> {
  return real(env.HOME?.startsWith('/') ? env.HOME : homedir())
}

async function readCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  userTemp: string | undefined,
): Promise<string[]> {
  const home = await homeFolder(env)
  const fromEnv = [env.DEVELOPER_DIR, env.JAVA_HOME].flatMap((value) =>
    value?.startsWith('/') === true ? [value] : [],
  )
  const onPath = (env.PATH ?? '')
    .split(':')
    .filter((dir) => dir.startsWith('/'))
    .flatMap((dir) =>
      path.basename(dir) === 'bin' && !inside(home, dir) ? [dir, path.dirname(dir)] : [dir],
    )
  return [
    ...(platform === 'darwin' ? systemReads : linuxSystemReads),
    ...toolchainReads.map((name) => path.join(home, name)),
    ...fromEnv,
    ...onPath,
    corepackHome(env),
    ...(userTemp === undefined ? [] : [path.join(userTemp, 'xcrun_db')]),
  ].filter((candidate) => !/["\n\r\0]/.test(candidate))
}

async function baseReads(env: NodeJS.ProcessEnv, userTemp: string | undefined): Promise<string[]> {
  const home = await homeFolder(env)
  const found = new Set<string>()
  for (const candidate of await readCandidates(env, 'darwin', userTemp)) {
    const resolved = await realpath(candidate).catch(() => undefined)
    if (resolved === undefined || resolved === '/' || inside(resolved, home)) continue
    found.add(resolved)
  }
  return [...found]
}

interface LinuxReads {
  binds: [string, string][]
  links: [string, string][]
}

async function linuxReads(
  env: NodeJS.ProcessEnv,
  listed: readonly string[],
  refused: readonly string[],
): Promise<LinuxReads> {
  const home = await homeFolder(env)
  const reals = new Set<string>()
  const links = new Map<string, string>()
  const add = async (candidate: string, keepHome: boolean) => {
    const asGiven = path.resolve(candidate)
    const resolved = await realpath(asGiven).catch(() => undefined)
    if (resolved === undefined || resolved === '/') return
    if (!keepHome && inside(resolved, home)) return
    if (refused.some((dir) => inside(dir, resolved))) return
    reals.add(resolved)
    if (asGiven !== resolved) links.set(asGiven, resolved)
  }
  for (const candidate of await readCandidates(env, 'linux', undefined)) await add(candidate, false)
  for (const entry of listed) await add(entry, true)
  const shown = (dest: string) =>
    [...reals].some((dir) => dir !== dest && inside(dir, dest)) ||
    [...links.keys()].some((link) => link !== dest && inside(link, dest))
  const depth = ([, dest]: [string, string]) => dest.split('/').length
  return {
    binds: [...reals]
      .flatMap((dir): [string, string][] => (shown(dir) || links.has(dir) ? [] : [[dir, dir]]))
      .sort((x, y) => depth(x) - depth(y)),
    links: [...links].flatMap(([dest, target]): [string, string][] =>
      shown(dest) || reals.has(dest) ? [] : [[target, dest]],
    ),
  }
}

function seatbeltArgs(
  paths: SandboxPaths,
  sockets: readonly string[],
  reads: readonly string[],
  unread: readonly string[],
  services: readonly MacService[],
  personal: readonly string[],
  pipeMode: number | undefined,
  network: NetworkLevel,
  adb: boolean,
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
  const literalPath = (prefix: string, values: readonly string[]) =>
    values
      .map((value, i) => {
        params.push('-D', `${prefix}${i}=${value}`)
        return `(literal (param "${prefix}${i}"))`
      })
      .join(' ')
  const ownSockets = own.map((_, i) => `(remote unix-socket (subpath (param "W${i}")))`).join(' ')
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(deny file-read-data file-read-xattr)',
    `(allow file-read-data file-read-xattr (literal "/") ${param('B', reads)})`,
    ...(unread.length === 0 ? [] : [`(deny file-read-data file-read-xattr ${param('X', unread)})`]),
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") ${paths.sharedTmp === undefined ? '' : `(subpath "${paths.sharedTmp}")`})`,
    ...(paths.sharedTmp === undefined
      ? []
      : [`(allow file-read-data file-read-xattr (subpath "${paths.sharedTmp}"))`]),
    `(deny file-write* file-read-data file-read-xattr ${param('H', [paths.tedHome])})`,
    `(deny file-write* file-read-data file-read-xattr ${param('P', personal)})`,
    `(allow file-read-data file-read-xattr ${param('R', [...paths.readable, ...own])})`,
    `(allow file-write* ${param('W', own)})`,
    ...(paths.saves === undefined
      ? []
      : [`(allow ${ownTemp} (regex #"^${escapeRegex(paths.saves)}/NSIRD_(${xcodeSavers})_"))`]),
    ...(paths.userTemp === undefined
      ? []
      : [
          // SwiftPM (TemporaryDirectory.XXXXXX) and Swift Build (swbuild.tmp.XXXXXXXX) mkdtemp in the per-user temp folder, ignoring TMPDIR.
          // Seatbelt regexes have no {n} repeat, so the random characters are written out.
          `(allow ${ownTemp} (regex #"^${escapeRegex(paths.userTemp)}/TemporaryDirectory\\.${'[A-Za-z0-9]'.repeat(6)}(/|$)"))`,
          `(allow ${ownTemp} (regex #"^${escapeRegex(paths.userTemp)}/swbuild\\.tmp\\.${'[A-Za-z0-9]'.repeat(8)}(/|$)"))`,
          // actool’s and ibtool’s helpers write these in the per-user temp folder, ignoring TMPDIR. ibtoold-<pid> names are guessable and stay behind, so links are refused.
          ...actoolTempRules(paths.userTemp, pipeMode),
        ]),
    ...(paths.manifestLogs === undefined
      ? []
      : [
          // Xcode’s package resolution writes <package>.dia here whatever its cache options say. Plain files only, so no link can send the user’s own builds elsewhere.
          `(allow ${ownTemp} (require-all (regex #"^${escapeRegex(paths.manifestLogs)}/[^/]+\\.dia$") (vnode-type REGULAR-FILE)))`,
          `(deny file-link (regex #"^${escapeRegex(paths.manifestLogs)}/"))`,
        ]),
    ...(paths.simulatorRuntimes === undefined
      ? []
      : [
          `(allow file-read-data file-read-xattr (regex #"^${escapeRegex(paths.simulatorRuntimes)}/com\\.apple\\.iPhoneOS\\.SimulatorRuntime-[^/]+(/|$)"))`,
        ]),
    ...(paths.unlisted === undefined
      ? []
      : [`(deny file-read-data ${literalPath('U', paths.unlisted)})`]),
    // ibtool hands its job to any idle ibtoold listed in this shared-memory registry, including the user's own unsandboxed one.
    // Without it, ibtool runs ibtoold itself, inside the sandbox.
    '(deny ipc-posix-shm* (ipc-posix-name-prefix "ib"))',
    '(deny appleevent-send)',
    '(deny mach-lookup)',
    `(allow mach-lookup ${macServiceFilters(services)})`,
    '(deny user-preference-write)',
    '(deny network-outbound (remote unix-socket))',
    `(allow network-outbound ${ownSockets} ${literal('S', [...macSystemSockets(network), ...sockets])})`,
    ...(network === 'outbound' ? [] : ['(deny network-outbound (remote ip "*:*"))']),
    ...(network === 'localhost' ? ['(allow network-outbound (remote ip "localhost:*"))'] : []),
    ...(adb || network === 'none'
      ? []
      : adbPorts.map((port) => `(deny network-outbound (remote ip "localhost:${port}"))`)),
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
  hidden: readonly string[],
  reads: LinuxReads,
  ownNetwork: boolean,
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
    ...(ownNetwork ? ['--unshare-net'] : []),
    ...reads.binds.flatMap(([source, dest]) => ['--ro-bind', source, dest]),
    ...reads.links.flatMap(([target, dest]) => ['--symlink', target, dest]),
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    ...(tmpBind ?? []),
    ...(runtime === undefined ? [] : ['--tmpfs', runtime]),
    ...hidden.flatMap((dir) => ['--tmpfs', dir]),
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

// mDNSResponder answers DNS lookups, which can carry data out; localhost still resolves without it.
function macSystemSockets(network: NetworkLevel): string[] {
  return network === 'outbound'
    ? ['/private/var/run/mDNSResponder', '/private/var/run/syslog']
    : ['/private/var/run/syslog']
}

function networkOf(scope: SandboxScope): NetworkLevel {
  return scope.groups?.includes('network') === true ? 'outbound' : (scope.network ?? defaultNetwork)
}

// An App's port must stay reachable from the host, and bwrap can't share host loopback without host networking.
function ownNetwork(scope: SandboxScope, adb: boolean): boolean {
  const network = networkOf(scope)
  return network === 'none' || (network === 'localhost' && scope.serves !== true && !adb)
}

type MacService = { name: string } | { prefix: string } | { regex: string }

const macServices: readonly MacService[] = [
  { name: 'com.apple.system.opendirectoryd.libinfo' },
  { name: 'com.apple.system.opendirectoryd.membership' },
  { name: 'com.apple.bsd.dirhelper' },
  { name: 'com.apple.system.notification_center' },
  { name: 'com.apple.system.logger' },
  { name: 'com.apple.logd' },
  { name: 'com.apple.SystemConfiguration.configd' },
  { name: 'com.apple.SystemConfiguration.DNSConfiguration' },
  { name: 'com.apple.trustd' },
  { name: 'com.apple.trustd.agent' },
  { name: 'com.apple.lsd.mapdb' },
  { name: 'com.apple.FSEvents' },
  { regex: '\\.MachPortRendezvousServer\\.[0-9]+$' },
]

const macSimulatorServices: readonly MacService[] = [{ prefix: 'com.apple.CoreSimulator.' }]

// Seatbelt matches one port or every port, so each emulator port gets its own rule.
const adbPorts = [5037, ...Array.from({ length: 32 }, (_, i) => 5554 + i)]

const macElectronServices: readonly MacService[] = [
  { name: 'com.apple.coreservices.launchservicesd' },
  { name: 'com.apple.windowserver.active' },
]

function macServiceFilters(services: readonly MacService[]): string {
  return services
    .map((service) =>
      'name' in service
        ? `(global-name "${service.name}")`
        : 'prefix' in service
          ? `(global-name-prefix "${service.prefix}")`
          : `(global-name-regex #"${service.regex}")`,
    )
    .join(' ')
}

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
        `${dir} changed while Ted opened it, so Ted won’t sandbox a command in it`,
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
    throw new SandboxUnavailable(`${dir} isn’t inside Ted’s folder`)
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
        `${current} isn’t a plain folder, so Ted won’t sandbox a command in it`,
      )
    }
  }
  if (found === undefined) throw new SandboxUnavailable(`${dir} isn’t inside Ted’s folder`)
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
