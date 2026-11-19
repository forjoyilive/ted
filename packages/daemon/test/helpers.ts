import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  type ConversationEntry,
  DaemonClient,
  type DaemonEvent,
  type DaemonInfo,
  type Run,
  type RunWithConversation,
  readDaemonInfo,
  signRequest,
  tedPaths,
} from '@ted/protocol'
import { stringify } from 'yaml'
import { isLockHeld } from '../src/lock.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { runFiles } from '../src/runs/host-files.ts'
import { signalGroup, signalProcess } from '../src/signal.ts'
import { AppDaemons } from './support/app-daemons.ts'
import { killMarked } from './support/processes.ts'

const execFileAsync = promisify(execFile)

export async function makeTempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-home-'))
  return { home, cleanup: () => removeHome(home) }
}

export interface RawResponse {
  status: number
  body: string
}

export function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

export async function tokenFor(home: string): Promise<string> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error(`no daemon.json in ${home}`)
  return info.token
}

export const testAppToken = 'test-app-token'
const appDaemons = new AppDaemons()

export function spawnDaemonProcess(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))
  const child = spawn(process.execPath, [mainPath, '--app-token-stdin', ...args], {
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  child.stdin?.end(`${testAppToken}\n`)
  return child
}

export async function daemonAsApp(home: string, env: NodeJS.ProcessEnv): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  const known = info && appClient(info, testAppToken)
  if (known && (await known.provesAppKey().catch(() => false))) return known
  await stopDaemonIn(home)
  await rm(path.join(home, 'daemon.json'), { force: true })
  const child = spawnDaemonProcess(['--exit-when-idle'], { ...env, TED_HOME: home })
  return appClient(await appDaemons.start(home, child), testAppToken)
}

export const stubClaudePath = fileURLToPath(new URL('./fixtures/stub-claude.ts', import.meta.url))
export const stubCodexPath = fileURLToPath(new URL('./fixtures/stub-codex.ts', import.meta.url))
export const stubPiPath = fileURLToPath(new URL('./fixtures/stub-pi.ts', import.meta.url))

