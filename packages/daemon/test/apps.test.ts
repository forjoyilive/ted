import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AppLog,
  type Factory,
  type Task,
  type TaskApp,
  type ThreadEvent,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
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
const runStub = `"'${process.execPath}' '${stubApp}'"`

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
let blocker: net.Server | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-apps-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()))
  blocker = undefined
  await killAppHosts(home)
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start(logBytes?: number) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: {
      pollMs: 50,
      readyTimeoutMs: 20_000,
      stopGraceMs: 3_000,
      ...(logBytes !== undefined && { logBytes }),
    },
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

const appsYaml = (extra = '') =>
  [
    'version: 1',
    'order: [intake, work, merge]',
    'repos:',
    '  - name: widgets',
    '    worktree:',
    '      env:',
    '        GREETING: hello',
    '    apps:',
    '      - name: Web',
    `        run: ${runStub}`,
    `        url: "http://localhost:\${PORT}"`,
    '        ready: url',
    '        env:',
    `          API_URL: "\${TED_APP_API_URL}/v1"`,
    '      - name: API',
    '        kind: command',
    `        run: ${runStub}`,
    '      - name: Crashy',
    `        run: ${runStub}`,
    '        env:',
    '          STUB_APP_CRASH_AFTER_MS: "400"',
    extra,
  ].join('\n')

async function taskWithWorktree(client: Client, title = '{"steps": [{"endTurn": true}]}') {
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  await waitUntil(async () => {
    const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return current?.leadRunId
  }, 'the Task Lead Run')
  return task
}

const apps = (client: Client, task: Task) => client.ok<TaskApp[]>('GET', `/tasks/${task.id}/apps`)

const appNamed = async (client: Client, task: Task, name: string) =>
  (await apps(client, task)).find((a) => a.name === name)

const waitForState = (client: Client, task: Task, name: string, state: TaskApp['state']) =>
  waitUntil(async () => {
    const app = await appNamed(client, task, name)
    return app?.state === state ? app : undefined
  }, `${name} to be ${state}`)

const events = (client: Client, task: Task) =>
  client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)

const eventText = async (client: Client, task: Task, text: string) =>
  waitUntil(
    async () => (await events(client, task)).find((e) => e.text === text),
    `the thread event “${text}”`,
  )

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

const answers = (url: string) =>
  fetchJson(url).then(
    () => true,
    () => false,
  )

