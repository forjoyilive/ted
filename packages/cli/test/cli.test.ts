import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const cliPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))

import { killRunHosts, makeOriginRepo, stubCodexPath } from '../../daemon/test/helpers.ts'

const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const run = promisify(execFile)

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-cli-'))
})

afterEach(async () => {
  const info = await readDaemonInfo(home)
  if (info) {
    process.kill(info.pid, 'SIGTERM')
    await waitForExit(info.pid)
  }
  await killRunHosts(home)
  await rm(home, { recursive: true, force: true })
})

function ted(args: string[], idleExitMs = 30_000) {
  return run(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      TED_HOME: home,
      TED_IDLE_EXIT_MS: String(idleExitMs),
      TED_CLAUDE_BIN: stubClaudePath,
      TED_CODEX_BIN: stubCodexPath,
    },
    cwd: home,
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still running`)
    await sleep(50)
  }
}

async function daemonPid(): Promise<number> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return info.pid
}

describe('ted task', () => {
  test('create starts the daemon when it is not running, and list shows the Task', async () => {
    expect(await readDaemonInfo(home)).toBeUndefined()

    const created = await ted(['task', 'create', 'Fix login'])
    expect(created.stdout.trim()).toBe('Created DEV-1  Fix login')
    expect(isAlive(await daemonPid())).toBe(true)

    const listed = await ted(['task', 'list'])
    expect(listed.stdout.trim()).toBe('DEV-1  Backlog  Fix login')
  })

  test('Tasks are still there after the daemon restarts', async () => {
    await ted(['task', 'create', 'Fix login'])
    await ted(['task', 'create', 'Add dark mode'])
    const firstPid = await daemonPid()
    process.kill(firstPid, 'SIGTERM')
    await waitForExit(firstPid)

    const listed = await ted(['task', 'list'])

    expect(await daemonPid()).not.toBe(firstPid)
    expect(listed.stdout.trim().split('\n')).toEqual([
      'DEV-1  Backlog  Fix login',
      'DEV-2  Backlog  Add dark mode',
    ])
  })

  test('ted recovers when the daemon was killed and left daemon.json behind', async () => {
    await ted(['task', 'create', 'Fix login'])
    const firstPid = await daemonPid()
    process.kill(firstPid, 'SIGKILL')
    await waitForExit(firstPid)

    const listed = await ted(['task', 'list'])

    expect(listed.stdout.trim()).toBe('DEV-1  Backlog  Fix login')
  })

  test('a daemon that ted started exits once idle', async () => {
    await ted(['task', 'list'], 1_000)
    const pid = await daemonPid()

    await waitForExit(pid, 5_000)

    expect(await readDaemonInfo(home)).toBeUndefined()
  })

  test('list says so when there are no Tasks', async () => {
    const listed = await ted(['task', 'list'])
    expect(listed.stdout.trim()).toBe('No Tasks yet.')
  })

  test('an unknown command prints usage and fails', async () => {
    await expect(ted(['nonsense'])).rejects.toMatchObject({ code: 2 })
  })
})

describe('ted dev run', () => {
  test('start runs the agent in a Run, and show prints its state and Conversation', async () => {
    const prompt = JSON.stringify({
      steps: [{ say: 'hi from the stub' }, { endTurn: true }, { exit: 0 }],
    })

    const started = await ted(['dev', 'run', 'start', prompt])
    const id = started.stdout.trim().replace(/^Started Run /, '')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    let shown = ''
    for (let i = 0; i < 100 && !shown.includes('finished'); i++) {
      shown = (await ted(['dev', 'run', 'show', id])).stdout
      await sleep(100)
    }
    const lines = shown.trim().split('\n')
    expect(lines[0]).toBe(`Run ${id}  claude  finished`)
    expect(lines[1]).toMatch(/^Session [0-9a-f-]{36}$/)
    expect(lines).toContain('assistant: hi from the stub')
    expect(lines).toContain('system hook_started Stop')
  })

  test('start --agent codex runs Codex, and show prints its thread and messages', async () => {
    const prompt = JSON.stringify({
      steps: [{ say: 'hi from Codex' }, { endTurn: true }, { exit: 0 }],
    })

    const started = await ted(['dev', 'run', 'start', '--agent', 'codex', prompt])
    const id = started.stdout.trim().replace(/^Started Run /, '')

    let shown = ''
    for (let i = 0; i < 100 && !shown.includes('finished'); i++) {
      shown = (await ted(['dev', 'run', 'show', id])).stdout
      await sleep(100)
    }
    const lines = shown.trim().split('\n')
    expect(lines[0]).toBe(`Run ${id}  codex  finished`)
    expect(lines[1]).toMatch(/^Session 0199a000-/)
    expect(lines).toContain('item/completed: hi from Codex')
    expect(lines).toContain('turn/completed')
  })

  test('start refuses an unknown agent kind', async () => {
    await expect(ted(['dev', 'run', 'start', '--agent', 'gemini', 'x'])).rejects.toMatchObject({
      code: 2,
      stderr: 'ted: --agent must be claude or codex\n',
    })
  })

  test('show strips terminal control characters from agent output', async () => {
    const hostile = 'a\u001b]0;pwned\u0007b\u001b[31mc\u009bd'
    const prompt = JSON.stringify({ steps: [{ say: hostile }, { endTurn: true }, { exit: 0 }] })
    const id = (await ted(['dev', 'run', 'start', prompt])).stdout
      .trim()
      .replace(/^Started Run /, '')

    let shown = ''
    for (let i = 0; i < 100 && !shown.includes('finished'); i++) {
      shown = (await ted(['dev', 'run', 'show', id])).stdout
      await sleep(100)
    }
    expect(shown).toContain('assistant: abcd')
    const controls = [...shown].filter((c) => {
      const code = c.codePointAt(0) ?? 0
      return (code < 0x20 && c !== '\n') || (code >= 0x7f && code <= 0x9f)
    })
    expect(controls).toEqual([])
  })

  test('show refuses an unknown Run', async () => {
    await expect(ted(['dev', 'run', 'show', 'nope'])).rejects.toMatchObject({
      code: 1,
      stderr: 'ted: no such Run\n',
    })
  })
})

describe('ted help', () => {
  test('lists the commands a Task Lead uses', async () => {
    const { stdout } = await ted(['help'])
    expect(stdout).toContain('ted comment')
    expect(stdout).toContain('ted outcome advance')
    expect(stdout).toContain('ted help')
  })
})

describe('ted dev factory and ted task start', () => {
  test('adds a Factory, creates a Task in it, starts it, and the Task Lead takes it to Done', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'On it'] },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })

    const added = await ted(['dev', 'factory', 'add', origin, '--key', 'NB'])
    expect(added.stdout.trim()).toBe('Added Factory NB  acme/widgets')
    const created = await ted(['task', 'create', '--factory', 'NB', steps])
    expect(created.stdout.trim()).toMatch(/^Created NB-1 /)
    const started = await ted(['task', 'start', 'NB-1'])
    expect(started.stdout.trim()).toMatch(/^Started NB-1 on branch ted\/nb-1-/)

    let listed = ''
    for (let i = 0; i < 100 && !listed.includes('Done'); i++) {
      listed = (await ted(['task', 'list'])).stdout
      await sleep(100)
    }
    expect(listed).toMatch(/^NB-1 {2}Done {2}/)
  })

  test('comment and outcome outside a Run need --task', async () => {
    await expect(ted(['comment', 'hello'])).rejects.toMatchObject({ code: 2 })
  })
})

describe('ted workflow check', () => {
  async function writeLayer(files: Record<string, string>) {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, '.ted', file)), { recursive: true })
      await writeFile(path.join(home, '.ted', file), content)
    }
  }

  test('says so when .ted/ has no problems', async () => {
    await writeLayer({
      'workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
      'stages/work.md': '# Work\n\nBuild it.\n',
    })

    const { stdout } = await ted(['workflow', 'check'])

    expect(stdout.trim()).toBe('No problems in .ted')
  })

  test('reports file, line, column and message for each kind of error', async () => {
    await writeLayer({
      'workflow.yaml': [
        'version: 1',
        'order: [clarify, intake, work]',
        'stages:',
        '  deploy: {}',
        '  work: { gate: maybe }',
        'repos:',
        '  - name: app',
        '  - name: app',
        '    remote: https://gitlab.com/kriya/lab.git',
        '',
      ].join('\n'),
      'stages/review.md': '\n',
    })

    const failure = await ted(['workflow', 'check']).then(
      () => undefined,
      (error: { code: number; stdout: string }) => error,
    )

    expect(failure?.code).toBe(1)
    expect(failure?.stdout.split('\n')).toEqual([
      '.ted/workflow.yaml:2:8: error: `order` must start with `intake`',
      '.ted/workflow.yaml:4:3: error: unknown Stage `deploy`',
      '.ted/workflow.yaml:5:17: error: `stages.work.gate` must be true or false',
      '.ted/workflow.yaml:8:11: error: two repos are named `app`',
      '.ted/workflow.yaml:9:13: error: `remote` must be a GitHub repo',
      '.ted/stages/review.md:1:1: error: the Stage file is empty',
      '6 errors',
      '',
    ])
  })

  test('reports YAML that doesn’t parse, for a file named on the command line', async () => {
    await writeLayer({ 'workflow.yaml': 'order: [intake, work\n' })

    const failure = await ted(['workflow', 'check', '.ted/workflow.yaml']).then(
      () => undefined,
      (error: { code: number; stdout: string }) => error,
    )

    expect(failure?.code).toBe(1)
    expect(failure?.stdout).toMatch(/^\.ted\/workflow\.yaml:2:1: error: /)
  })

  test('warns about unknown keys without failing', async () => {
    await writeLayer({ 'workflow.yaml': 'version: 1\nshiny: true\n' })

    const { stdout } = await ted(['workflow', 'check', '.ted'])

    expect(stdout.split('\n')).toEqual([
      '.ted/workflow.yaml:2:1: warning: unknown key `shiny`',
      '1 warning',
      '',
    ])
  })
})
