import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Factory, InboxItem, RunSlots, RunWithConversation, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-auto-backlog-'))
  origin = await makeOriginRepo(scratch)
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

function clientNow() {
  if (!daemon) throw new Error('daemon not started')
  const client = api(daemon.port, { appKey: daemon.appToken })
  return {
    ...client,
    async ok<T>(method: string, route: string, body?: unknown): Promise<T> {
      const response = await client.call(method, route, body)
      if (response.status >= 300) throw new Error(`${route}: ${JSON.stringify(response)}`)
      return response.body as T
    },
  }
}
type Client = ReturnType<typeof clientNow>
async function start(options: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  daemon = await startDaemon({ ...options, home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = clientNow()
  const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { client, factory }
}
const steps = (...steps: unknown[]) => JSON.stringify({ steps })
const working = (file: string) => steps({ waitFor: file }, { endTurn: true })
const create = (client: Client, fields: Partial<Task> = {}) =>
  client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: working(path.join(scratch, 'never')),
    ...fields,
  })
const get = async (client: Client, task: Task) => {
  const current = (await client.ok<Task[]>('GET', '/tasks')).find(
    (candidate) => candidate.id === task.id,
  )
  if (!current) throw new Error(`missing Task ${task.displayId}`)
  return current
}
const lead = (client: Client, task: Task) =>
  waitUntil(async () => {
    const current = await get(client, task)
    return current.leadRunId ? current : undefined
  }, `${task.displayId} to start`)
const slots = (client: Client) => client.ok<RunSlots>('GET', '/slots')

const messages = async (client: Client, runId: string) => {
  const detail = await client.ok<RunWithConversation>('GET', `/runs/${runId}`)
  return detail.conversation.flatMap(({ line }) => {
    const item = JSON.parse(line)
    return item.type === 'user' && typeof item.message?.content === 'string'
      ? [item.message.content as string]
      : []
  })
}

describe('overnight mode', () => {
  test('a blocking question keeps its Run and Inbox item while another Task starts', async () => {
    const { client } = await start({ nudgeAfterMs: 50 })
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const a = await create(client, {
      title: steps({ run: ['ted', 'outcome', 'ask', 'Which search fields?'] }, { endTurn: true }),
    })
    const b = await create(client)
    await client.ok('PATCH', '/settings', { overnightMode: true })
    const first = await lead(client, a)
    await lead(client, b)
    const requests = await client.ok<InboxItem[]>('GET', '/inbox')
    expect(requests.map(({ request }) => request)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: a.id,
          body: 'Which search fields?',
        }),
      ]),
    )
    expect(requests.find(({ request }) => request.taskId === a.id)?.request.answer).toBeUndefined()
    expect((await get(client, a)).runs).toHaveLength(1)
    expect((await get(client, a)).runs[0]?.state).toBe('idle')
    expect((await messages(client, first.leadRunId ?? '')).join('\n')).toContain(
      'Overnight mode is on',
    )
    await client.ok('PATCH', '/settings', { overnightMode: false })
    expect((await get(client, a)).runs[0]?.state).toBe('idle')
    expect(await slots(client)).toMatchObject({ working: 1 })
  })

  test('a Gate request posted before the mode turned on stays in the Inbox and frees the slot', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nstages:\n  intake:\n    gate: true\n',
    })
    const brief = path.join(scratch, 'brief.md')
    await writeFile(
      brief,
      '## Goal\nExample\n## Decisions so far\nNone\n## Current state\nReady\n## Open questions\nNone\n## Next step\nWork\n',
    )
    const { client } = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const a = await create(client, {
      title: steps(
        { run: ['ted', 'brief', 'write', '--file', brief] },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ),
    })
    await client.ok('POST', `/tasks/${a.id}/start`)
    await waitUntil(
      async () =>
        (await client.ok<InboxItem[]>('GET', '/inbox')).some(
          ({ request }) => request.taskId === a.id && request.gate,
        ),
      'the Intake Gate request',
    )
    const b = await create(client)
    await client.ok('PATCH', '/settings', { overnightMode: true })
    await lead(client, b)
    const waiting = await get(client, a)
    expect(waiting.stage).toBe('intake')
    const requests = await client.ok<InboxItem[]>('GET', '/inbox')
    expect(
      requests.some(({ request }) => request.taskId === a.id && request.gate && !request.answer),
    ).toBe(true)
  })

  test('a toggle reaches a working lead only at its next boundary and never wakes an idle lead', async () => {
    const { client } = await start()
    const boundary = path.join(scratch, 'boundary')
    const end = path.join(scratch, 'end')
    const a = await create(client, {
      title: steps({ waitFor: boundary }, { tool: 'Bash' }, { waitFor: end }, { endTurn: true }),
    })
    await client.ok('POST', `/tasks/${a.id}/start`)
    const started = await lead(client, a)
    const runId = started.leadRunId ?? ''
    await waitUntil(async () => (await messages(client, runId)).length > 0, 'initial prompt')
    await client.ok('PATCH', '/settings', { overnightMode: true })
    expect((await messages(client, runId)).some((m) => m.includes('Overnight mode is on'))).toBe(
      false,
    )
    await writeFile(boundary, '')
    await waitUntil(
      async () => (await messages(client, runId)).some((m) => m.includes('Overnight mode is on')),
      'overnight steering',
    )
    await client.ok('PATCH', '/settings', { overnightMode: false })
    await writeFile(end, '')
    await waitUntil(async () => (await get(client, a)).runs[0]?.state === 'idle', 'idle lead')
    await client.ok('PATCH', '/settings', { overnightMode: true })
    expect((await get(client, a)).runs[0]?.state).toBe('idle')
  })

  test('turning overnight mode off preserves a Factory’s own automatic starting', async () => {
    const { client, factory } = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1, overnightMode: true })
    const a = await create(client)
    await lead(client, a)
    await client.ok('PUT', `/factories/${factory.id}/auto-start-backlog`, { enabled: true })
    await client.ok('PATCH', '/settings', { overnightMode: false })
    const b = await create(client)
    await client.ok('POST', `/tasks/${a.id}/stop`)
    await lead(client, b)
  })
})
