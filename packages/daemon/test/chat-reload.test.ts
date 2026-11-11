import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChatItem, Comment, Factory, RunChat, RunSummary, Task } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-chat-reload-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const usage = (input: number, output: number) => ({
  endTurn: true,
  usage: { input_tokens: input, output_tokens: output },
})

async function startTask(client: Client, title: string) {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB', start: true })
  return waitUntil(async () => {
    const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return current?.runs[0]?.state === 'idle' && current.leadRunId !== undefined
      ? current
      : undefined
  }, 'the Task Lead to go idle')
}

const chatOf = (client: Client, runId: string) => client.ok<RunChat>('GET', `/runs/${runId}/chat`)
const runsOf = (client: Client, taskId: string) =>
  client.ok<RunSummary[]>('GET', `/tasks/${taskId}/runs`)
const said = (chat: RunChat) => chat.items.flatMap((i) => (i.kind === 'agent' ? [i.text] : []))
const typed = (chat: RunChat) =>
  chat.items.filter((i): i is Extract<ChatItem, { kind: 'human' }> => i.kind === 'human')

async function chatWhen(client: Client, runId: string, ready: (chat: RunChat) => boolean) {
  return waitUntil(async () => {
    const chat = await chatOf(client, runId)
    return ready(chat) ? chat : undefined
  }, 'the Run chat to change')
}

test('a chat read again shows new output, tokens, a queued message, its delivery and output after a restart', async () => {
  const client = await startTed()
  const release = path.join(scratch, 'release')
  const task = await startTask(
    client,
    steps(
      { everyMessage: [{ waitFor: release }, { say: 'Again.' }, usage(5, 5)] },
      { say: 'First.' },
      usage(10, 20),
    ),
  )
  const runId = task.leadRunId ?? ''
  const first = await chatOf(client, runId)
  expect(said(first)).toEqual(['First.'])
  expect(first.run.tokens).toBe(30)
  expect((await runsOf(client, task.id)).map((r) => r.tokens)).toEqual([30])

  await client.ok('POST', `/runs/${runId}/messages`, { text: 'One' })
  await chatWhen(client, runId, (chat) => chat.run.state === 'working')
  const queued = await client.ok<{ id: string }>('POST', `/runs/${runId}/messages`, { text: 'Two' })
  expect(typed(await chatOf(client, runId)).at(-1)).toMatchObject({
    id: queued.id,
    text: 'Two',
    queued: true,
  })

  await writeFile(release, '')
  const both = await chatWhen(
    client,
    runId,
    (chat) => said(chat).length === 3 && chat.run.state === 'idle',
  )
  expect(said(both)).toEqual(['First.', 'Again.', 'Again.'])
  expect(typed(both).map((i) => [i.text, i.sent, i.queued])).toEqual([
    ['One', true, undefined],
    ['Two', true, undefined],
  ])
  expect(both.run.tokens).toBe(50)

  await client.ok('POST', `/runs/${runId}/restart`)
  await client.ok('POST', `/runs/${runId}/messages`, {
    text: steps({ say: 'After the restart.' }, usage(1, 1)),
  })
  const restarted = await chatWhen(client, runId, (chat) =>
    said(chat).includes('After the restart.'),
  )
  expect(said(restarted)).toEqual(['First.', 'Again.', 'Again.', 'After the restart.'])
  const summary = await waitUntil(async () => {
    const [run] = await runsOf(client, task.id)
    return run?.tokens === 52 ? run : undefined
  }, 'the tokens of the last turn')
  expect(summary.id).toBe(runId)
})

test('a chat read again shows a permission request asked since, and its answer', async () => {
  const client = await startTed()
  const task = await startTask(
    client,
    steps(
      {
        everyMessage: [
          {
            permission: {
              tool: 'Bash',
              input: { command: 'rm -rf build', description: 'Clear the build' },
              description: 'Clear the build',
            },
          },
          { endTurn: true },
        ],
      },
      { endTurn: true },
    ),
  )
  const runId = task.leadRunId ?? ''
  expect((await chatOf(client, runId)).items.some((i) => i.kind === 'permission')).toBe(false)

  await client.ok('POST', `/runs/${runId}/messages`, { text: 'Go on' })
  const asked = await chatWhen(client, runId, (chat) =>
    chat.items.some((i) => i.kind === 'permission'),
  )
  const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
  const request = comments.find((c) => c.kind === 'permission')
  const shown = asked.items.filter((i) => i.kind === 'permission')
  expect(shown.map((i) => i.id)).toEqual([request?.id])
  expect(shown[0]?.request.answer).toBeUndefined()

  await client.ok('POST', `/comments/${request?.id}/answer`, { action: 'approve' })
  const answered = await chatWhen(client, runId, (chat) =>
    chat.items.some((i) => i.kind === 'permission' && i.request.answer !== undefined),
  )
  expect(answered.items.filter((i) => i.kind === 'permission')).toHaveLength(1)
})

test('a finished Run keeps its tokens between reads and loses them when its output is deleted', async () => {
  const client = await startTed()
  const task = await startTask(client, steps({ say: 'Done.' }, usage(10, 20)))
  const runId = task.leadRunId ?? ''
  await client.ok('POST', `/tasks/${task.id}/stop`)
  await waitUntil(
    async () => (await runsOf(client, task.id))[0]?.state === 'finished' || undefined,
    'the Run to finish',
  )
  const before = await runsOf(client, task.id)
  expect(before.map((r) => r.tokens)).toEqual([30])
  expect(await runsOf(client, task.id)).toEqual(before)
  expect(said(await chatOf(client, runId))).toEqual(['Done.'])

  await rm(path.join(home, 'runs', runId, 'host.log'))

  expect((await runsOf(client, task.id)).map((r) => r.tokens)).toEqual([undefined])
  const chat = await chatOf(client, runId)
  expect(said(chat)).toEqual([])
  expect(chat.run.tokens).toBeUndefined()
  expect(chat.items.find((i) => i.id === 'output-not-kept')).toMatchObject({
    title: 'Output no longer kept',
  })
})
