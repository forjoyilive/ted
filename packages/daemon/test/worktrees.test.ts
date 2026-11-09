import { execFile } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Factory, Run, RunSlots, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  hostRecords,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

const execFileAsync = promisify(execFile)

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let localFolder: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  origin = await makeOriginRepo(scratch)
  localFolder = path.join(scratch, 'local')
  await mkdir(localFolder, { recursive: true })
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  const runIds = await readdir(path.join(home, 'runs')).catch(() => [])
  for (const runId of runIds) {
    await waitUntil(
      async () => (await hostRecords(home, runId)).some((r) => r.t === 'start'),
      `Run ${runId}’s host to start`,
    ).catch(() => undefined)
  }
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startWithStub() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, await tokenFor(home))
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startWithStub>>

const addFactory = (client: Client, extra: Record<string, unknown> = { localFolder }) =>
  client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB', ...extra })

const createTask = (client: Client, title: string) =>
  client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const advanceEveryStage = [
  { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
  { run: ['ted', 'outcome', 'advance'] },
]

const workflow = (worktree: string) =>
  commitToOrigin(scratch, {
    '.ted/workflow.yaml': `version: 1\norder: [intake, work, merge]\nrepos:\n  - name: widgets\n    worktree:\n${worktree}`,
  })

const worktreeOf = (id = 'NB-1') => path.join(home, 'worktrees', id, 'widgets')

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )

const leadRun = (client: Client, task: Task): Promise<Run> =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return current?.leadRunId ? (await client.getRun(current.leadRunId)).run : undefined
  }, `${task.displayId}’s Task Lead Run`)

const firstMessage = async (client: Client, task: Task): Promise<string> => {
  const run = await leadRun(client, task)
  return waitUntil(async () => {
    const [first] = (await client.getRun(run.id)).conversation
    return first && (JSON.parse(first.line) as { message: { content: string } }).message.content
  }, 'the Task Lead’s first message')
}

const commandResults = async (client: Client, runId: string) =>
  assistantTexts((await client.getRun(runId)).conversation).map(
    (text) => JSON.parse(text) as { code: number; stdout: string },
  )

describe('worktree setup', () => {
  test('copy files and env are in place before setup, and setup runs before the Task Lead', async () => {
    await writeFile(path.join(localFolder, '.env'), 'SECRET=1\n')
    await mkdir(path.join(localFolder, 'config'))
    await writeFile(path.join(localFolder, 'config', 'master.key'), 'key\n')
    await workflow(
      [
        '      setup: "cat .env config/master.key > setup-saw.txt && printf %s \\"$GREETING\\" >> setup-saw.txt"',
        '      env:',
        '        GREETING: hello',
        '      copy: [".env", "config/*.key"]',
        '',
      ].join('\n'),
    )
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(
      client,
      steps(
        { run: ['cat', 'setup-saw.txt'] },
        { run: ['printenv', 'GREETING'] },
        { endTurn: true },
      ),
    )

    await client.ok('POST', `/tasks/${task.id}/start`)

    const run = await leadRun(client, task)
    expect(run.cwd).toBe(worktreeOf())
    const results = await waitUntil(async () => {
      const r = await commandResults(client, run.id)
      return r.length === 2 ? r : undefined
    }, 'the Task Lead’s commands')
    expect(results[0]?.stdout).toBe('SECRET=1\nkey\nhello')
    expect(results[1]?.stdout).toBe('hello\n')
  })
})

