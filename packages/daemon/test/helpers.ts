import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  type ConversationEntry,
  type Run,
  type RunWithConversation,
  readDaemonInfo,
} from '@ted/protocol'

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
    const start = (await hostRecords(home, runId)).find((r) => r.t === 'start')
    for (const pid of [start?.agentPid, start?.hostPid]) {
      try {
        if (typeof pid === 'number') process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
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
    async startRun(steps: unknown[], cwd: string): Promise<Run> {
      const res = await call('POST', '/dev/runs', { prompt: JSON.stringify({ steps }), cwd })
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
      type: string
      message?: { content?: { type: string; text?: string }[] }
    }
    if (message.type !== 'assistant') return []
    return (message.message?.content ?? []).flatMap((c) => (c.text === undefined ? [] : [c.text]))
  })
}
