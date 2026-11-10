import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { getPriority, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CheckRun, Factory, Task, TaskApp } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { lowPriorityNiceness, workCommand } from '../src/priority.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killAppHosts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const stubApp = fileURLToPath(new URL('./fixtures/stub-app.ts', import.meta.url))
const own = getPriority()
const low = Math.min(own + lowPriorityNiceness, process.platform === 'darwin' ? 20 : 19)
const advance = { run: ['ted', 'outcome', 'advance'] }
const niceness = { run: ['sh', '-c', 'ps -o nice= -p $PPID; ps -o nice= -p $$'] }

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-priority-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killAppHosts(home)
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: { pollMs: 50, readyTimeoutMs: 20_000, stopGraceMs: 3_000 },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof start>>

async function agentAndCommand(client: Client): Promise<number[]> {
  const run = await client.startRun([niceness, { endTurn: true }], scratch)
  const [said] = await waitUntil(async () => {
    const texts = assistantTexts((await client.getRun(run.id)).conversation)
    return texts.length > 0 ? texts : undefined
  }, 'the stub agent to report its niceness')
  const { stdout } = JSON.parse(said ?? '{}') as { stdout: string }
  return stdout.trim().split(/\s+/).map(Number)
}

async function startTask(client: Client, title: string): Promise<Task> {
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

function fetchJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve(JSON.parse(body) as Record<string, unknown>))
      })
      .once('error', reject)
  })
}

async function appNiceness(
  client: Client,
  task: Task,
  by: 'human' | 'task-lead',
): Promise<unknown> {
  const app = await waitUntil(async () => {
    const found = (await client.ok<TaskApp[]>('GET', `/tasks/${task.id}/apps`)).find(
      (a) => a.name === 'Web',
    )
    return found?.state === 'running' && found.startedBy === by ? found : undefined
  }, `Web to be running, started by ${by}`)
  return (await fetchJson(`http://127.0.0.1:${app.port}/`)).nice
}

describe('Low priority for the work TED starts', () => {
  test('a Run’s agent and the commands it runs are niced, and the daemon is not', async () => {
    const client = await start()
    expect(
      (await client.ok<{ lowPriorityWork: boolean }>('GET', '/settings')).lowPriorityWork,
    ).toBe(true)
    expect(await agentAndCommand(client)).toEqual([low, low])
    expect(getPriority()).toBe(own)
  })

  test('with the setting off, a Run starts at the daemon’s own priority', async () => {
    const client = await start()
    await client.ok('PATCH', '/settings', { lowPriorityWork: false })
    expect(await agentAndCommand(client)).toEqual([own, own])
  })

  test('a worktree’s setup command and a Check run niced', async () => {
    const report = `'${process.execPath}' report-nice.mjs`
    await commitToOrigin(scratch, {
      '.gitignore': 'stub-*\n',
      'report-nice.mjs': [
        "import { writeFileSync } from 'node:fs'",
        "import { getPriority } from 'node:os'",
        'writeFileSync(process.argv[2], String(getPriority()))',
        '',
      ].join('\n'),
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate]',
        'repos:',
        '  - name: widgets',
        '    worktree:',
        `      setup: "${report} stub-setup-nice"`,
        'stages:',
        '  validate:',
        '    checks:',
        `      - { name: Nice, run: "${report} stub-check-nice" }`,
        '',
      ].join('\n'),
    })
    const client = await start()
    const task = await startTask(
      client,
      JSON.stringify({
        steps: [{ everyMessage: [{ run: ['sh', '-c', 'echo x > work.txt'] }, advance] }, advance],
      }),
    )
    const checkRun = await waitUntil(
      async () =>
        (await client.ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)).find(
          (r) => r.finishedAt !== undefined,
        ),
      'a finished Check run',
      40_000,
    )
    expect(checkRun.outcome).toBe('passed')
    const worktree = (await getTask(client, task.id))?.repos[0]?.worktree ?? ''
    const read = async (name: string) =>
      Number((await readFile(path.join(worktree, name), 'utf8')).trim())
    expect(await read('stub-setup-nice')).toBe(low)
    expect(await read('stub-check-nice')).toBe(low)
  })

  test('an App a Run starts is niced, and the same App started by the human is not', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, merge]',
        'repos:',
        '  - name: widgets',
        '    apps:',
        '      - name: Web',
        `        run: "'${process.execPath}' '${stubApp}'"`,
        `        url: "http://localhost:\${PORT}"`,
        '        ready: url',
        '',
      ].join('\n'),
    })
    const client = await start()
    const task = await startTask(
      client,
      JSON.stringify({ steps: [{ run: ['ted', 'run-app', 'Web'] }, { endTurn: true }] }),
    )
    expect(await appNiceness(client, task, 'task-lead')).toBe(low)
    await client.ok('POST', `/tasks/${task.id}/apps/start`, { name: 'Web' })
    expect(await appNiceness(client, task, 'human')).toBe(own)
  })
})

describe('workCommand', () => {
  test('puts nice in front of a command, and leaves it alone at normal priority or without nice', () => {
    expect(workCommand('/bin/sh', ['-c', 'true'], true, ['/nowhere/nice', '/bin/sh'])).toEqual({
      command: '/bin/sh',
      args: ['-n', '10', '/bin/sh', '-c', 'true'],
    })
    expect(workCommand('/bin/sh', ['-c', 'true'], false)).toEqual({
      command: '/bin/sh',
      args: ['-c', 'true'],
    })
    expect(workCommand('/bin/sh', ['-c', 'true'], true, ['/nowhere/nice'])).toEqual({
      command: '/bin/sh',
      args: ['-c', 'true'],
    })
  })
})