describe('worktree setup outcomes', () => {
  test('a failing setup still starts the Task Lead, with the output first', async () => {
    await workflow(
      `      setup: "echo installing; echo https://me:hun''ter2@example.com >&2; exit 3"\n`,
    )
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))

    await client.ok('POST', `/tasks/${task.id}/start`)

    const first = await firstMessage(client, task)
    expect(first.startsWith('# Setup failed')).toBe(true)
    expect(first).toContain('exit code 3')
    expect(first).toContain('installing\nhttps://[redacted]@example.com')
    expect(first).not.toContain('hunter2')
    expect(first.indexOf('installing')).toBeLessThan(first.indexOf('ted help'))
    const [repo] = (await getTask(client, task.id))?.repos ?? []
    expect(repo?.setup).toEqual({
      command: "echo installing; echo https://me:hun''ter2@example.com >&2; exit 3",
      state: 'failed',
      exitCode: 3,
    })
    const log = await client.ok<{ text: string }>(
      'GET',
      `/tasks/${task.id}/repos/widgets/setup-log`,
    )
    expect(log.text).toBe('installing\nhttps://[redacted]@example.com\n')
  })

  test('Stop during setup frees the slot, and Resume runs setup again before the Task Lead', async () => {
    const go = path.join(scratch, 'go')
    await workflow(`      setup: "while [ ! -e '${go}' ]; do sleep 0.05; done"\n`)
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))
    await client.ok<Task>('POST', `/tasks/${task.id}/start`)
    await waitUntil(
      async () => (await getTask(client, task.id))?.repos[0]?.setup?.state === 'running',
      'setup to start',
    )

    const stopped = await client.ok<Task>('POST', `/tasks/${task.id}/stop`)

    expect(stopped.status?.kind).toBe('stopped')
    await waitUntil(
      async () => (await client.ok<RunSlots>('GET', '/slots')).working === 0,
      'the slot to be free',
    )

    await client.ok('POST', `/tasks/${task.id}/resume`, {})
    await waitUntil(
      async () => (await getTask(client, task.id))?.status?.kind === 'working',
      'setup to run again',
    )
    expect((await getTask(client, task.id))?.leadRunId).toBeUndefined()
    await writeFile(go, '')
    await leadRun(client, task)
  })

  test('the Task shows Setting up while setup runs, and the Task Lead waits for it', async () => {
    const go = path.join(scratch, 'go')
    await workflow(`      setup: "while [ ! -e '${go}' ]; do sleep 0.05; done"\n`)
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))

    const started = await client.ok<Task>('POST', `/tasks/${task.id}/start`)

    expect(started.leadRunId).toBeUndefined()
    const running = await waitUntil(
      async () => (await getTask(client, task.id))?.repos[0]?.setup,
      'setup to start',
    )
    expect(running.state).toBe('running')
    expect(await getTask(client, task.id)).toMatchObject({
      status: { kind: 'working' },
      activity: 'Setting up the worktree',
    })
    expect(started.repos).toMatchObject([{ name: 'widgets', worktree: worktreeOf() }])
    await writeFile(go, '')
    await leadRun(client, task)
    expect((await getTask(client, task.id))?.repos[0]?.setup?.state).toBe('passed')
  })

  test('archiving during setup stops setup, starts no Task Lead and removes the worktree', async () => {
    await workflow(`      setup: "while true; do sleep 0.05; done"\n`)
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))
    await client.ok<Task>('POST', `/tasks/${task.id}/start`)
    await waitUntil(
      async () => (await getTask(client, task.id))?.repos[0]?.setup?.state === 'running',
      'setup to start',
    )

    await client.ok<Task>('POST', `/tasks/${task.id}/archive`)

    const archived = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current?.repos[0]?.removed ? current : undefined
    }, 'the worktree to be removed')
    expect(archived.leadRunId).toBeUndefined()
    expect(await exists(worktreeOf())).toBe(false)
    expect((await client.ok<{ working: number }>('GET', '/slots')).working).toBe(0)
  })

  test('a setup that runs past its timeout is stopped and the Task Lead starts', async () => {
    await workflow('      setup: { run: "echo slow; sleep 30", timeout: 1s }\n')
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))

    await client.ok('POST', `/tasks/${task.id}/start`)

    const first = await firstMessage(client, task)
    expect(first).toContain('it timed out')
    expect(first).toContain('slow')
    expect((await getTask(client, task.id))?.repos[0]?.setup?.state).toBe('timed-out')
  })

  test('setup interrupted by a daemon restart runs again, then the Task Lead starts', async () => {
    const go = path.join(scratch, 'go')
    const count = path.join(scratch, 'count')
    await workflow(
      `      setup: "echo run >> '${count}'; while [ ! -e '${go}' ]; do sleep 0.05; done"\n`,
    )
    let client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))
    await client.ok('POST', `/tasks/${task.id}/start`)
    await waitUntil(() => exists(count), 'setup to start')

    await daemon?.stop()
    client = await startWithStub()
    await waitUntil(
      async () => (await readFile(count, 'utf8')) === 'run\nrun\n',
      'setup to run again',
    )
    await writeFile(go, '')

    await leadRun(client, task)
  })
})

