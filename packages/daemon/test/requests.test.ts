import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Comment, Factory, InboxItem, Task } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-requests-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const brief = `## Goal

Let notes be edited offline.

## Decisions so far

- Keep both edits on a clash.

## Current state

Written up.

## Open questions

None.

## Next step

Build it.
`

async function start(workflow = 'version: 1\norder: [intake, work, merge]\n') {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, await tokenFor(home))
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(briefFile, brief)
  return { ...client, ok, briefFile }
}

type Client = Awaited<ReturnType<typeof start>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

async function startTask(client: Client, ...list: unknown[]): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', { title: steps(...list), factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const inbox = (client: Client) => client.ok<InboxItem[]>('GET', '/inbox')

async function idleLead(client: Client, task: Task): Promise<string> {
  const runId = await waitUntil(
    async () => (await getTask(client, task.id)).leadRunId,
    'a Task Lead Run',
  )
  await waitUntil(
    async () => (await client.getRun(runId)).run.state === 'idle',
    `${task.displayId}’s Task Lead to go idle`,
  )
  return runId
}

async function asRun(runId: string) {
  const token = (await loadRunTokens(tedPaths(home).runTokenKey)).issue(runId)
  return api(daemon?.port ?? 0, token)
}

describe('ted ask --supersedes', () => {
  test('the Task Lead replaces its own unanswered question; the old one leaves the Inbox, marked superseded', async () => {
    const client = await start()
    const task = await startTask(
      client,
      {
        run: [
          'sh',
          '-c',
          'id=$(ted outcome ask --choice "Recent notes" --choice "Nothing" "Should an empty search show recent notes?" | sed -n "s/.*(request \\([^)]*\\)).*/\\1/p"); ted ask --supersedes "$id" --choice "The 5 most recent notes" --choice "A hint" "Empty search: show the 5 most recent notes, or a hint?"',
        ],
      },
      { endTurn: true },
    )
    const runId = await idleLead(client, task)
    const [result] = assistantTexts((await client.getRun(runId)).conversation).map(
      (text) => JSON.parse(text) as { code: number; stdout: string; stderr: string },
    )
    expect(result).toMatchObject({ code: 0 })

    const [first, second] = await comments(client, task)
    expect(second).toMatchObject({
      kind: 'question',
      body: 'Empty search: show the 5 most recent notes, or a hint?',
      choices: ['The 5 most recent notes', 'A hint'],
      author: { kind: 'run', runId },
    })
    expect(second?.answer).toBeUndefined()
    expect(first).toMatchObject({
      kind: 'question',
      body: 'Should an empty search show recent notes?',
      answer: { kind: 'superseded', by: second?.id },
    })
    expect(result?.stdout).toBe(
      `Replaced request ${first?.id} with request ${second?.id}. TED sends you their answer.\n`,
    )
    expect((await inbox(client)).map((item) => item.request.id)).toEqual([second?.id])
  })

  test('only a Run’s own unanswered request on its own Task can be superseded', async () => {
    const client = await start()
    const ask = (question: string) => ({ run: ['ted', 'outcome', 'ask', question] })
    const task = await startTask(
      client,
      ask('First?'),
      ask('Second?'),
      { run: ['ted', 'comment', 'Just a note'] },
      { endTurn: true },
    )
    const other = await startTask(client, ask('Elsewhere?'), { endTurn: true })
    const lead = await asRun(await idleLead(client, task))
    const otherLead = await asRun(await idleLead(client, other))
    const [first, second, note] = await comments(client, task)
    if (!first || !second || !note) throw new Error('missing Comments')
    await client.ok('POST', `/comments/${first.id}/answer`, { action: 'answer', text: 'Yes' })

    const supersede = (as: typeof lead, ref: string, id: string) =>
      as.call('POST', `/tasks/${ref}/comments`, { body: 'Newer?', supersedes: id })

    expect(await supersede(lead, task.id, first.id)).toEqual({
      status: 409,
      body: { error: 'that request has already been answered' },
    })
    expect(await supersede(lead, task.id, note.id)).toEqual({
      status: 400,
      body: { error: 'a note isn’t a request' },
    })
    expect(await supersede(otherLead, other.id, second.id)).toEqual({
      status: 404,
      body: { error: `no request ${second.id} on ${other.displayId}` },
    })
    expect((await supersede(otherLead, task.id, second.id)).status).toBe(403)
    expect(
      await client.call('POST', `/tasks/${task.id}/comments`, {
        body: 'Newer?',
        supersedes: second.id,
      }),
    ).toMatchObject({ status: 403 })

    const after = await comments(client, task)
    expect(after).toHaveLength(3)
    expect(after.find((c) => c.id === second.id)?.answer).toBeUndefined()
  })

  test('a Gate request can’t be superseded', async () => {
    const client = await start('version: 1\norder: [intake, design, work, merge]\n')
    const task = await startTask(
      client,
      {
        everyMessage: [
          { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
          { run: ['ted', 'outcome', 'advance'] },
          { endTurn: true },
        ],
      },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    )
    const review = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.kind === 'review'),
      'the design review',
    )
    const lead = await asRun(await idleLead(client, task))
    expect(
      await lead.call('POST', `/tasks/${task.id}/comments`, {
        body: 'Newer?',
        supersedes: review.id,
      }),
    ).toEqual({
      status: 409,
      body: { error: 'a Gate request can’t be superseded' },
    })
  })
})
