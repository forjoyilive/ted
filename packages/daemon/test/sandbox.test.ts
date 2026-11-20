import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { type AddressInfo, createServer, type Server } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { NamedSocket, SandboxAccess } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createSandbox,
  SandboxUnavailable,
  unixSocketPaths,
  withSandboxEnv,
} from '../src/sandbox.ts'
import { skipInsideTedSandbox } from './support/ted-sandbox.ts'

const execFileAsync = promisify(execFile)

let tedHome: string
let worktree: string
let clone: string
let tmp: string
let outside: string

const scope = () => ({
  writable: [worktree],
  readable: [clone],
  cache: path.join(tedHome, 'sandbox', 'NB-1', 'cache'),
  tmp,
})

async function makeHome(parent: string) {
  tedHome = await mkdtemp(path.join(parent, 'ted-sandbox-home-'))
  worktree = path.join(tedHome, 'worktrees', 'NB-1', 'widgets')
  clone = path.join(tedHome, 'repos', 'k', 'widgets')
  await mkdir(worktree, { recursive: true })
  await mkdir(clone, { recursive: true })
  tmp = path.join(tedHome, 'sandbox', 'NB-1', 'tmp-1')
  await mkdir(tmp, { recursive: true })
}

beforeEach(async () => {
  await makeHome(tmpdir())
  outside = await mkdtemp(path.join(tmpdir(), 'ted-sandbox-outside-'))
})

afterEach(async () => {
  for (const dir of [tedHome, outside]) await rm(dir, { recursive: true, force: true })
})

async function inSandbox(
  script: string,
  options: {
    sockets?: NamedSocket[]
    home?: string
    reads?: string[]
    groups?: SandboxAccess[]
    simulatorRuntimes?: string
  } = {},
) {
  const { sockets = [], home, reads = [], groups, simulatorRuntimes } = options
  const sandbox = createSandbox({
    tedHome,
    env: () => (home === undefined ? process.env : { ...process.env, HOME: home }),
    ...(simulatorRuntimes !== undefined && { simulatorRuntimes }),
  })
  const { argv, env } = await sandbox.wrap(['/bin/sh', '-c'], {
    ...scope(),
    sockets,
    reads,
    ...(groups !== undefined && { groups }),
  })
  const [command, ...args] = argv
  return execFileAsync(command, [...args, script], {
    cwd: worktree,
    env: withSandboxEnv(process.env, env),
  }).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: { code?: number; stdout?: string }) => ({
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
    }),
  )
}

const socketPathLimit = process.platform === 'darwin' ? 103 : 107

function skipLongSockets(
  context: { skip: (condition: boolean, note?: string) => void },
  sockets: readonly string[],
): void {
  context.skip(
    sockets.some((socket) => Buffer.byteLength(socket) > socketPathLimit),
    `the temp folder ${tmpdir()} is too deep for a Unix socket path (at most ${socketPathLimit} bytes here), as it is inside Ted’s sandbox`,
  )
}

async function listen(socket: string): Promise<Server> {
  const server = createServer((connection) => connection.end())
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return server
}

const tryConnect = (socket: string) =>
  `'${process.execPath}' -e "require('net').connect('${socket}').on('connect', () => { console.log('connected'); process.exit() }).on('error', () => { console.log('refused'); process.exit() })"`

const xcode: SandboxAccess[] = ['ios-xcode']

const tryTcp = (host: string, port: number) =>
  `'${process.execPath}' -e "const s = require('net').connect(${port}, '${host}'); s.setTimeout(2000, () => { console.log('timeout'); process.exit() }); s.on('connect', () => { console.log('connected'); process.exit() }).on('error', (e) => { console.log(e.code); process.exit() })"`

// TEST-NET-1 (RFC 5737) is never routed, so a refused connect there sends nothing anywhere.
const outsideAddress = '192.0.2.1'
const denyIp = '(deny network-outbound (remote ip "*:*"))'

