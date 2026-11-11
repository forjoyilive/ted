import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Factory, type SideChat, type Task, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  stubCodexPath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-side-chat-'))
  origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
})
afterEach(async () => {
  await daemon?.stop()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})
async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
    return res.body as T
  }
  return { ...client, ok }
}
test.each(['claude', 'codex'] as const)(
  'opens a frozen %s side chat, answers separately and reopens after restart',
  async (agent) => {
    let client = await start()
    await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const created = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      lead: { agent },
      start: true,
      title: JSON.stringify({
        steps: [{ say: 'Source answer before snapshot' }, { endTurn: true }],
      }),
    })
    const task = await waitUntil(async () => {
      const t = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === created.id)
      return t?.runs[0]?.state === 'idle' ? t : undefined
    }, 'source Run idle')
    const source = task.leadRunId ?? ''
    const route = `/runs/${source}/side-chat`
    const chat = await client.ok<SideChat>('POST', route)
    expect((await client.ok<SideChat>('POST', route)).id).toBe(chat.id)
    expect((await client.call('POST', `${route}/messages`, { text: '  ' })).status).toBe(400)
    expect((await client.ok<SideChat>('GET', route)).state).toBe('ready')
    const snapshot = await readFile(
      path.join(home, 'runs', chat.id, 'side-chat-context.txt'),
      'utf8',
    )
    expect(snapshot).toContain('Source answer before snapshot')
    const sourceBefore = await client.ok('GET', `/runs/${source}/chat`)
    const question = JSON.stringify({ steps: [{ say: 'Separate reply' }, { endTurn: true }] })
    await client.ok('POST', `${route}/messages`, { text: question })
    const ready = await waitUntil(async () => {
      const value = await client.ok<SideChat>('GET', route)
      return value.state === 'ready' &&
        value.chat?.items.some((i) => i.kind === 'agent' && i.text === 'Separate reply')
        ? value
        : undefined
    }, 'side reply')
    expect(ready.chat?.run.role).toBe('side-chat')
    await client.ok('POST', `${route}/messages`, {
      text: JSON.stringify({ steps: [{ say: 'Follow-up reply' }, { endTurn: true }] }),
    })
    const continued = await waitUntil(async () => {
      const c = await client.ok<SideChat>('GET', route)
      if (c.state === 'failed') throw new Error(JSON.stringify(c))
      return c.state === 'ready' &&
        c.chat?.items.some((i) => i.kind === 'agent' && i.text === 'Follow-up reply')
        ? c
        : undefined
    }, 'follow-up reply')
    expect(await client.ok('GET', `/runs/${source}/chat`)).toEqual(sourceBefore)
    const launch = JSON.parse(
      await readFile(path.join(home, 'runs', chat.id, 'launch.json'), 'utf8'),
    )
    if (agent === 'claude') {
      expect(launch.args).toContain('--tools')
      expect(launch.args).toContain('--strict-mcp-config')
    } else {
      expect(launch.args).toContain('features.shell_tool=false')
      expect(launch.args).toContain('approval_policy="never"')
    }
    const record = JSON.parse(await readFile(path.join(launch.cwd, 'stub-record.json'), 'utf8'))
    expect(record.env.TED_RUN_CAPABILITY).toBeUndefined()
    expect(record.env.TED_RUN_TOKEN).toBeUndefined()
    expect(record.env.TED_TASK).toBeUndefined()
    const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
    const untrusted = api(daemon?.port ?? 0, tokens.issue(chat.id))
    expect((await untrusted.call('GET', '/caller')).status).toBe(403)
    expect(launch.cwd).not.toBe(task.repos[0]?.worktree)
    expect(
      (await client.call('POST', `/runs/${chat.id}/messages`, { text: 'bypass' })).status,
    ).toBe(409)
    expect((await client.call('POST', `/runs/${chat.id}/restart`)).status).toBe(409)
    await client.ok('POST', `/runs/${source}/messages`, {
      text: JSON.stringify({
        steps: [{ say: 'Source changed after snapshot' }, { endTurn: true }],
      }),
    })
    await waitUntil(async () => {
      const value = await client.ok<{ items: { text?: string }[] }>('GET', `/runs/${source}/chat`)
      return value.items.some((i) => i.text === 'Source changed after snapshot') ? true : undefined
    }, 'later source activity')
    expect(await readFile(path.join(home, 'runs', chat.id, 'side-chat-context.txt'), 'utf8')).toBe(
      snapshot,
    )
    await daemon?.stop()
    client = await start()
    expect((await client.ok<SideChat>('GET', route)).chat?.items).toEqual(continued.chat?.items)
    expect(await readFile(path.join(home, 'runs', chat.id, 'side-chat-context.txt'), 'utf8')).toBe(
      snapshot,
    )
    await client.ok('POST', `/tasks/${task.id}/delete`)
    await waitUntil(
      async () =>
        (await client.call('GET', `/runs/${chat.id}`)).status === 404 ? true : undefined,
      'side Run removed with Task',
    )
  },
)