describe('Apps', () => {
  test('▶ starts a Web App on a free loopback port with the Task’s App variables, and ted run-app reuses it', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': appsYaml() })
    const marker = path.join(scratch, 'go')
    const client = await start()
    const task = await taskWithWorktree(
      client,
      JSON.stringify({
        steps: [
          { waitFor: marker },
          { run: ['ted', 'run-app', 'Web'] },
          { run: ['printenv', 'TED_APP_WEB_PORT'] },
          { endTurn: true },
        ],
      }),
    )

    const listed = await apps(client, task)
    expect(listed.map((a) => [a.repo, a.name, a.kind, a.state])).toEqual([
      ['widgets', 'Web', 'web', 'stopped'],
      ['widgets', 'API', 'command', 'stopped'],
      ['widgets', 'Crashy', 'web', 'stopped'],
    ])

    const started = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/start`, {
      name: 'Web',
    })
    expect(started.state).toBe('starting')
    const port = started.port as number
    expect(started.url).toBe(`http://localhost:${port}`)
    const running = await waitForState(client, task, 'Web', 'running')
    expect(running.startedBy).toBe('human')
    const api = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/start`, {
      repo: 'widgets',
      name: 'API',
    })
    expect(api.state).toBe('running')
    expect(api.url).toBeUndefined()

    const seen = await fetchJson(`http://127.0.0.1:${port}/`)
    expect(seen).toMatchObject({
      port: String(port),
      greeting: 'hello',
      apiUrl: `http://localhost:${api.port}/v1`,
      webPort: String(port),
      task: 'NB-1',
      run: null,
      home: null,
    })
    await eventText(client, task, `You started Web · localhost:${port}`)

    await writeFile(marker, '')
    const lead = await waitUntil(async () => {
      const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      return current?.leadRunId
    }, 'the lead')
    const results = await waitUntil(async () => {
      const texts = assistantTexts((await client.getRun(lead)).conversation)
      return texts.length >= 2
        ? texts.map((t) => JSON.parse(t) as { code: number; stdout: string })
        : undefined
    }, 'the Task Lead’s commands')
    expect(results[0]?.code).toBe(0)
    expect(results[0]?.stdout).toContain(`Web is running at http://localhost:${port}`)
    expect(results[1]?.stdout).toBe(`${port}\n`)
    const again = await appNamed(client, task, 'Web')
    expect(again?.startedAt).toBe(running.startedAt)
    expect((await fetchJson(`http://127.0.0.1:${port}/`)).pid).toBe(seen.pid)

    const log = await client.ok<AppLog>('GET', `/tasks/${task.id}/apps/widgets/Web/log`)
    expect(log.text).toContain(`$ '${process.execPath}' '${stubApp}'`)
    expect(log.text).toContain(`stub app listening on ${port}`)

    await client.ok('POST', `/tasks/${task.id}/apps/restart`, { name: 'Web' })
    await eventText(client, task, `You restarted Web · localhost:${port}`)
    await waitForState(client, task, 'Web', 'running')
    expect((await fetchJson(`http://127.0.0.1:${port}/`)).pid).not.toBe(seen.pid)

    const stopped = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/stop`, {
      name: 'Web',
    })
    expect(stopped.state).toBe('stopped')
    expect(await answers(`http://127.0.0.1:${port}/`)).toBe(false)
    await eventText(client, task, 'You stopped Web')
  })

  test('a taken fixed port fails with a clear message', async () => {
    const server = net.createServer()
    blocker = server
    const taken = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
    )
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': appsYaml(
        ['      - name: Fixed', `        port: ${taken}`, `        run: ${runStub}`].join('\n'),
      ),
    })
    const client = await start()
    const task = await taskWithWorktree(client)

    const res = await client.call('POST', `/tasks/${task.id}/apps/start`, { name: 'Fixed' })
    expect(res.status).toBe(409)
    expect((res.body as { error: string }).error).toBe(
      `Port ${taken} is taken, so TED couldn’t start Fixed. Stop whatever uses it, or remove \`port:\` from the App in workflow.yaml.`,
    )
    expect(await appNamed(client, task, 'Fixed')).toMatchObject({
      state: 'failed',
      problem: `port ${taken} is taken`,
    })
    await eventText(client, task, `Fixed couldn’t start: port ${taken} is taken`)
  })

  test('a Run starts only its own Task’s Apps, and only the human stops or restarts them', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': appsYaml() })
    const client = await start()
    const task = await taskWithWorktree(client)
    const asRun = api(
      daemon?.port ?? 0,
      (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1'),
    )

    const res = await asRun.call('POST', `/tasks/${task.id}/apps/start`, { name: 'Web' })
    expect(res.status).toBe(403)
    expect((await asRun.call('POST', `/tasks/${task.id}/apps/stop`, { name: 'Web' })).status).toBe(
      403,
    )
    expect(
      (await asRun.call('POST', `/tasks/${task.id}/apps/restart`, { name: 'Web' })).status,
    ).toBe(403)
    expect((await apps(client, task)).every((a) => a.state === 'stopped')).toBe(true)
  })

  test('an App’s log keeps only its last bytes', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': appsYaml(
        [
          '      - name: Chatty',
          `        run: ${runStub}`,
          '        env:',
          '          STUB_APP_LINES: "3000"',
        ].join('\n'),
      ),
    })
    const client = await start(4096)
    const task = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${task.id}/apps/start`, { name: 'Chatty' })
    await waitForState(client, task, 'Chatty', 'running')

    const log = await waitUntil(async () => {
      const found = await client.ok<AppLog>('GET', `/tasks/${task.id}/apps/widgets/Chatty/log`)
      return found.text.includes('line 03000') ? found : undefined
    }, 'the last line in the log')
    const dir = path.join(home, 'apps', task.id, 'widgets', 'chatty')
    const sizes = await Promise.all(
      ['app.log', 'app.log.1'].map((f) => stat(path.join(dir, f)).then((s) => s.size)),
    )
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(4096)
    expect(log.truncated).toBe(true)
    expect(log.text).not.toContain('line 00001')
  })

  test('a crash shows as a thread event', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': appsYaml() })
    const client = await start()
    const task = await taskWithWorktree(client)

    await client.ok('POST', `/tasks/${task.id}/apps/start`, { name: 'Crashy' })

    const crashed = await waitForState(client, task, 'Crashy', 'exited')
    expect(crashed.exitCode).toBe(3)
    await eventText(client, task, 'Crashy exited with code 3')
  })

  test('an App survives a daemon restart, and archiving the Task stops it', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': appsYaml() })
    let client = await start()
    const task = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${task.id}/apps/start`, { name: 'Web' })
    const running = await waitForState(client, task, 'Web', 'running')
    const url = `http://127.0.0.1:${running.port}/`
    const pid = (await fetchJson(url)).pid

    await daemon?.stop()
    daemon = undefined
    expect((await fetchJson(url)).pid).toBe(pid)
    client = await start()
    expect(await appNamed(client, task, 'Web')).toMatchObject({
      state: 'running',
      port: running.port,
      startedAt: running.startedAt,
    })

    await client.ok('POST', `/tasks/${task.id}/archive`)

    await waitUntil(async () => !(await answers(url)), 'the App to stop')
    await waitUntil(
      async () =>
        !(await readdir(path.join(home, 'apps')).catch((): string[] => [])).includes(task.id),
      'the App folder to be removed',
    )
  })

  test('a Run of the Task gets every App’s port and URL', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': appsYaml() })
    const client = await start()
    const task = await taskWithWorktree(
      client,
      JSON.stringify({
        steps: [
          {
            run: [
              'sh',
              '-c',
              'printf "%s\\n" "$TED_APP_WEB_URL" "$TED_APP_API_PORT" "$TED_APP_CRASHY_PORT"',
            ],
          },
          { endTurn: true },
        ],
      }),
    )
    const lead = await waitUntil(async () => {
      const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      return current?.leadRunId
    }, 'the lead')
    const [result] = await waitUntil(async () => {
      const texts = assistantTexts((await client.getRun(lead)).conversation)
      return texts.length >= 1 ? texts.map((t) => JSON.parse(t) as { stdout: string }) : undefined
    }, 'printenv')
    const [webUrl, apiPort, crashyPort] = (result?.stdout ?? '').trim().split('\n')
    expect(Number(apiPort)).toBeGreaterThan(0)
    expect(new Set([webUrl, apiPort, crashyPort]).size).toBe(3)
    const started = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/start`, {
      name: 'API',
    })
    expect(String(started.port)).toBe(apiPort)
    expect((await stat(path.join(home, 'apps', task.id, 'ports.json'))).isFile()).toBe(true)
  })
})