async function listenTcp(): Promise<{ server: Server; port: number }> {
  const server = createServer((connection) => connection.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

const tryWrite = (file: string) => `echo x > '${file}' 2>/dev/null && echo wrote || echo refused`
const tryRead = (file: string) => `cat '${file}' >/dev/null 2>&1 && echo read || echo refused`

describe.runIf(process.platform === 'darwin')('the sandbox on macOS', () => {
  let userTemp: string
  let saves: string
  beforeEach(async (context) => {
    skipInsideTedSandbox(context)
    const { stdout } = await execFileAsync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'])
    userTemp = await realpath(stdout.trim())
    saves = path.join(userTemp, 'TemporaryItems')
    await rm(tedHome, { recursive: true, force: true })
    await makeHome(userTemp)
  })

  test('a sandboxed command writes its worktree, its own temp folder and the Task’s caches', async () => {
    await writeFile(path.join(clone, 'HEAD'), 'ref')
    const id = randomUUID()
    const xcodeSave = path.join(saves, `NSIRD_SWBBuildService_${id}`)
    const assetSave = path.join(saves, `NSIRD_actool_${id}`)
    const assetHelperSave = path.join(saves, `NSIRD_ibtoold_${id}`)
    const swiftSave = path.join(saves, `NSIRD_swift-build_${id}`)
    const otherSave = path.join(saves, `NSIRD_TextEdit_${id}`)
    const interfaceSave = path.join(saves, `NSIRD_ibtool_${id}`)
    const looseSave = path.join(saves, `ted-${id}`)
    await mkdir(otherSave, { recursive: true })
    const result = await inSandbox(
      [
        tryWrite(path.join(worktree, 'a.txt')),
        'echo x > "$TMPDIR/b.txt" && echo wrote',
        'mkdir -p "$npm_config_cache" && echo x > "$npm_config_cache/c" && echo wrote',
        'echo x > "$TED_DERIVED_DATA/d" && test -d "$TED_SWIFTPM_CACHE" && test -d "$CLANG_MODULE_CACHE_PATH" && test "$TED_SANDBOX" = 1 && test "$MAC_CHROMIUM_TMPDIR" = "$TMPDIR" && case "$JAVA_TOOL_OPTIONS" in *"-Djava.io.tmpdir=\\"$TMPDIR\\"") echo wrote ;; esac',
        'echo x > "$CP_HOME_DIR/e" && echo wrote',
        `mkdir '${xcodeSave}' && ${tryWrite(path.join(xcodeSave, 'x'))}`,
        `mkdir '${assetSave}' && ${tryWrite(path.join(assetSave, 'x'))}`,
        `mkdir '${assetHelperSave}' && ${tryWrite(path.join(assetHelperSave, 'x'))}`,
        `mkdir '${swiftSave}' && ${tryWrite(path.join(swiftSave, 'x'))}`,
        tryWrite(path.join(otherSave, 'x')),
        `mkdir '${interfaceSave}' && ${tryWrite(path.join(interfaceSave, 'x'))}`,
        tryWrite(looseSave),
        tryRead(path.join(clone, 'HEAD')),
        'echo "$TMPDIR"',
      ].join('; '),
      { groups: xcode },
    )
    expect(result.stdout.split('\n').slice(0, 13)).toEqual([
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'refused',
      'wrote',
      'refused',
      'read',
    ])
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf8')).toBe('x\n')
    const cache = await realpath(scope().cache)
    expect(await readFile(path.join(cache, 'xcode', 'DerivedData', 'd'), 'utf8')).toBe('x\n')
    expect(await readFile(path.join(cache, 'cocoapods', 'e'), 'utf8')).toBe('x\n')
    expect(result.stdout).toContain(path.basename(tmp))
    for (const dir of [
      xcodeSave,
      assetSave,
      assetHelperSave,
      swiftSave,
      otherSave,
      interfaceSave,
      looseSave,
    ])
      await rm(dir, { recursive: true, force: true })
  })

  test('a sandboxed command makes and removes SwiftPM’s and Swift Build’s temp folders in the per-user temp folder, and nothing else there', async () => {
    const id = randomUUID()
    const longer = path.join(userTemp, `TemporaryDirectory.${id.slice(0, 6)}x`)
    const shorter = path.join(userTemp, `TemporaryDirectory.${id.slice(0, 5)}`)
    const swbuildLonger = path.join(userTemp, `swbuild.tmp.${id.slice(0, 8)}x`)
    const swbuildShorter = path.join(userTemp, `swbuild.tmp.${id.slice(0, 7)}`)
    const loose = path.join(userTemp, `ted-${id}`)
    const result = await inSandbox(
      [
        `d=$(mktemp -d '${userTemp}/TemporaryDirectory.XXXXXX') && echo x > "$d/Package.swift" && rm -r "$d" && test ! -e "$d" && echo wrote || echo refused`,
        `d=$(mktemp -d '${userTemp}/swbuild.tmp.XXXXXXXX') && echo x > "$d/build.db" && rm -r "$d" && test ! -e "$d" && echo wrote || echo refused`,
        `mkdir '${longer}' 2>/dev/null && echo wrote || echo refused`,
        `mkdir '${shorter}' 2>/dev/null && echo wrote || echo refused`,
        `mkdir '${swbuildLonger}' 2>/dev/null && echo wrote || echo refused`,
        `mkdir '${swbuildShorter}' 2>/dev/null && echo wrote || echo refused`,
        tryWrite(loose),
      ].join('; '),
      { groups: xcode },
    )
    expect(result.stdout.split('\n').slice(0, 7)).toEqual([
      'wrote',
      'wrote',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
    ])
    for (const dir of [longer, shorter, swbuildLonger, swbuildShorter, loose])
      await rm(dir, { recursive: true, force: true })
  })

  test('a sandboxed command writes actool’s temp items in the per-user temp folder, but no near-miss names, links or other kinds of file', async () => {
    const id = randomUUID().toUpperCase()
    const linkId = randomUUID().toUpperCase()
    const hardLinkId = randomUUID().toUpperCase()
    const pid = 900000 + Math.floor(Math.random() * 90000)
    const at = (name: string) => path.join(userTemp, name)
    const helper = at(`ibtoold-${pid}`)
    const linkedHelper = at(`ibtoold-${pid + 1}`)
    const catalog = at(`Untitled-${id.slice(0, 8)}.uicatalog`)
    const shortCatalog = at(`Untitled-${id.slice(0, 7)}.uicatalog`)
    const png = at(
      `.expo1024x1024_UIAppearanceAny_${id}-${pid}-${id.slice(0, 8)}${id.slice(-8)}.png-a1B2c3`,
    )
    const scratch = at(`actool-sprite-atlas-scratch-${id}`)
    const userHelper = at(`ibtoold-${pid + 2}`)
    await mkdir(path.join(userHelper, 'IB'), { recursive: true })
    const userPipe = path.join(userHelper, 'IB', `${id}.HostToRemote`)
    await execFileAsync('mkfifo', ['-m', '755', userPipe])
    const strictPipe = path.join(userHelper, 'IB', `${linkId}.RemoteToHost`)
    await execFileAsync('mkfifo', ['-m', '700', strictPipe])
    const attempt = (command: string) => `(${command}) 2>/dev/null && echo wrote || echo refused`
    const openPipe = (pipe: string) => `perl -e 'use Fcntl; sysopen(F, q(${pipe}), O_RDWR) or die'`
    const makePipe = (pipe: string) => `perl -MPOSIX -e 'mkfifo(q(${pipe}), 0777) or die'`
    const result = await inSandbox(
      [
        tryWrite(path.join(worktree, 'source.txt')),
        attempt(
          `mkdir '${at(id)}' && echo x > '${at(id)}/assets.uicatalog' && mkdir -p '${at(id)}/expo.icon.xcassets/expo_Assets' && echo x > '${at(id)}/${path.basename(png).slice(1, -7)}'`,
        ),
        attempt(`mkdir '${scratch}'`),
        attempt(
          `mkdir -p '${helper}/IB' && ${makePipe(`${helper}/IB/${id}.HostToRemote`)} && ${openPipe(`${helper}/IB/${id}.HostToRemote`)}`,
        ),
        attempt(`echo x > '${catalog}' && echo x > '${catalog}-journal'`),
        attempt(`echo x > '${png}'`),
        attempt(`mkdir '${helper}-x'`),
        attempt(`mkdir '${helper}/other'`),
        tryWrite(`${helper}/IB/x`),
        attempt(`ln -s '${outside}' '${linkedHelper}'`),
        attempt(`ln -s '${outside}' '${at(linkId)}'`),
        attempt(`ln '${path.join(worktree, 'source.txt')}' '${at(hardLinkId)}'`),
        tryWrite(shortCatalog),
        attempt(`mkfifo '${at(linkId)}'`),
        tryWrite(`${at(id)}/other.txt`),
        attempt(`mkdir '${at(id)}/other'`),
        `ls '${userHelper}' >/dev/null 2>&1 && echo listed || echo refused`,
        `ls '${userHelper}/IB' >/dev/null 2>&1 && echo listed || echo refused`,
        attempt(openPipe(userPipe)),
        attempt(`chmod 777 '${userPipe}'`),
        attempt(`rm '${userPipe}'`),
        attempt(openPipe(strictPipe)),
        attempt(`rm '${strictPipe}'`),
        attempt(
          `mkfifo '${helper}/IB/${linkId}.HostToRemote' && mv -f '${helper}/IB/${linkId}.HostToRemote' '${userPipe}'`,
        ),
        attempt(`chmod 777 '${userHelper}/IB'`),
      ].join('; '),
      { groups: xcode },
    )
    expect(result.stdout.trim().split('\n')).toEqual([
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
    ])
    expect((await stat(userPipe)).mode & 0o777).toBe(0o755)
    expect((await stat(strictPipe)).mode & 0o777).toBe(0o700)
    for (const item of [
      at(id),
      scratch,
      helper,
      userHelper,
      `${helper}-x`,
      linkedHelper,
      catalog,
      `${catalog}-journal`,
      png,
      at(linkId),
      at(hardLinkId),
      shortCatalog,
    ])
      await rm(item, { recursive: true, force: true })
  })

  test('a sandboxed command can’t make ibtoold’s pipes when the user’s own umask already masks others-execute', async () => {
    const helper = path.join(userTemp, `ibtoold-${900000 + Math.floor(Math.random() * 90000)}`)
    const previous = process.umask(0o027)
    try {
      const result = await inSandbox(
        `(mkdir -p '${helper}/IB' && mkfifo '${helper}/IB/${randomUUID().toUpperCase()}.HostToRemote') 2>/dev/null && echo wrote || echo refused`,
        { groups: xcode },
      )
      expect(result.stdout.trim()).toBe('refused')
    } finally {
      process.umask(previous)
      await rm(helper, { recursive: true, force: true })
    }
  })

  test('a sandboxed command writes ibtoold’s storyboard copy in the per-user temp folder, but no near-miss names, links, folders or ibtool’s FIFOs', async () => {
    const id = randomUUID().toUpperCase()
    const at = (name: string) => path.join(userTemp, name)
    const other = () => at(`${randomUUID().toUpperCase()}.storyboard`)
    const story = at(`${id}.storyboard`)
    const longer = at(`${id}.storyboardc`)
    const suffixed = at(`${id}x.storyboard`)
    const shorter = at(`${id.slice(1)}.storyboard`)
    const linked = other()
    const hardLinked = other()
    const folder = other()
    const pipe = (kind: string) =>
      at(`ibu3ZQEwAAAAC0hgEA9QEAAPUBAAA-IBTOOLD-${kind}.${id.replaceAll('-', '').slice(0, 10)}`)
    const items = [
      story,
      longer,
      suffixed,
      shorter,
      linked,
      hardLinked,
      folder,
      pipe('IN'),
      pipe('OUT'),
    ]
    const attempt = (command: string) => `(${command}) 2>/dev/null && echo wrote || echo refused`
    const result = await inSandbox(
      [
        tryWrite(path.join(worktree, 'source.txt')),
        attempt(
          `echo x > '${story}' && echo y >> '${story}' && chmod 600 '${story}' && touch '${story}' && rm '${story}' && echo x > '${story}'`,
        ),
        tryWrite(longer),
        tryWrite(suffixed),
        tryWrite(shorter),
        attempt(`ln -s '${outside}/x' '${linked}'`),
        attempt(`ln '${path.join(worktree, 'source.txt')}' '${hardLinked}'`),
        attempt(`mkdir '${folder}'`),
        attempt(`mkfifo '${pipe('IN')}'`),
        attempt(`mkfifo '${pipe('OUT')}'`),
      ].join('; '),
      { groups: xcode },
    )
    try {
      expect(result.stdout.trim().split('\n')).toEqual([
        'wrote',
        'wrote',
        'refused',
        'refused',
        'refused',
        'refused',
        'refused',
        'refused',
        'refused',
        'refused',
      ])
    } finally {
      for (const item of items) await rm(item, { recursive: true, force: true })
    }
  })

  test('a sandboxed command can’t reach ibtool’s shared-memory registry, so it can’t hand work to the user’s own ibtoold', async () => {
    const id = randomUUID().replaceAll('-', '').slice(0, 20)
    const existing = `ib${id}`
    const fresh = `ib${id.slice(0, 19)}x`
    const control = `ted${id}`
    const script = path.join(tmp, 'shm.py')
    await writeFile(
      script,
      [
        'import _posixshmem, os, sys',
        'op, name = sys.argv[1], sys.argv[2]',
        'flags = {"create": os.O_CREAT | os.O_RDWR, "read": os.O_RDONLY, "write": os.O_RDWR}',
        'try:',
        '    _posixshmem.shm_unlink(name) if op == "unlink" else os.close(_posixshmem.shm_open(name, flags[op], 0o600))',
        '    print("ok")',
        'except OSError:',
        '    print("refused")',
      ].join('\n'),
    )
    const shm = (op: string, name: string) => `/usr/bin/python3 '${script}' ${op} '${name}'`
    const outsideSandbox = async (op: string, name: string) =>
      (await execFileAsync('/usr/bin/python3', [script, op, name])).stdout.trim()
    expect(await outsideSandbox('create', existing)).toBe('ok')
    try {
      const result = await inSandbox(
        [
          shm('read', existing),
          shm('write', existing),
          shm('unlink', existing),
          shm('create', fresh),
          shm('create', control),
          shm('unlink', control),
        ].join('; '),
      )
      expect(result.stdout.trim().split('\n')).toEqual([
        'refused',
        'refused',
        'refused',
        'refused',
        'ok',
        'ok',
      ])
      expect(await outsideSandbox('read', existing)).toBe('ok')
    } finally {
      for (const name of [existing, fresh, control]) await outsideSandbox('unlink', name)
    }
  })

  test('a Ted home inside a lowercase UUID folder in the per-user temp folder gets no rules there', async () => {
    const folder = path.join(userTemp, randomUUID().toLowerCase())
    await mkdir(folder)
    await rm(tedHome, { recursive: true, force: true })
    await makeHome(folder)
    const result = await inSandbox(
      [
        tryWrite(path.join(folder, 'assets.uicatalog')),
        `d=$(mktemp -d '${userTemp}/TemporaryDirectory.XXXXXX' 2>/dev/null) && rm -r "$d" && echo wrote || echo refused`,
      ].join('; '),
      { groups: xcode },
    )
    expect(result.stdout.trim().split('\n')).toEqual(['refused', 'refused'])
    await rm(folder, { recursive: true, force: true })
  })

  test('a sandboxed command can’t list the per-user temp folder or its TemporaryItems folder, but reaches its own folders there by name', async () => {
    const tryList = (dir: string) => `ls '${dir}' >/dev/null 2>&1 && echo listed || echo refused`
    const xcodeSave = path.join(saves, `NSIRD_xcodebuild_${randomUUID()}`)
    const result = await inSandbox(
      [
        tryList(userTemp),
        tryList(`${userTemp}/`),
        tryList(saves),
        `cd '${userTemp}' && ${tryList('.')}`,
        `d=$(mktemp -d '${userTemp}/TemporaryDirectory.XXXXXX') && echo x > "$d/Package.swift" && ls "$d" && cat "$d/Package.swift" && rm -r "$d" && echo reached || echo refused`,
        `mkdir '${xcodeSave}' && echo x > '${xcodeSave}/x' && ls '${xcodeSave}' && echo reached || echo refused`,
      ].join('; '),
      { groups: xcode },
    )
    expect(result.stdout.trim().split('\n')).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
      'Package.swift',
      'x',
      'reached',
      'x',
      'reached',
    ])
    await rm(xcodeSave, { recursive: true, force: true })
  })

  test('without ios-xcode, a sandboxed command gets none of Xcode’s folders and runs with the daemon’s own umask', async () => {
    const id = randomUUID()
    const xcodeSave = path.join(saves, `NSIRD_xcodebuild_${id}`)
    const helper = path.join(userTemp, `ibtoold-${900000 + Math.floor(Math.random() * 90000)}`)
    const home = await realpath(outside)
    const logs = path.join(
      home,
      'Library',
      'Caches',
      'org.swift.swiftpm',
      'manifests',
      'ManifestLoading',
    )
    await mkdir(logs, { recursive: true })
    const previous = process.umask(0o022)
    try {
      const script = [
        `mkdir '${xcodeSave}' 2>/dev/null && echo wrote || echo refused`,
        `d=$(mktemp -d '${userTemp}/TemporaryDirectory.XXXXXX' 2>/dev/null) && rm -r "$d" && echo wrote || echo refused`,
        `d=$(mktemp -d '${userTemp}/swbuild.tmp.XXXXXXXX' 2>/dev/null) && rm -r "$d" && echo wrote || echo refused`,
        `mkdir '${helper}' 2>/dev/null && echo wrote || echo refused`,
        tryWrite(path.join(logs, 'apple.dia')),
        'umask',
      ].join('; ')
      const without = await inSandbox(script, { home })
      expect(without.stdout.trim().split('\n')).toEqual([
        'refused',
        'refused',
        'refused',
        'refused',
        'refused',
        '0022',
      ])
      const granted = await inSandbox(script, { home, groups: xcode })
      expect(granted.stdout.trim().split('\n')).toEqual([
        'wrote',
        'wrote',
        'wrote',
        'wrote',
        'wrote',
        '0023',
      ])
    } finally {
      process.umask(previous)
      for (const dir of [xcodeSave, helper]) await rm(dir, { recursive: true, force: true })
    }
  })

  test('ios-xcode reads iPhoneOS Simulator runtime mounts and nothing else beside them', async () => {
    const mounts = await realpath(outside)
    const runtime = path.join(mounts, 'com.apple.iPhoneOS.SimulatorRuntime-v24.2.8117.0.wYKdh7')
    const profile = path.join(runtime, 'Library', 'Info.plist')
    const watch = path.join(mounts, 'com.apple.watchOS.SimulatorRuntime-v24.2.1.0.AbCdEf', 'a')
    const other = path.join(mounts, 'com.apple.iPhoneOS.SimulatorRuntimeX', 'a')
    for (const file of [profile, watch, other]) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, 'x')
    }
    const script = [
      tryRead(profile),
      `ls '${runtime}' >/dev/null 2>&1 && echo read || echo refused`,
      tryRead(watch),
      tryRead(other),
      `ls '${mounts}' >/dev/null 2>&1 && echo read || echo refused`,
      tryWrite(profile),
      tryWrite(path.join(runtime, 'new')),
    ].join('; ')
    const granted = await inSandbox(script, { groups: xcode, simulatorRuntimes: mounts })
    expect(granted.stdout.trim().split('\n')).toEqual([
      'read',
      'read',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
    ])
    const without = await inSandbox(script, { simulatorRuntimes: mounts })
    expect(without.stdout.trim().split('\n').slice(0, 2)).toEqual(['refused', 'refused'])
  })

  test('git reads the worktree through the Task’s clone', async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileAsync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
        cwd,
      })
    await git(clone, 'init', '-q', '-b', 'main')
    await writeFile(path.join(clone, 'a.txt'), 'a')
    await git(clone, 'add', '.')
    await git(clone, 'commit', '-qm', 'first')
    await rm(worktree, { recursive: true })
    await git(clone, 'worktree', 'add', '-q', '-b', 'task', worktree)
    const result = await inSandbox('echo b > b.txt; git status --porcelain; git log --format=%s')
    expect(result.stdout.trim().split('\n')).toEqual(['?? b.txt', 'first'])
  })

  test('it can’t read TED_HOME’s keys or another Task’s worktree', async () => {
    const other = path.join(tedHome, 'worktrees', 'NB-2', 'widgets')
    await mkdir(other, { recursive: true })
    await writeFile(path.join(other, 'secret.txt'), 'secret')
    await writeFile(path.join(tedHome, 'daemon.json'), '{"token":"x"}')
    const result = await inSandbox(
      [
        tryRead(path.join(tedHome, 'daemon.json')),
        tryRead(path.join(other, 'secret.txt')),
        `ls '${tedHome}' >/dev/null 2>&1 && echo listed || echo refused`,
      ].join('; '),
    )
    expect(result.stdout.trim().split('\n')).toEqual(['refused', 'refused', 'refused'])
  })

  test('it can’t write the rest of TED_HOME, the daemon’s temp folder or the home folder', async () => {
    const homeFile = path.join(homedir(), `.ted-sandbox-${randomUUID()}`)
    await writeFile(path.join(tedHome, 'daemon.json'), '{}')
    try {
      const result = await inSandbox(
        [
          tryWrite(path.join(tedHome, 'daemon.json')),
          tryWrite(path.join(tedHome, 'run-token.key')),
          tryWrite(path.join(outside, 'c.txt')),
          tryWrite(homeFile),
          tryWrite(path.join(homedir(), '.npm', `ted-${randomUUID()}`)),
          `ln -s /etc '${path.join(worktree, 'link')}' && ${tryWrite(path.join(worktree, 'link', 'x'))}`,
        ].join('; '),
      )
      expect(result.stdout.trim().split('\n')).toEqual([
        'refused',
        'refused',
        'refused',
        'refused',
        'refused',
        'refused',
      ])
      expect(await readFile(path.join(tedHome, 'daemon.json'), 'utf8')).toBe('{}')
      await expect(readFile(homeFile)).rejects.toThrow()
    } finally {
      await rm(homeFile, { force: true })
    }
  })

  test('it can’t read or write the personal folders macOS guards, except its own folders in one', async () => {
    const home = await realpath(outside)
    await mkdir(path.join(home, 'Desktop'))
    await writeFile(path.join(home, 'Desktop', 'secret.txt'), 'secret')
    await mkdir(path.join(home, 'Library', 'Mobile Documents'), { recursive: true })
    await writeFile(path.join(home, 'Library', 'Mobile Documents', 'cloud.txt'), 'cloud')
    tedHome = path.join(home, 'Documents', 'ted-home')
    worktree = path.join(tedHome, 'worktrees', 'NB-1', 'widgets')
    clone = path.join(tedHome, 'repos', 'k', 'widgets')
    tmp = path.join(tedHome, 'sandbox', 'NB-1', 'tmp-1')
    for (const dir of [worktree, clone, tmp]) await mkdir(dir, { recursive: true })
    await writeFile(path.join(worktree, 'own.txt'), 'own')
    await writeFile(path.join(home, 'Documents', 'letter.txt'), 'letter')

    const result = await inSandbox(
      [
        tryRead(path.join(home, 'Desktop', 'secret.txt')),
        tryRead(path.join(home, 'Library', 'Mobile Documents', 'cloud.txt')),
        tryRead(path.join(home, 'Documents', 'letter.txt')),
        `ls '${path.join(home, 'Documents')}' >/dev/null 2>&1 && echo listed || echo refused`,
        tryRead(path.join(worktree, 'own.txt')),
        tryWrite(path.join(worktree, 'new.txt')),
      ].join('; '),
      { home },
    )
    expect(result.stdout.trim().split('\n')).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
      'read',
      'wrote',
    ])
  })

  test('it reads no credentials in the home folder, only Git’s settings, toolchains and what the Factory lists', async () => {
    const home = await realpath(outside)
    const files = {
      ssh: path.join(home, '.ssh', 'id_ed25519'),
      aws: path.join(home, '.aws', 'credentials'),
      gh: path.join(home, '.config', 'gh', 'hosts.yml'),
      npmrc: path.join(home, '.npmrc'),
      gitCredentials: path.join(home, '.config', 'git', 'credentials'),
      gemCredentials: path.join(home, '.gem', 'credentials'),
      gitconfig: path.join(home, '.gitconfig'),
      xdgGitconfig: path.join(home, '.config', 'git', 'config'),
      gem: path.join(home, '.gem', 'ruby', '3.3.0', 'bin', 'pod'),
      nvm: path.join(home, '.nvm', 'alias', 'default'),
      desktop: path.join(home, 'Desktop', 'notes.txt'),
    }
    for (const file of Object.values(files)) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, 'x')
    }
    const script = [
      ...Object.values(files).map(tryRead),
      `ls '${home}' >/dev/null 2>&1 && echo listed || echo refused`,
      `'${process.execPath}' -e "console.log('node ran')"`,
    ].join('; ')

    const plain = await inSandbox(script, { home })
    expect(plain.stdout.trim().split('\n')).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'read',
      'read',
      'read',
      'read',
      'refused',
      'refused',
      'node ran',
    ])

    const listed = await inSandbox(script, { home, reads: ['~/.config/gh', '~/Desktop'] })
    expect(listed.stdout.trim().split('\n')).toEqual([
      'refused',
      'refused',
      'read',
      'refused',
      'refused',
      'refused',
      'read',
      'read',
      'read',
      'read',
      'refused',
      'refused',
      'node ran',
    ])
  })

  test('a file outside the base read set can’t be read or listed', async () => {
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    const result = await inSandbox(
      [
        tryRead(path.join(outside, 'secret.txt')),
        `ls '${outside}' >/dev/null 2>&1 && echo listed || echo refused`,
        tryRead('/etc/hosts'),
        tryRead('/usr/bin/true'),
      ].join('; '),
    )
    expect(result.stdout.trim().split('\n')).toEqual(['refused', 'refused', 'read', 'read'])
  })

  test('it reads the DNS settings in /etc/resolv.conf, but nothing else in /private/var/run', async () => {
    const result = await inSandbox(
      [tryRead('/etc/resolv.conf'), tryRead('/private/var/run/utmpx')].join('; '),
    )
    expect(result.stdout.trim().split('\n')).toEqual(['read', 'refused'])
  })

  test('a scope limited to its own temp folder can’t write /private/tmp or the per-user temp folder', async () => {
    const sandbox = createSandbox({ tedHome, env: () => process.env })
    const shared = path.join('/private/tmp', `ted-sandbox-${randomUUID()}`)
    const swift = path.join(userTemp, `TemporaryDirectory.${randomUUID().slice(0, 6)}`)
    const script = `${tryWrite(shared)}; mkdir '${swift}' 2>/dev/null && echo made || echo refused; ${tryWrite(path.join(tmp, 'own'))}`
    try {
      const { argv, env } = await sandbox.wrap(['/bin/sh', '-c'], {
        ...scope(),
        ownTempOnly: true,
        groups: ['ios-xcode', 'shared-tmp'],
      })
      const [command, ...args] = argv
      const { stdout } = await execFileAsync(command, [...args, script], {
        cwd: worktree,
        env: { ...process.env, ...env },
      })
      expect(stdout.trim().split('\n')).toEqual(['refused', 'refused', 'wrote'])
    } finally {
      await rm(shared, { force: true })
      await rm(swift, { recursive: true, force: true })
    }
  })

  test('the shared /private/tmp is closed unless the command has shared-tmp', async () => {
    const id = randomUUID()
    const planted = path.join('/private/tmp', `ted-sandbox-${id}-planted`)
    const made = path.join('/private/tmp', `ted-sandbox-${id}-made`)
    await writeFile(planted, 'x')
    const script = (target: string) =>
      [
        tryWrite(target),
        `ln -s '${outside}' '${target}.link' 2>/dev/null && echo linked || echo refused`,
        tryRead(planted),
        tryWrite(`/tmp/ted-sandbox-${id}-via-link`),
      ].join('; ')
    try {
      const plain = await inSandbox(script(made))
      expect(plain.stdout.trim().split('\n')).toEqual(['refused', 'refused', 'refused', 'refused'])
      const others = await inSandbox(script(made), { groups: xcode })
      expect(others.stdout.trim().split('\n')).toEqual(['refused', 'refused', 'refused', 'refused'])
      const shared = await inSandbox(script(made), { groups: ['shared-tmp'] })
      expect(shared.stdout.trim().split('\n')).toEqual(['wrote', 'linked', 'read', 'wrote'])
    } finally {
      for (const file of [planted, made, `${made}.link`, `/private/tmp/ted-sandbox-${id}-via-link`])
        await rm(file, { force: true })
    }
  })

  test('it writes plain .dia files in SwiftPM’s ManifestLoading folder and nothing else in SwiftPM’s caches', async () => {
    const home = await realpath(outside)
    const manifests = path.join(home, 'Library', 'Caches', 'org.swift.swiftpm', 'manifests')
    const logs = path.join(manifests, 'ManifestLoading')
    const target = path.join(home, 'target.txt')
    await writeFile(target, 'keep')
    const result = await inSandbox(
      [
        tryWrite(path.join(logs, 'apple.dia')),
        `ln -s '${target}' '${path.join(logs, 'linked.dia')}' 2>/dev/null && echo wrote || echo refused`,
        `ln '${target}' '${path.join(logs, 'hard.dia')}' 2>/dev/null && echo wrote || echo refused`,
        `echo own > own.txt && ln own.txt '${path.join(logs, 'own.dia')}' 2>/dev/null && echo wrote || echo refused`,
        `mkdir '${path.join(logs, 'folder.dia')}' 2>/dev/null && echo wrote || echo refused`,
        tryWrite(path.join(logs, 'apple.txt')),
        tryWrite(path.join(manifests, 'manifest.db')),
        `mv '${logs}' '${path.join(manifests, 'moved')}' 2>/dev/null && echo wrote || echo refused`,
      ].join('; '),
      { home, groups: xcode },
    )
    expect(result.stdout.trim().split('\n')).toEqual([
      'wrote',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
    ])
    expect(await readFile(target, 'utf8')).toBe('keep')
  })

  test('it opens no SwiftPM folder that leads somewhere else through a link', async () => {
    const home = await realpath(outside)
    const manifests = path.join(home, 'Library', 'Caches', 'org.swift.swiftpm', 'manifests')
    const elsewhere = path.join(home, 'elsewhere')
    await mkdir(manifests, { recursive: true })
    await mkdir(elsewhere)
    await symlink(elsewhere, path.join(manifests, 'ManifestLoading'))
    const result = await inSandbox(tryWrite(path.join(manifests, 'ManifestLoading', 'apple.dia')), {
      home,
      groups: xcode,
    })
    expect(result.stdout.trim()).toBe('refused')
  })

  test('a scope limited to its own temp folder gets no SwiftPM ManifestLoading grant', async () => {
    const home = await realpath(outside)
    const logs = path.join(
      home,
      'Library',
      'Caches',
      'org.swift.swiftpm',
      'manifests',
      'ManifestLoading',
    )
    await mkdir(logs, { recursive: true })
    const sandbox = createSandbox({ tedHome, env: () => ({ ...process.env, HOME: home }) })
    const { argv, env } = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), ownTempOnly: true })
    const [command, ...args] = argv
    const { stdout } = await execFileAsync(
      command,
      [...args, tryWrite(path.join(logs, 'apple.dia'))],
      {
        cwd: worktree,
        env: { ...process.env, ...env },
      },
    )
    expect(stdout.trim()).toBe('refused')
  })

  test('it can’t hand work to launchd or write preferences through cfprefsd', async () => {
    const label = `ted.sandbox.${randomUUID()}`
    const marker = path.join(outside, 'launched')
    try {
      const result = await inSandbox(
        [
          `launchctl submit -l ${label} -- /usr/bin/touch '${marker}' 2>/dev/null && echo submitted || echo refused`,
          `defaults write ${label} k v 2>/dev/null && echo written || echo refused`,
          'open -g -a Finder 2>/dev/null && echo opened || echo refused',
        ].join('; '),
      )
      expect(result.stdout.trim().split('\n')).toEqual(['refused', 'refused', 'refused'])
    } finally {
      await execFileAsync('launchctl', ['remove', label]).catch(() => undefined)
      await execFileAsync('defaults', ['delete', label]).catch(() => undefined)
    }
  })
  test('it reaches only the listed system services, so not the keychain or the pasteboard', async () => {
    const result = await inSandbox(
      [
        'security show-keychain-info /Library/Keychains/System.keychain >/dev/null 2>&1 && echo keychain || echo refused',
        'pbpaste >/dev/null 2>&1 && echo pasteboard || echo refused',
        'id -un',
        `node -e 'require("node:dns").lookup("localhost", (e) => console.log(e ? "no dns" : "dns"))'`,
      ].join('; '),
    )
    expect(result.stdout.trim().split('\n')).toEqual([
      'refused',
      'refused',
      userInfo().username,
      'dns',
    ])
  })

  test('only a sandbox with the electron group reaches launchservicesd and the window server, and it says so in its environment', async () => {
    const sandbox = createSandbox({ tedHome, env: () => process.env })
    const plain = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), groups: ['ios-xcode'] })
    const electron = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), groups: ['electron'] })
    for (const service of [
      'com.apple.coreservices.launchservicesd',
      'com.apple.windowserver.active',
    ]) {
      expect(plain.argv.join('\n')).not.toContain(service)
      expect(electron.argv.join('\n')).toContain(`(global-name "${service}")`)
    }
    expect(plain.env.TED_SANDBOX_ELECTRON).toBeUndefined()
    expect(electron.env.TED_SANDBOX_ELECTRON).toBe('1')
  })

  test('without a grant it reaches only loopback, none closes loopback too, and outbound or the network group lifts the IP rule', async () => {
    const { server, port } = await listenTcp()
    const sandbox = createSandbox({ tedHome, env: () => process.env })
    const wrap = (extra: {
      network?: 'none' | 'localhost' | 'outbound'
      groups?: SandboxAccess[]
    }) => sandbox.wrap(['/bin/sh', '-c'], { ...scope(), ...extra })
    const attempt = async (
      extra: { network?: 'none' | 'localhost' | 'outbound'; groups?: SandboxAccess[] },
      hosts: readonly string[],
    ) => {
      const { argv, env } = await wrap(extra)
      const [command, ...args] = argv
      const { stdout } = await execFileAsync(
        command,
        [...args, hosts.map((host) => tryTcp(host, port)).join('; ')],
        { cwd: worktree, env: withSandboxEnv(process.env, env) },
      )
      return stdout.trim().split('\n')
    }
    try {
      expect(await attempt({}, ['127.0.0.1', outsideAddress])).toEqual(['connected', 'EPERM'])
      expect(await attempt({ network: 'localhost' }, ['127.0.0.1', outsideAddress])).toEqual([
        'connected',
        'EPERM',
      ])
      expect(await attempt({ network: 'none' }, ['127.0.0.1', outsideAddress])).toEqual([
        'EPERM',
        'EPERM',
      ])
      expect(await attempt({ network: 'outbound' }, ['127.0.0.1'])).toEqual(['connected'])
      expect(await attempt({ network: 'none', groups: ['network'] }, ['127.0.0.1'])).toEqual([
        'connected',
      ])
      expect((await wrap({})).argv.join('\n')).toContain(denyIp)
      expect((await wrap({ network: 'outbound' })).argv.join('\n')).not.toContain(denyIp)
      expect((await wrap({ network: 'none', groups: ['network'] })).argv.join('\n')).not.toContain(
        denyIp,
      )
    } finally {
      server.close()
    }
  })

  test('only an outbound grant reaches mDNSResponder, so lookups can’t carry data out', async () => {
    const sandbox = createSandbox({ tedHome, env: () => process.env })
    const closed = await sandbox.wrap(['/bin/sh', '-c'], scope())
    const open = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), groups: ['network'] })
    expect(closed.argv.join('\n')).not.toContain('mDNSResponder')
    expect(open.argv.join('\n')).toContain('mDNSResponder')
    const result = await inSandbox(
      `'${process.execPath}' -e "require('dns').lookup('localhost', (error) => console.log(error ? 'unresolved' : 'resolved'))"`,
    )
    expect(result.stdout.trim()).toBe('resolved')
  })

  test('it reaches Unix sockets only in its own folders and the Library sockets its access names', async (context) => {
    const own = path.join(tmp, 'o.s')
    const listed = path.join(outside, 'listed.sock')
    const other = path.join(outside, 'other.sock')
    skipLongSockets(context, [own, listed, other])
    const servers = await Promise.all([own, listed, other].map(listen))
    try {
      const result = await inSandbox(
        [tryConnect(own), tryConnect(listed), tryConnect(other), 'echo resolved'].join('; '),
        {
          sockets: [
            { name: 'listed', path: listed },
            { name: 'other', path: other },
          ],
          groups: ['socket:listed'],
        },
      )
      expect(result.stdout.trim().split('\n')).toEqual([
        'connected',
        'connected',
        'refused',
        'resolved',
      ])
      const unasked = await inSandbox(tryConnect(listed), {
        sockets: [{ name: 'listed', path: listed }],
      })
      expect(unasked.stdout.trim()).toBe('refused')
    } finally {
      for (const server of servers) server.close()
    }
  })
})

