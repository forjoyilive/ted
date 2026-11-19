import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSandbox, SandboxUnavailable, unixSocketPaths } from '../src/sandbox.ts'
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

beforeEach(async () => {
  tedHome = await mkdtemp(path.join(tmpdir(), 'ted-sandbox-home-'))
  worktree = path.join(tedHome, 'worktrees', 'NB-1', 'widgets')
  clone = path.join(tedHome, 'repos', 'k', 'widgets')
  await mkdir(worktree, { recursive: true })
  await mkdir(clone, { recursive: true })
  tmp = path.join(tedHome, 'sandbox', 'NB-1', 'tmp-1')
  await mkdir(tmp, { recursive: true })
  outside = await mkdtemp(path.join(tmpdir(), 'ted-sandbox-outside-'))
})

afterEach(async () => {
  for (const dir of [tedHome, outside]) await rm(dir, { recursive: true, force: true })
})

async function inSandbox(script: string, sockets: string[] = [], home?: string) {
  const sandbox = createSandbox({
    tedHome,
    env: () => (home === undefined ? process.env : { ...process.env, HOME: home }),
  })
  const { argv, env } = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), sockets })
  const [command, ...args] = argv
  return execFileAsync(command, [...args, script], {
    cwd: worktree,
    env: { ...process.env, ...env },
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
  })

  test('a sandboxed command writes its worktree, its own temp folder and the Task’s caches', async () => {
    await writeFile(path.join(clone, 'HEAD'), 'ref')
    const id = randomUUID()
    const xcodeSave = path.join(saves, `NSIRD_SWBBuildService_${id}`)
    const otherSave = path.join(saves, `NSIRD_TextEdit_${id}`)
    const looseSave = path.join(saves, `ted-${id}`)
    await mkdir(otherSave, { recursive: true })
    const result = await inSandbox(
      [
        tryWrite(path.join(worktree, 'a.txt')),
        'echo x > "$TMPDIR/b.txt" && echo wrote',
        'mkdir -p "$npm_config_cache" && echo x > "$npm_config_cache/c" && echo wrote',
        'echo x > "$TED_DERIVED_DATA/d" && test -d "$TED_SWIFTPM_CACHE" && test -d "$CLANG_MODULE_CACHE_PATH" && test "$TED_SANDBOX" = 1 && test "$MAC_CHROMIUM_TMPDIR" = "$TMPDIR" && echo wrote',
        `mkdir '${xcodeSave}' && ${tryWrite(path.join(xcodeSave, 'x'))}`,
        tryWrite(path.join(otherSave, 'x')),
        tryWrite(looseSave),
        tryRead(path.join(clone, 'HEAD')),
        'echo "$TMPDIR"',
      ].join('; '),
    )
    expect(result.stdout.split('\n').slice(0, 8)).toEqual([
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'wrote',
      'refused',
      'refused',
      'read',
    ])
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf8')).toBe('x\n')
    const cache = await realpath(scope().cache)
    expect(await readFile(path.join(cache, 'xcode', 'DerivedData', 'd'), 'utf8')).toBe('x\n')
    expect(result.stdout).toContain(path.basename(tmp))
    for (const dir of [xcodeSave, otherSave, looseSave])
      await rm(dir, { recursive: true, force: true })
  })

  test('a sandboxed command makes and removes SwiftPM’s TemporaryDirectory folders in the per-user temp folder, and nothing else there', async () => {
    const id = randomUUID()
    const longer = path.join(userTemp, `TemporaryDirectory.${id.slice(0, 6)}x`)
    const shorter = path.join(userTemp, `TemporaryDirectory.${id.slice(0, 5)}`)
    const loose = path.join(userTemp, `ted-${id}`)
    const result = await inSandbox(
      [
        `d=$(mktemp -d '${userTemp}/TemporaryDirectory.XXXXXX') && echo x > "$d/Package.swift" && rm -r "$d" && test ! -e "$d" && echo wrote || echo refused`,
        `mkdir '${longer}' 2>/dev/null && echo wrote || echo refused`,
        `mkdir '${shorter}' 2>/dev/null && echo wrote || echo refused`,
        tryWrite(loose),
      ].join('; '),
    )
    expect(result.stdout.split('\n').slice(0, 4)).toEqual([
      'wrote',
      'refused',
      'refused',
      'refused',
    ])
    for (const dir of [longer, shorter, loose]) await rm(dir, { recursive: true, force: true })
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
      [],
      home,
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
  test('only an Electron App’s sandbox reaches launchservicesd, and it says so in its environment', async () => {
    const sandbox = createSandbox({ tedHome, env: () => process.env })
    const plain = await sandbox.wrap(['/bin/sh', '-c'], scope())
    const electron = await sandbox.wrap(['/bin/sh', '-c'], { ...scope(), electron: true })
    const service = 'com.apple.coreservices.launchservicesd'
    expect(plain.argv.join('\n')).not.toContain(service)
    expect(plain.env.TED_SANDBOX_ELECTRON).toBeUndefined()
    expect(electron.argv.join('\n')).toContain(`(allow mach-lookup (global-name "${service}"))`)
    expect(electron.env.TED_SANDBOX_ELECTRON).toBe('1')
  })

  test('it reaches Unix sockets only in its own folders and the ones the Factory lists', async () => {
    const own = path.join(tmp, 'o.s')
    const listed = path.join(outside, 'listed.sock')
    const other = path.join(outside, 'other.sock')
    const servers = await Promise.all([own, listed, other].map(listen))
    try {
      const result = await inSandbox(
        [tryConnect(own), tryConnect(listed), tryConnect(other), 'echo resolved'].join('; '),
        [listed],
      )
      expect(result.stdout.trim().split('\n')).toEqual([
        'connected',
        'connected',
        'refused',
        'resolved',
      ])
    } finally {
      for (const server of servers) server.close()
    }
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
          sockets: ['~/listed.sock', '~/run/agent.sock'],
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