describe('worktree safety', () => {
  test('worktree.env can’t replace PATH, TED_ variables or loader and agent variables', async () => {
    await workflow(
      [
        '      setup: "printf \'%s|%s|%s|%s\' \\"$PATH\\" \\"$TED_TASK\\" \\"$NODE_OPTIONS\\" \\"$KEEP\\" > env-seen.txt"',
        '      env:',
        '        PATH: /nowhere',
        '        TED_TASK: XX-1',
        '        NODE_OPTIONS: --require=/tmp/evil.js',
        '        DYLD_INSERT_LIBRARIES: /tmp/evil.dylib',
        '        ANTHROPIC_API_KEY: stolen',
        '        KEEP: kept',
        '',
      ].join('\n'),
    )
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ run: ['printenv', 'KEEP'] }, { endTurn: true }))

    await client.ok('POST', `/tasks/${task.id}/start`)

    const run = await leadRun(client, task)
    const [seenPath, seenTask, seenNodeOptions, kept] = (
      await readFile(path.join(worktreeOf(), 'env-seen.txt'), 'utf8')
    ).split('|')
    expect(seenPath).toBe(process.env.PATH)
    expect(seenTask).toBe('NB-1')
    expect(seenNodeOptions).toBe(process.env.NODE_OPTIONS ?? '')
    expect(kept).toBe('kept')
    const record = await waitUntil(
      () =>
        readFile(path.join(worktreeOf(), 'stub-record.json'), 'utf8')
          .then((s) => JSON.parse(s) as { env: Record<string, string> })
          .catch(() => undefined),
      'the Task Lead to start',
    )
    expect(record.env.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(record.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(record.env.KEEP).toBe('kept')
    expect(run.cwd).toBe(worktreeOf())
  })

  test('a resumed setup runs the command recorded when it started, not a newer one', async () => {
    const go = path.join(scratch, 'go')
    const count = path.join(scratch, 'count')
    await workflow(
      `      setup: "echo first >> '${count}'; while [ ! -e '${go}' ]; do sleep 0.05; done"\n`,
    )
    let client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))
    await client.ok('POST', `/tasks/${task.id}/start`)
    await waitUntil(() => exists(count), 'setup to start')

    await daemon?.stop()
    await workflow(`      setup: "echo second >> '${count}'"\n`)
    await execFileAsync('git', ['fetch', 'origin'], {
      cwd: path.join(home, 'repos', 'acme', 'widgets'),
    })
    client = await startWithStub()
    await waitUntil(
      async () => (await readFile(count, 'utf8')) === 'first\nfirst\n',
      'the recorded setup to run again',
    )
    await writeFile(go, '')
    await leadRun(client, task)
  })

  test('a copy that fails removes the new worktree and branch, so start can be retried', async () => {
    await writeFile(path.join(localFolder, '.env'), 'A=1\n')
    await chmod(path.join(localFolder, '.env'), 0o000)
    await workflow('      copy: [".env"]\n')
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, 'Fix login')

    const failed = await client.call('POST', `/tasks/${task.id}/start`)
    await chmod(path.join(localFolder, '.env'), 0o600)
    const started = await client.ok<Task>('POST', `/tasks/${task.id}/start`)

    expect(failed.status).toBe(409)
    expect(started.branch).toBe('ted/nb-1-fix-login')
    expect(await readFile(path.join(worktreeOf(), '.env'), 'utf8')).toBe('A=1\n')
  })
})

describe('worktree removal', () => {
  test('at Done, teardown runs in the worktree before TED removes it', async () => {
    const marker = path.join(scratch, 'torn-down')
    await workflow(
      `      teardown: "pwd -P > '${marker}'; printf %s \\"$GREETING\\" >> '${marker}'"\n      env: { GREETING: bye }\n`,
    )
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps(...advanceEveryStage))

    await client.ok('POST', `/tasks/${task.id}/start`)

    const removed = await waitUntil(
      async () => (await getTask(client, task.id))?.repos[0]?.removed,
      'the worktree to be removed',
    )
    expect(removed.teardown).toEqual({ command: expect.any(String), outcome: 'passed' })
    const [where, greeting] = (await readFile(marker, 'utf8')).split('\n')
    expect(where).toBe(path.join(await realpath(home), 'worktrees', 'NB-1', 'widgets'))
    expect(greeting).toBe('bye')
    expect(await exists(path.join(home, 'worktrees', 'NB-1'))).toBe(false)
  })

  test('a failing teardown is recorded and the worktree is still removed', async () => {
    await workflow('      teardown: "exit 1"\n')
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps(...advanceEveryStage))

    await client.ok('POST', `/tasks/${task.id}/start`)

    const removed = await waitUntil(
      async () => (await getTask(client, task.id))?.repos[0]?.removed,
      'the worktree to be removed',
    )
    expect(removed.teardown?.outcome).toBe('failed')
    expect(await exists(path.join(home, 'worktrees', 'NB-1'))).toBe(false)
  })
})

