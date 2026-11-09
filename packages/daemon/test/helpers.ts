import { execFile } from 'node:child_process'
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
  type Run,
  type RunWithConversation,
  readDaemonInfo,
} from '@ted/protocol'

const execFileAsync = promisify(execFile)

export async function makeTempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-home-'))
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) }
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

export const stubClaudePath = fileURLToPath(new URL('./fixtures/stub-claude.ts', import.meta.url))
export const stubCodexPath = fileURLToPath(new URL('./fixtures/stub-codex.ts', import.meta.url))

export async function waitUntil<T>(
  check: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

export async function hostRecords(home: string, runId: string): Promise<Record<string, unknown>[]> {
  const log = await readFile(path.join(home, 'runs', runId, 'host.log'), 'utf8').catch(() => '')
  return log
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

export async function killRunHosts(home: string): Promise<void> {
  const runIds = await readdir(path.join(home, 'runs')).catch(() => [])
  for (const runId of runIds) {
    const starts = (await hostRecords(home, runId)).filter((r) => r.t === 'start')
    for (const pid of starts.flatMap((start) => [start.agentPid, start.hostPid])) {
      try {
        if (typeof pid === 'number') process.kill(pid, 'SIGKILL')
      } catch {}
    }
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

export async function stopDaemonIn(home: string): Promise<void> {
  const info = await readDaemonInfo(home)
  if (info && isAlive(info.pid)) {
    process.kill(info.pid, 'SIGTERM')
    await waitForExit(info.pid)
  }
  await killRunHosts(home)
}

export function api(port: number, token: string) {
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await rawRequest(port, {
      method,
      path: route,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return {
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

export async function makeOriginRepo(parent: string): Promise<string> {
  const origin = path.join(parent, 'acme', 'widgets.git')
  const work = path.join(parent, 'seed')
  const git = (cwd: string, ...args: string[]) =>
    execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
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
