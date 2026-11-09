import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSandbox, SandboxUnavailable } from '../src/sandbox.ts'

const execFileAsync = promisify(execFile)

let tedHome: string
let worktree: string
let tmp: string
let outside: string

beforeEach(async () => {
  tedHome = await mkdtemp(path.join(tmpdir(), 'ted-sandbox-home-'))
  worktree = path.join(tedHome, 'worktrees', 'NB-1')
  await mkdir(worktree, { recursive: true })
  tmp = await mkdtemp(path.join(tmpdir(), 'ted-sandbox-tmp-'))
  outside = await mkdtemp(path.join(tmpdir(), 'ted-sandbox-outside-'))
})

afterEach(async () => {
  for (const dir of [tedHome, tmp, outside]) await rm(dir, { recursive: true, force: true })
})

async function inSandbox(script: string) {
  const sandbox = createSandbox({ tedHome, env: () => process.env })
  const { argv, env } = await sandbox.wrap(['/bin/sh', '-c'], { writable: [worktree], tmp })
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

describe.runIf(process.platform === 'darwin')('the sandbox on macOS', () => {
  test('a sandboxed command writes in its worktree and its own temp folder', async () => {
    const result = await inSandbox(
      `${tryWrite(path.join(worktree, 'a.txt'))}; echo x > "$TMPDIR/b.txt" && echo wrote; echo "$TMPDIR"`,
    )
    expect(result.stdout.split('\n').slice(0, 2)).toEqual(['wrote', 'wrote'])
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf8')).toBe('x\n')
    expect(result.stdout).toContain(path.basename(tmp))
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
          `ln -s /etc '${path.join(worktree, 'link')}' && ${tryWrite(path.join(worktree, 'link', 'x'))}`,
        ].join('; '),
      )
      expect(result.stdout.trim().split('\n')).toEqual([
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
        ].join('; '),
      )
      expect(result.stdout.trim().split('\n')).toEqual(['refused', 'refused'])
    } finally {
      await execFileAsync('launchctl', ['remove', label]).catch(() => undefined)
      await execFileAsync('defaults', ['delete', label]).catch(() => undefined)
    }
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
    await expect(sandbox.wrap(['/bin/sh', '-c'], { writable: [worktree], tmp })).rejects.toThrow(
      SandboxUnavailable,
    )
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