describe('branch names', () => {
  test('a long title is cut to 40 characters at a word boundary', async () => {
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(
      client,
      'Fix the login redirect when the session cookie has expired overnight',
    )

    const started = await client.ok<Task>('POST', `/tasks/${task.id}/start`)

    expect(started.branch).toBe('ted/nb-1-fix-the-login-redirect-when-the-session')
  })

  test('a name already taken on origin gets -2, then -3', async () => {
    const seed = path.join(scratch, 'seed')
    for (const branch of ['ted/nb-1-fix-login', 'ted/nb-1-fix-login-2']) {
      await execFileAsync('git', ['push', origin, `HEAD:refs/heads/${branch}`], { cwd: seed })
    }
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, 'Fix login')

    const started = await client.ok<Task>('POST', `/tasks/${task.id}/start`)

    expect(started.branch).toBe('ted/nb-1-fix-login-3')
    expect(started.repos[0]?.branch).toBe('ted/nb-1-fix-login-3')
  })

  test('branches start from base_branch when the repo sets one', async () => {
    const seed = path.join(scratch, 'seed')
    await execFileAsync('git', ['push', origin, 'main:develop'], { cwd: seed })
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nrepos:\n  - name: widgets\n    base_branch: develop\n',
    })
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, 'From develop')

    await client.ok('POST', `/tasks/${task.id}/start`)

    expect(await exists(path.join(worktreeOf(), '.ted'))).toBe(false)
    expect(await readFile(path.join(worktreeOf(), 'README.md'), 'utf8')).toBe('# widgets\n')
  })
})

describe('local folders and copy files', () => {
  test('a missing local folder skips copy files and the Factory says so', async () => {
    await workflow('      copy: [".env"]\n')
    const client = await startWithStub()
    await addFactory(client)
    await rm(localFolder, { recursive: true })
    const task = await createTask(client, steps({ endTurn: true }))

    const started = await client.ok<Task>('POST', `/tasks/${task.id}/start`)

    expect(started.repos[0]?.skipped).toEqual([{ path: '.env', reason: 'local-folder-missing' }])
    expect(await exists(path.join(worktreeOf(), '.env'))).toBe(false)
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    expect(factory?.localFolder).toEqual({ path: localFolder, found: false })
    await leadRun(client, task)
  })

  test('Locate sets a new local folder, which later worktrees copy from', async () => {
    await workflow('      copy: [".env", "absent.txt"]\n')
    const client = await startWithStub()
    await addFactory(client, {})
    const elsewhere = path.join(scratch, 'elsewhere')
    await mkdir(elsewhere)
    await writeFile(path.join(elsewhere, '.env'), 'A=1\n')

    const factory = await client.ok<Factory>('PUT', '/factories/NB/local-folder', {
      path: elsewhere,
    })
    const task = await createTask(client, steps({ endTurn: true }))
    const started = await client.ok<Task>('POST', `/tasks/${task.id}/start`)

    expect(factory.localFolder).toEqual({ path: elsewhere, found: true })
    expect(await readFile(path.join(worktreeOf(), '.env'), 'utf8')).toBe('A=1\n')
    expect(started.repos[0]).toMatchObject({
      copied: ['.env'],
      skipped: [{ path: 'absent.txt', reason: 'missing' }],
    })
  })

  test('a local folder must be an existing absolute folder', async () => {
    const client = await startWithStub()
    await addFactory(client, {})

    for (const folder of ['relative/path', path.join(scratch, 'nope')]) {
      const res = await client.call('PUT', '/factories/NB/local-folder', { path: folder })
      expect(res.status, folder).toBe(400)
    }
  })

  test('copy never reads outside the local folder or writes outside the worktree', async () => {
    const secret = path.join(scratch, 'secret.txt')
    await writeFile(secret, 'secret\n')
    await symlink(secret, path.join(localFolder, 'linked.txt'))
    await writeFile(path.join(localFolder, 'inside.txt'), 'ok\n')
    await mkdir(path.join(localFolder, 'out'))
    await writeFile(path.join(localFolder, 'out', 'inside.txt'), 'escaped\n')
    await symlink(scratch, path.join(scratch, 'seed', 'out'))
    await workflow(
      '      copy: ["../secret.txt", "/etc/hosts", "linked.txt", "out/inside.txt", "inside.txt"]\n',
    )
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))

    const started = await client.ok<Task>('POST', `/tasks/${task.id}/start`)

    expect(started.repos[0]?.copied).toEqual(['inside.txt'])
    expect(started.repos[0]?.skipped.map((s) => [s.path, s.reason])).toEqual([
      ['../secret.txt', 'outside'],
      ['/etc/hosts', 'outside'],
      ['linked.txt', 'outside'],
      ['out/inside.txt', 'outside'],
    ])
    expect(await exists(path.join(scratch, 'inside.txt'))).toBe(false)
  })
})