describe.runIf(process.platform === 'linux')('the sandbox on Linux', () => {
  let userHome: string
  beforeEach(async (context) => {
    skipInsideTedSandbox(context)
    userHome = await mkdtemp('/var/tmp/ted-sandbox-user-')
    const secrets: [string, string][] = [
      ['.ssh', 'id_rsa'],
      ['.aws', 'credentials'],
      ['.config/gh', 'hosts.yml'],
    ]
    for (const [dir, file] of secrets) {
      await mkdir(path.join(userHome, dir), { recursive: true })
      await writeFile(path.join(userHome, dir, file), 'secret')
    }
  })

  afterEach(async () => {
    await rm(userHome, { recursive: true, force: true })
  })

  async function inBwrap(script: string, reads: string[] = []) {
    const sandbox = createSandbox({ tedHome, env: () => ({ ...process.env, HOME: userHome }) })
    const wrapped = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), reads })
    const [command, ...args] = wrapped.argv
    try {
      return await new Promise<string>((resolve, reject) => {
        let stdout = ''
        const child = spawn(command, [...args, script], {
          cwd: worktree,
          env: withSandboxEnv(process.env, wrapped.env),
          stdio: ['ignore', 'pipe', 'inherit', ...wrapped.fds],
        })
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        child.once('error', reject)
        child.once('close', () => resolve(stdout))
      })
    } finally {
      await wrapped.close()
    }
  }

  test('a sandboxed command can’t read files in HOME outside the allowed set', async () => {
    const output = await inBwrap(
      [
        tryRead(path.join(userHome, '.ssh', 'id_rsa')),
        tryRead(path.join(userHome, '.aws', 'credentials')),
        tryRead(path.join(userHome, '.config', 'gh', 'hosts.yml')),
        tryWrite(path.join(worktree, 'a.txt')),
        tryRead('/etc/passwd'),
      ].join('; '),
    )
    expect(output.split('\n').slice(0, 5)).toEqual([
      'refused',
      'refused',
      'refused',
      'wrote',
      'read',
    ])
  })

  test('a folder listed in sandbox_reads can be read, and nothing beside it', async () => {
    const output = await inBwrap(
      [
        tryRead(path.join(userHome, '.config', 'gh', 'hosts.yml')),
        tryRead(path.join(userHome, '.ssh', 'id_rsa')),
        tryWrite(path.join(userHome, '.config', 'gh', 'hosts.yml')),
      ].join('; '),
      ['~/.config/gh'],
    )
    expect(output.split('\n').slice(0, 3)).toEqual(['read', 'refused', 'refused'])
  })
})

