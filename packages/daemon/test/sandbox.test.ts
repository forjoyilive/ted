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
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSandbox, SandboxUnavailable } from '../src/sandbox.ts'

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

async function inSandbox(script: string) {
  const sandbox = createSandbox({ tedHome, env: () => process.env })
  const { argv, env } = await sandbox.wrap(['/bin/sh', '-c'], scope())
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

const tryWrite = (file: string) => `echo x > '${file}' 2>/dev/null && echo wrote || echo refused`
const tryRead = (file: string) => `cat '${file}' >/dev/null 2>&1 && echo read || echo refused`

describe.runIf(process.platform === 'darwin')('the sandbox on macOS', () => {
  let saves: string
  beforeEach(async () => {
    const { stdout } = await execFileAsync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'])
    saves = path.join(await realpath(stdout.trim()), 'TemporaryItems')
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
        'echo x > "$TED_DERIVED_DATA/d" && test -d "$TED_SWIFTPM_CACHE" && test -d "$CLANG_MODULE_CACHE_PATH" && echo wrote',
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
})

describe('the folders a sandbox opens', () => {
  test('a worktree swapped for a link to somewhere else is refused', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => process.env,
      platform: 'linux',
      program: '/usr/bin/true',
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
    })
    await expect(
      sandbox.wrap(['/bin/sh', '-c'], { ...scope(), writable: [outside] }),
    ).rejects.toThrow(/isn’t inside TED’s folder/)
  })

  test('on Linux, TED_HOME is hidden and only the Task’s folders come back', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => ({ PATH: '/usr/bin:/bin' }),
      platform: 'linux',
      program: '/usr/bin/true',
    })
    const { argv } = await sandbox.wrap(['/bin/sh', '-c'], scope())
    const home = await realpath(tedHome)
    const real = await realpath(worktree)
    expect(argv.join(' ')).toContain(`--tmpfs ${home}`)
    expect(argv.join(' ')).toContain(`--ro-bind ${await realpath(clone)}`)
    expect(argv.join(' ')).toContain(`--bind ${real} ${real}`)
    expect(argv.indexOf(home)).toBeLessThan(argv.indexOf(real))
  })
})

describe('a missing sandbox', () => {
  test('is a problem, and wrapping refuses instead of running unsandboxed', async () => {
    const sandbox = createSandbox({
      tedHome,
      env: () => process.env,
      program: path.join(outside, 'no-such-sandbox'),
    })
    expect(await sandbox.problem()).toMatch(/can’t sandbox Checks and Apps/)
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