test('refuses unsupported Runs and file-token writes', async () => {
  const client = await start()
  const run = await client.ok<{ id: string }>('POST', '/dev/runs', {
    agent: 'claude',
    cwd: scratch,
    prompt: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  expect((await client.call('POST', `/runs/${run.id}/side-chat`)).status).toBe(400)
  const token = await tokenFor(home)
  expect(
    (
      await rawRequest(daemon?.port ?? 0, {
        method: 'POST',
        path: `/runs/${run.id}/side-chat`,
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(403)
})

test('queues every side turn, releases its slot on stop, retries and refuses tool attempts', async () => {
  const client = await start()
  await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  await client.ok('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const sources: string[] = []
  for (let n = 0; n < 2; n++) {
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      start: true,
      title: JSON.stringify({ steps: [{ say: `Source ${n}` }, { endTurn: true }] }),
    })
    sources.push(
      await waitUntil(async () => {
        const t = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
        return t?.runs[0]?.state === 'idle' ? t.leadRunId : undefined
      }, 'idle source'),
    )
  }
  const first = `/runs/${sources[0]}/side-chat`
  const second = `/runs/${sources[1]}/side-chat`
  const one = await client.ok<SideChat>('POST', first)
  const two = await client.ok<SideChat>('POST', second)
  const signal = path.join(scratch, 'answer-now')
  await client.ok('POST', `${first}/messages`, {
    text: JSON.stringify({
      steps: [{ waitFor: signal }, { say: 'First reply' }, { endTurn: true }],
    }),
  })
  await waitUntil(
    async () => ((await client.ok<SideChat>('GET', first)).state === 'working' ? true : undefined),
    'first working',
  )
  await client.ok('POST', `${second}/messages`, {
    text: JSON.stringify({ steps: [{ say: 'Second reply' }, { endTurn: true }] }),
  })
  expect((await client.ok<SideChat>('GET', second)).state).toBe('queued')
  expect((await client.call('POST', `${second}/messages`, { text: 'extra' })).status).toBe(409)
  const slots = await client.ok<import('@ted/protocol').RunSlots>('GET', '/slots')
  expect(slots.holders.some((h) => h.kind === 'side-chat' && h.runId === one.id)).toBe(true)
  expect(slots.queue.some((q) => q.kind === 'side-chat' && q.runId === two.id)).toBe(true)
  await client.ok('POST', `${first}/stop`)
  await waitUntil(
    async () => ((await client.ok<SideChat>('GET', second)).state === 'ready' ? true : undefined),
    'second reply',
  )
  await writeFile(signal, '')
  await client.ok('POST', `${first}/retry`)
  await waitUntil(async () => {
    const c = await client.ok<SideChat>('GET', first)
    if (c.state === 'failed') throw new Error(JSON.stringify(c))
    return c.state === 'ready' ? true : undefined
  }, 'retried reply')
  await client.ok('POST', `${first}/messages`, {
    text: JSON.stringify({ steps: [{ tool: 'Bash' }, { endTurn: true }] }),
  })
  const failed = await waitUntil(async () => {
    const c = await client.ok<SideChat>('GET', first)
    return c.state === 'failed' ? c : undefined
  }, 'tool refusal')
  expect(failed.error).toContain('tool')
  await waitUntil(async () => {
    const r = await client.ok<{ run: { state: string } }>('GET', `/runs/${one.id}`)
    return r.run.state === 'finished' ? true : undefined
  }, 'tool attempt stopped')
  await client.ok('POST', `${first}/messages`, {
    text: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  const empty = await waitUntil(async () => {
    const c = await client.ok<SideChat>('GET', first)
    return c.state === 'failed' ? c : undefined
  }, 'empty answer refused')
  expect(empty.error).toContain('empty')
})