describe('the folders a sandbox opens', () => {
  test('a worktree swapped for a link to somewhere else is refused', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => process.env,
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    await rename(worktree, `${worktree}.bak`)
    await symlink(tedHome, worktree)
    await expect(sandbox.wrap(['/bin/sh', '-c'], scope())).rejects.toThrow(/isn’t a plain folder/)
  })

  test('on Linux, shared-tmp changes nothing, because /tmp is already the command’s own temp folder', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => process.env,
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
      bindFds: true,
    })
    const plain = await sandbox.wrap(['/bin/sh', '-c'], scope())
    const shared = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), groups: ['shared-tmp'] })
    await Promise.all([plain.close(), shared.close()])
    expect(shared.argv).toEqual(plain.argv)
    expect(shared.argv.join(' ')).toContain('--bind-fd 3 /tmp')
  })

  test('two starts at once both make it past the new Task cache', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => process.env,
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const both = await Promise.all([1, 2].map(() => sandbox.wrap(['/bin/sh', '-c'], scope())))
    expect(both).toHaveLength(2)
  })

  test('no open folder sits inside another writable one', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => process.env,
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const taskFolder = path.dirname(worktree)
    await expect(
      sandbox.wrap(['/bin/sh', '-c'], { ...scope(), writable: [taskFolder, worktree] }),
    ).rejects.toThrow(/sits inside/)
    await expect(
      sandbox.wrap(['/bin/sh', '-c'], { ...scope(), cache: path.join(worktree, 'cache') }),
    ).rejects.toThrow(/sits inside/)
  })

  test('a folder outside TED_HOME is refused', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => process.env,
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    await expect(
      sandbox.wrap(['/bin/sh', '-c'], { ...scope(), writable: [outside] }),
    ).rejects.toThrow(/isn’t inside Ted’s folder/)
  })

  test('on Linux, TED_HOME is hidden and only the Task’s folders come back', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin' }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const { argv } = await sandbox.wrap(['/bin/sh', '-c'], scope())
    const home = await realpath(tedHome)
    const real = await realpath(worktree)
    expect(argv.join(' ')).toContain(`--tmpfs ${home}`)
    expect(argv.join(' ')).toContain(`--ro-bind ${await realpath(clone)}`)
    expect(argv.join(' ')).toContain(`--bind ${real} ${real}`)
    expect(argv.indexOf(home)).toBeLessThan(argv.indexOf(real))
  })

  test('on Linux, bwrap mounts the base read set and sandbox_reads, never the host root', async () => {
    const userHome = await mkdtemp(path.join(outside, 'home-'))
    for (const dir of ['.nvm', '.ssh', '.config/gh', 'Documents/notes']) {
      await mkdir(path.join(userHome, dir), { recursive: true })
    }
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin', HOME: userHome }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const realHome = await realpath(userHome)
    const { argv } = await sandbox.wrap(['/bin/sh', '-c'], {
      ...scope(),
      reads: ['~/.config/gh', '~/Documents/notes'],
    })
    const pairs = argv.flatMap((arg, i) =>
      arg === '--ro-bind' ? [`${argv[i + 1]} ${argv[i + 2]}`] : [],
    )
    expect(pairs).not.toContain('/ /')
    expect(pairs).toContain('/usr /usr')
    expect(pairs).toContain(`${path.join(realHome, '.nvm')} ${path.join(realHome, '.nvm')}`)
    expect(pairs).toContain(
      `${path.join(realHome, '.config/gh')} ${path.join(realHome, '.config/gh')}`,
    )
    const joined = argv.join(' ')
    expect(joined).not.toContain(path.join(realHome, '.ssh'))
    expect(joined).not.toContain(path.join(realHome, 'Documents'))
    expect(argv.lastIndexOf(path.join(realHome, '.nvm'))).toBeLessThan(argv.indexOf('--dev'))
    expect(argv.indexOf(path.join(realHome, '.config/gh'))).toBeLessThan(
      argv.lastIndexOf(await realpath(tedHome)),
    )
  })

  test('on Linux, a chain of linked folders in the read set is linked straight to where it really is', async () => {
    const tools = path.join(outside, 'versions', 'v1')
    await mkdir(tools, { recursive: true })
    await symlink('v1', path.join(outside, 'versions', 'current'))
    await symlink('versions/current', path.join(outside, 'tools'))
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: `/usr/bin:${path.join(outside, 'tools')}` }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const { argv } = await sandbox.wrap(['/bin/sh', '-c'], scope())
    const realTools = await realpath(tools)
    const after = (flag: string) =>
      argv.flatMap((arg, i) => (arg === flag ? [`${argv[i + 1]} ${argv[i + 2]}`] : []))
    expect(after('--ro-bind')).toContain(`${realTools} ${realTools}`)
    expect(after('--symlink')).toContain(`${realTools} ${path.join(outside, 'tools')}`)
  })

  test('on Linux, a sandbox_reads entry that leads into TED_HOME through a link isn’t mounted', async () => {
    const userHome = await mkdtemp(path.join(outside, 'home-'))
    await mkdir(path.join(userHome, '.config'))
    await symlink(tedHome, path.join(userHome, '.config', 'ted-alias'))
    await writeFile(path.join(tedHome, 'credentials'), 'secret')
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin', HOME: userHome }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const { argv } = await sandbox.wrap(['/bin/sh', '-c'], {
      ...scope(),
      reads: ['~/.config/ted-alias/credentials', '~/.config/ted-alias'],
    })
    const joined = argv.join(' ')
    expect(joined).not.toContain('ted-alias')
    expect(joined).not.toContain(path.join(await realpath(tedHome), 'credentials'))
  })

  test('on Linux, a sandbox_reads entry reached through a link is only a link, so a TED_HOME inside it stays hidden', async () => {
    const holder = path.join(outside, 'holder')
    await mkdir(path.join(holder, 'inner'), { recursive: true })
    await rm(tedHome, { recursive: true, force: true })
    await makeHome(path.join(holder, 'inner'))
    const userHome = await mkdtemp(path.join(outside, 'home-'))
    await symlink(holder, path.join(userHome, 'x'))
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin', HOME: userHome }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const { argv } = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), reads: ['~/x/inner'] })
    const realInner = await realpath(path.join(holder, 'inner'))
    const alias = path.join(userHome, 'x', 'inner')
    const after = (flag: string) =>
      argv.flatMap((arg, i) => (arg === flag ? [`${argv[i + 1]} ${argv[i + 2]}`] : []))
    expect(after('--ro-bind')).toContain(`${realInner} ${realInner}`)
    expect(after('--ro-bind').some((pair) => pair.endsWith(` ${alias}`))).toBe(false)
    expect(after('--symlink')).toContain(`${realInner} ${alias}`)
    expect(argv.lastIndexOf(await realpath(tedHome))).toBeGreaterThan(argv.indexOf(realInner))
  })

  test('on Linux, a command gets its own network unless it has outbound access or is an App serving a port', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin' }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const ownNetwork = async (extra: {
      network?: 'none' | 'localhost' | 'outbound'
      serves?: boolean
      groups?: SandboxAccess[]
    }) =>
      (await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), ...extra })).argv.includes(
        '--unshare-net',
      )
    expect(await ownNetwork({})).toBe(true)
    expect(await ownNetwork({ network: 'none' })).toBe(true)
    expect(await ownNetwork({ network: 'outbound' })).toBe(false)
    expect(await ownNetwork({ groups: ['network'] })).toBe(false)
    expect(await ownNetwork({ serves: true })).toBe(false)
    expect(await ownNetwork({ network: 'none', serves: true })).toBe(true)
  })

  test('on Linux, a scope that hides protected folders covers each one that exists in HOME', async () => {
    const userHome = await mkdtemp(path.join(outside, 'home-'))
    await mkdir(path.join(userHome, 'Documents'))
    await mkdir(path.join(userHome, 'Library', 'Mail'), { recursive: true })
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin', HOME: userHome }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const realHome = await realpath(userHome)
    const plain = (await sandbox.wrap(['/bin/sh', '-c'], scope())).argv.join(' ')
    expect(plain).not.toContain(path.join(realHome, 'Documents'))
    const { argv } = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), hideProtected: true })
    const joined = argv.join(' ')
    expect(joined).toContain(`--tmpfs ${path.join(realHome, 'Documents')}`)
    expect(joined).toContain(`--tmpfs ${path.join(realHome, 'Library', 'Mail')}`)
    expect(joined).not.toContain(path.join(realHome, 'Downloads'))
  })

  test.skipIf(tmpdir().startsWith('/tmp'))(
    'on Linux, sockets outside the Task are covered and listed ones stay open',
    async (context) => {
      const runtime = path.join(outside, 'run')
      await mkdir(runtime)
      const listed = path.join(outside, 'listed.sock')
      const listedInRuntime = path.join(runtime, 'agent.sock')
      const other = path.join(outside, 'other.sock')
      const inClone = path.join(clone, 'c.s')
      const own = path.join(worktree, 'o.s')
      const sockets = [listed, listedInRuntime, other, inClone, own]
      skipLongSockets(context, sockets)
      const servers = await Promise.all(sockets.map(listen))
      try {
        const names = [
          listed,
          listedInRuntime,
          `${outside}//./other.sock`,
          inClone,
          own,
          path.join(outside, 'gone.sock'),
          '@abstract',
          'relative.sock',
        ]
        const table = [
          'Num       RefCount Protocol Flags    Type St Inode Path',
          ...names.map(
            (socket, i) =>
              `0000000000000000: 00000002 00000000 00010000 0001 01 ${1000 + i} ${socket}`,
          ),
        ].join('\n')
        const sandbox = createSandbox({
          tedHome,
          env: () => ({ PATH: '/usr/bin:/bin', HOME: outside, XDG_RUNTIME_DIR: runtime }),
          platform: 'linux',
          program: '/usr/bin/true',
          unixSockets: async () => table,
        })
        const { argv } = await sandbox.wrap(['/bin/sh', '-c'], {
          ...scope(),
          sockets: [
            { name: 'listed', path: '~/listed.sock' },
            { name: 'agent', path: '~/run/agent.sock' },
            { name: 'other', path: '~/other.sock' },
          ],
          groups: ['socket:listed', 'socket:agent'],
        })
        const after = (flag: string, source?: string) =>
          argv.flatMap((arg, i) =>
            arg === flag && (source === undefined || argv[i + 1] === source) ? [argv[i + 2]] : [],
          )
        expect(after('--ro-bind', '/dev/null')).toEqual([
          await realpath(other),
          await realpath(inClone),
        ])
        const restored = await realpath(listedInRuntime)
        expect(after('--ro-bind', restored)).toEqual([restored])
        expect(argv.indexOf(restored)).toBeGreaterThan(argv.lastIndexOf('--tmpfs'))
        expect(argv.lastIndexOf('/dev/null')).toBeGreaterThan(argv.indexOf(await realpath(clone)))
      } finally {
        for (const server of servers) server.close()
      }
    },
  )

  test('on Linux, a sandbox that can’t list the machine’s sockets is a problem and refuses to run', async () => {
    let readable = true
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin' }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => {
        if (!readable) throw new Error('EACCES')
        return ''
      },
    })
    expect(await sandbox.problem()).toBeUndefined()
    readable = false
    expect(await sandbox.problem()).toMatch(/couldn’t list this machine’s Unix sockets/)
    await expect(sandbox.wrap(['/bin/sh', '-c'], scope())).rejects.toThrow(
      /couldn’t list this machine’s Unix sockets/,
    )
  })

  test('on Linux, a socket named through a linked folder and .. is covered where it really is', async (context) => {
    const service = path.join(clone, 's')
    skipLongSockets(context, [path.join(service, 'c.s')])
    await mkdir(path.join(service, 'n'), { recursive: true })
    await symlink(path.join(service, 'n'), path.join(clone, 'l'))
    const server = await listen(path.join(service, 'c.s'))
    try {
      const sandbox = createSandbox({
        tedHome,
        env: () => ({ PATH: '/usr/bin:/bin' }),
        platform: 'linux',
        program: '/usr/bin/true',
        unixSockets: async () =>
          `Num       RefCount Protocol Flags    Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 1000 ${clone}/l/../c.s`,
      })
      const { argv } = await sandbox.wrap(['/bin/sh', '-c'], scope())
      expect(argv[argv.lastIndexOf('/dev/null') + 1]).toBe(
        await realpath(path.join(service, 'c.s')),
      )
    } finally {
      server.close()
    }
  })

  test('on Linux, a socket in a clone is covered even when TED_HOME sits in the runtime folder', async (context) => {
    const inClone = path.join(clone, 'c.s')
    skipLongSockets(context, [inClone])
    const server = await listen(inClone)
    try {
      const sandbox = createSandbox({
        tedHome,
        env: () => ({ PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: path.dirname(tedHome) }),
        platform: 'linux',
        program: '/usr/bin/true',
        unixSockets: async () =>
          `Num       RefCount Protocol Flags    Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 1000 ${inClone}`,
      })
      const { argv } = await sandbox.wrap(['/bin/sh', '-c'], scope())
      expect(argv[argv.lastIndexOf('/dev/null') + 1]).toBe(await realpath(inClone))
    } finally {
      server.close()
    }
  })

  test('on Linux with --bind-fd, bwrap gets each folder as an open descriptor', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin' }),
      platform: 'linux',
      program: '/usr/bin/true',
      bindFds: true,
      unixSockets: async () => '',
    })
    const wrapped = await sandbox.wrap(['/bin/sh', '-c'], scope())
    try {
      const real = await realpath(worktree)
      const line = wrapped.argv.join(' ')
      expect(wrapped.fds).toHaveLength(5)
      expect(line).toContain('--bind-fd 3 /tmp')
      expect(line).toContain(`--ro-bind-fd 4 ${await realpath(clone)}`)
      expect(line).toContain(`--bind-fd 5 ${real}`)
      expect(line).not.toContain(`--bind ${real}`)
    } finally {
      await wrapped.close()
    }
  })

  test('unixSocketPaths reads bound paths from /proc/net/unix and skips abstract ones', () => {
    expect(
      unixSocketPaths(
        [
          'Num       RefCount Protocol Flags    Type St Inode Path',
          '0000000000000000: 00000002 00000000 00010000 0001 01 20 /run/docker.sock',
          '0000000000000000: 00000002 00000000 00010000 0001 01 21 @/tmp/.X11-unix/X0',
          '0000000000000000: 00000003 00000000 00000000 0001 03 22',
          '0000000000000000: 00000002 00000000 00010000 0001 01 23 /home/a b/agent.sock',
          '0000000000000000: 00000002 00000000 00010000 0001 01 24 /home/u/svc//./c.sock',
          '0000000000000000: 00000002 00000000 00010000 0001 01 25 relative.sock',
        ].join('\n'),
      ),
    ).toEqual(['/run/docker.sock', '/home/a b/agent.sock', '/home/u/svc//./c.sock'])
  })
})