export async function waitUntil<T>(
  check: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

// A host that has not started when its daemon stops refuses to start, so a test that
// restarts the daemon under a Run waits for this first.
export async function hostsStarted(home: string): Promise<void> {
  const runIds = await readdir(path.join(home, 'runs')).catch(() => [])
  for (const runId of runIds) {
    await waitUntil(
      async () => (await hostRecords(home, runId)).some((r) => r.t === 'start'),
      `Run ${runId}’s host to start`,
    )
  }
}

export async function hostRecords(home: string, runId: string): Promise<Record<string, unknown>[]> {
  const log = await readFile(path.join(home, 'runs', runId, 'host.log'), 'utf8').catch(() => '')
  return log
    .split('\n')
    .slice(0, -1)
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

// A host that had not started when its daemon stopped refuses to start (launch authority)
// and exits, so the wait for its start record ends once nothing holds the Run’s lock.
export async function killRunHosts(
  home: string,
  { waitForStart = false }: { waitForStart?: boolean } = {},
): Promise<void> {
  const runIds = await readdir(path.join(home, 'runs')).catch(() => [])
  for (const runId of runIds) {
    if (waitForStart) {
      const lock = runFiles(path.join(home, 'runs', runId)).lock
      const since = Date.now()
      await waitUntil(
        async () =>
          (await hostRecords(home, runId)).some((r) => r.t === 'start') ||
          (Date.now() - since > 300 && !isLockHeld(lock)),
        `Run ${runId}’s host to start`,
        2_000,
      ).catch(() => undefined)
    }
    const starts = (await hostRecords(home, runId)).filter((r) => r.t === 'start')
    for (const pid of starts.flatMap((start) => [start.agentPid, start.hostPid])) {
      try {
        signalProcess(pid, 'SIGKILL')
      } catch {}
    }
  }
}

export async function appHostStarts(
  home: string,
): Promise<{ hostPid: number; pid: number | null }[]> {
  const root = path.join(home, 'apps')
  const starts: { hostPid: number; pid: number | null }[] = []
  for (const task of await readdir(root).catch(() => [])) {
    for (const repo of await readdir(path.join(root, task)).catch(() => [])) {
      for (const app of await readdir(path.join(root, task, repo)).catch(() => [])) {
        const text = await readFile(path.join(root, task, repo, app, 'host.jsonl'), 'utf8').catch(
          () => '',
        )
        for (const line of text.split('\n').filter((l) => l.startsWith('{"t":"start"'))) {
          starts.push(JSON.parse(line) as { hostPid: number; pid: number | null })
        }
      }
    }
  }
  return starts
}

export async function killAppHosts(home: string): Promise<void> {
  for (const start of await appHostStarts(home)) {
    try {
      signalGroup(start.pid, 'SIGKILL')
    } catch {}
    try {
      signalProcess(start.hostPid, 'SIGKILL')
    } catch {}
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still running`)
    await sleep(50)
  }
}

export async function removeHome(home: string): Promise<void> {
  const file = process.env.TED_TEST_FILE
  if (file) await killMarked('TED_HOME', home, [['TED_TEST_FILE', file]])
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

export async function stopDaemonIn(home: string): Promise<void> {
  await appDaemons.stop(home)
  const info = await readDaemonInfo(home)
  if (info && isAlive(info.pid)) {
    process.kill(info.pid, 'SIGTERM')
    await waitForExit(info.pid)
  }
  await killRunHosts(home)
  await killAppHosts(home)
}

export function appHeaders(
  appKey: string,
  method: string,
  route: string,
  body?: string,
): Record<string, string> {
  return signRequest(appKey, method, route, body)
}

export function appClient(info: DaemonInfo, appKey: string | undefined): DaemonClient {
  return appKey === undefined ? new DaemonClient(info) : new DaemonClient(info, '', { appKey })
}

export function api(port: number, auth: string | { appKey: string }) {
  const call = async (method: string, route: string, body?: unknown) => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const res = await rawRequest(port, {
      method,
      path: route,
      headers:
        typeof auth === 'string'
          ? { authorization: `Bearer ${auth}` }
          : appHeaders(auth.appKey, method, route, text),
      ...(text !== undefined && { body: text }),
    })
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return {
    async subscribe(changed: (event: DaemonEvent) => void): Promise<() => void> {
      const client =
        typeof auth === 'string'
          ? new DaemonClient({ port, token: auth, pid: 0, version: 'test' })
          : new DaemonClient({ port, token: '', pid: 0, version: 'test' }, '', {
              appKey: auth.appKey,
            })
      const subscription = await client.subscribe(changed)
      return () => subscription.close()
    },
    call,
    async startRun(steps: unknown[], cwd: string, agent?: string): Promise<Run> {
      const res = await call('POST', '/dev/runs', {
        prompt: JSON.stringify({ steps }),
        cwd,
        ...(agent !== undefined && { agent }),
      })
      if (res.status !== 201) throw new Error(`start failed: ${JSON.stringify(res.body)}`)
      return res.body as Run
    },
    async getRun(id: string): Promise<RunWithConversation> {
      const res = await call('GET', `/runs/${id}`)
      if (res.status !== 200) throw new Error(`get failed: ${JSON.stringify(res.body)}`)
      return res.body as RunWithConversation
    },
  }
}

// YAML quotes a hash that reads as a number, such as 3e44014 or 1234567.
export const basedOnLine = (hash: string) => stringify({ based_on: hash }).trim()

export async function devRunToken(home: string, port: number, appKey: string): Promise<string> {
  const run = await api(port, { appKey }).startRun([{ endTurn: true }], home)
  return (await loadRunTokens(tedPaths(home).runTokenKey)).issue(run.id)
}

export function assistantTexts(conversation: ConversationEntry[]): string[] {
  return conversation.flatMap((e) => {
    const message = JSON.parse(e.line) as {
      type?: string
      message?: { content?: { type: string; text?: string }[] }
      method?: string
      params?: { item?: { type: string; text?: string } }
    }
    const item = message.params?.item
    if (message.method === 'item/completed' && item?.type === 'agentMessage') {
      return item.text === undefined ? [] : [item.text]
    }
    if (message.type !== 'assistant') return []
    return (message.message?.content ?? []).flatMap((c) => (c.text === undefined ? [] : [c.text]))
  })
}

export async function makeOriginRepo(
  parent: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const origin = path.join(parent, 'acme', 'widgets.git')
  const work = path.join(parent, 'seed')
  const git = (cwd: string, ...args: string[]) =>
    execFileAsync('git', args, {
      cwd,
      env: {
        ...environment,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })
  await mkdir(origin, { recursive: true })
  await git(origin, 'init', '--bare', '--initial-branch=main')
  await mkdir(work, { recursive: true })
  await git(work, 'init', '--initial-branch=main')
  await writeFile(path.join(work, 'README.md'), '# widgets\n')
  await git(work, 'add', 'README.md')
  await git(work, 'commit', '-m', 'first')
  await git(work, 'push', origin, 'main')
  return origin
}

export async function commitToOrigin(parent: string, files: Record<string, string>): Promise<void> {
  const work = path.join(parent, 'seed')
  const origin = path.join(parent, 'acme', 'widgets.git')
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(work, file)), { recursive: true })
    await writeFile(path.join(work, file), content)
  }
  await execFileAsync('git', ['add', '-A'], { cwd: work, env })
  await execFileAsync('git', ['commit', '-m', 'change'], { cwd: work, env })
  await execFileAsync('git', ['push', origin, 'main'], { cwd: work, env })
}

export async function refsOf(repo: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['for-each-ref'], { cwd: repo })
  return stdout
}

export async function storeDbFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.db')).sort()
}

export async function pretendStateSchemaChanged(home: string): Promise<void> {
  const dir = path.join(home, 'store', 'ted')
  for (const file of await storeDbFiles(dir)) {
    if (file.startsWith('state')) {
      await rename(path.join(dir, file), path.join(dir, `stateold${file.slice(5)}`))
    }
  }
}

export async function editEventlog(home: string, sql: string): Promise<void> {
  const dir = path.join(home, 'store', 'ted')
  const file = (await storeDbFiles(dir)).find((f) => f.startsWith('eventlog'))
  if (!file) throw new Error('no event log')
  const db = new DatabaseSync(path.join(dir, file))
  db.exec(sql)
  db.close()
}

export async function eventArgs(home: string, name: string): Promise<string[]> {
  const dir = path.join(home, 'store', 'ted')
  const file = (await storeDbFiles(dir)).find((f) => f.startsWith('eventlog'))
  if (!file) throw new Error('no event log')
  const db = new DatabaseSync(path.join(dir, file), { readOnly: true })
  try {
    const rows = db
      .prepare('SELECT argsJson FROM eventlog WHERE name = ? ORDER BY seqNumGlobal')
      .all(name) as { argsJson: string }[]
    return rows.map((row) => row.argsJson)
  } finally {
    db.close()
  }
}

export async function eventCount(home: string, name: string): Promise<number> {
  return (await eventArgs(home, name)).length
}

export function fixtureEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [
    'PATH',
    'TMPDIR',
    'SystemRoot',
    'TED_TEST_RUN',
    'TED_TEST_FILE',
    'TED_EXIT_WITH_PID',
    'TED_REMOTE_EXECUTION',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    TED_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    TED_LOGIN_SHELL: 'off',
    TED_STAY_AWAKE: 'off',
    TED_LOW_PRIORITY: 'off',
    TED_GH_BIN: fileURLToPath(new URL('./fixtures/stub-gh.ts', import.meta.url)),
    TED_KEYRING_MODULE: fileURLToPath(new URL('./fixtures/stub-keyring.ts', import.meta.url)),
    TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
    TED_TIME_MACHINE: 'off',
    TED_STUB_GH: path.join(home, 'gh.json'),
    TED_STUB_GH_LOG: path.join(home, 'gh.jsonl'),
    TED_FREE_BYTES_FILE: fileURLToPath(new URL('./fixtures/free-bytes.txt', import.meta.url)),
    TED_LOAD_FILE: fileURLToPath(new URL('./fixtures/load.txt', import.meta.url)),
    TED_MEMORY_FILE: fileURLToPath(new URL('./fixtures/memory.json', import.meta.url)),
    TED_ONLINE_FILE: fileURLToPath(new URL('./fixtures/online.txt', import.meta.url)),
  }
}

export async function all<T>(names: readonly T[], body: (name: T, index: number) => Promise<void>) {
  const results = await Promise.allSettled(names.map(body))
  const failed = results.flatMap((result, i) =>
    result.status === 'rejected'
      ? [
          `${String(names[i])}: ${result.reason instanceof Error ? result.reason.stack : result.reason}`,
        ]
      : [],
  )
  if (failed.length > 0) throw new Error(failed.join('\n\n'))
}