describe('the environment a sandbox gives', () => {
  test('the JVM’s temp folder is the sandbox’s own, after any JAVA_TOOL_OPTIONS already set', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin', JAVA_TOOL_OPTIONS: '-Xmx1g' }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const { env } = await sandbox.wrap(['/bin/sh', '-c'], scope())
    const own = `-Djava.io.tmpdir="${env.TMPDIR}"`
    expect(env.JAVA_TOOL_OPTIONS).toBe(own)
    expect(withSandboxEnv({ JAVA_TOOL_OPTIONS: '-Xmx1g' }, env).JAVA_TOOL_OPTIONS).toBe(
      `-Xmx1g ${own}`,
    )
    expect(withSandboxEnv({ JAVA_TOOL_OPTIONS: ' ' }, env).JAVA_TOOL_OPTIONS).toBe(own)
    expect(withSandboxEnv({}, env).JAVA_TOOL_OPTIONS).toBe(own)
    expect(withSandboxEnv({ JAVA_TOOL_OPTIONS: '-Xmx1g' }, {}).JAVA_TOOL_OPTIONS).toBe('-Xmx1g')
  })

  test('a socket name the Library doesn’t define is reported, and Electron is marked only with its group', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin' }),
      platform: 'linux',
      program: '/usr/bin/true',
      unixSockets: async () => '',
    })
    const wrapped = await sandbox.wrap(['/bin/sh', '-c'], {
      ...scope(),
      sockets: [{ name: 'db', path: '/var/run/db.sock' }],
      groups: ['socket:db', 'socket:docker', 'electron'],
    })
    expect(wrapped.missingSockets).toEqual(['docker'])
    expect(wrapped.env.TED_SANDBOX_ELECTRON).toBe('1')
    const plain = await sandbox.wrap(['/bin/sh', '-c'], scope())
    expect(plain.missingSockets).toEqual([])
    expect(plain.env.TED_SANDBOX_ELECTRON).toBeUndefined()
  })
})

describe('a missing sandbox', () => {
  test('is a problem, and wrapping refuses instead of running unsandboxed', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => process.env,
      program: path.join(outside, 'no-such-sandbox'),
    })
    expect(await sandbox.problem()).toMatch(/can’t sandbox checks and Apps/)
    await expect(sandbox.wrap(['/bin/sh', '-c'], scope())).rejects.toThrow(SandboxUnavailable)
  })

  test('bwrap missing from PATH on Linux names the package to install', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: outside }),
      platform: 'linux',
    })
    expect(await sandbox.problem()).toMatch(/bubblewrap/)
  })
})
