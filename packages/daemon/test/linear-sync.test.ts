import { writeFile } from 'node:fs/promises'
import type { InboxItem, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { stubKeyring, stubKeyringFile } from './fixtures/stub-keyring.ts'
import {
  type StubLinear,
  type StubLinearIssue,
  startStubLinear,
  stubLinearStates,
} from './fixtures/stub-linear.ts'
import { waitUntil } from './helpers.ts'
import {
  approve,
  type Client,
  ctx,
  getTask,
  lines,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'

useMergeHarness()

const key = 'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
const url = 'https://linear.app/kriyadesign/issue/NOTE-1/offline-notes'
let linear: StubLinear

beforeEach(async () => {
  linear = await startStubLinear({
    [key]: {
      name: 'Nabha',
      workspace: { name: 'Kriya Design', urlKey: 'kriyadesign' },
      issues: [{ identifier: 'NOTE-1', title: 'Offline notes', state: 'Todo' }],
    },
  })
})

afterEach(async () => {
  await linear.close()
})

const account = () => {
  const found = linear.accounts.get(key)
  if (!found) throw new Error('no stub account')
  return found
}

const issue = (): StubLinearIssue => {
  const found = account().issues?.find((i) => i.identifier === 'NOTE-1')
  if (!found) throw new Error('no NOTE-1')
  return found
}

const asked = (name: string) => linear.requests.filter((r) => r.query.includes(name))

const moves = () => asked('TedMoveIssue').map((r) => (r.variables as { stateId: string }).stateId)

async function startWithLinear(
  options: Parameters<typeof start>[0] & { withKey?: boolean } = {},
): Promise<Client> {
  const { withKey = true, ...rest } = options
  await writeFile(stubKeyringFile(ctx.home), JSON.stringify(withKey ? { secret: key } : {}))
  return start({
    ...rest,
    daemon: {
      linear: { apiUrl: linear.url, keyring: stubKeyring(stubKeyringFile(ctx.home)) },
      linearSyncMs: 50,
      ...rest.daemon,
    },
  })
}

async function seenAfterNow(): Promise<void> {
  const before = asked('TedIssueStates').length
  await waitUntil(() => asked('TedIssueStates').length > before + 1, 'Linear to be read twice')
}

const waiting = (steps: string) =>
  JSON.stringify({ steps: [{ waitFor: `${steps}/never` }, { endTurn: true }] })

const mergeOff = ['stages:', '  merge: { enabled: false }']

describe('TED → Linear', () => {
  test('the issue moves to In Progress, gets the pull request once, In Review at sign-off, and Done when merged', async () => {
    const client = await startWithLinear({ workflow: mergeOff })

    const { task, signoff } = await toSignoff(client, { source: url })
    await waitUntil(() => issue().state === 'In Progress' || undefined, 'In Progress')
    const pr = (await getTask(client, task.id)).repos[0]?.pullRequest
    await waitUntil(() => (account().attachments?.length ?? 0) > 0, 'the pull request link')
    await approve(client, signoff)
    await waitUntil(() => issue().state === 'In Review' || undefined, 'In Review')
    await seenAfterNow()
    await setGh({ merged: true })
    await waitForStage(client, task, 'done')
    await waitUntil(() => issue().state === 'Done' || undefined, 'Done')
    await waitUntil(
      async () => (await lines(client, task)).includes('Moved NOTE-1 to Done in Linear'),
      'the Done line',
    )

    expect(moves()).toEqual(['state-progress', 'state-review', 'state-done'])
    expect(account().attachments).toEqual([
      { issue: 'NOTE-1', url: pr?.url, title: expect.stringContaining(`#${pr?.number}`) },
    ])
    expect(asked('TedLinkPullRequest').every((r) => r.authorization === key)).toBe(true)
    const thread = await lines(client, task)
    expect(thread).toContain('Moved NOTE-1 to In Progress in Linear')
    expect(thread).toContain('Linked the pull request in NOTE-1 in Linear')
    expect(thread).toContain('Moved NOTE-1 to In Review in Linear')
    expect(thread).toContain('Moved NOTE-1 to Done in Linear')
  })

  test('a team without a review state stays where it is at sign-off', async () => {
    account().states = stubLinearStates.filter((s) => s.name !== 'In Review')
    const client = await startWithLinear({ workflow: mergeOff })

    const { task, signoff } = await toSignoff(client, { source: url })
    await waitUntil(() => issue().state === 'In Progress' || undefined, 'In Progress')
    await approve(client, signoff)
    await waitForStage(client, task, 'merge')
    await seenAfterNow()
    expect(issue().state).toBe('In Progress')

    await setGh({ merged: true })
    await waitUntil(() => issue().state === 'Done' || undefined, 'Done')
    expect(moves()).toEqual(['state-progress', 'state-done'])
  })

  test('an issue already further along isn’t moved back', async () => {
    issue().state = 'In Review'
    const client = await startWithLinear()

    const task = await client.ok<Task>('POST', '/tasks', {
      title: waiting(ctx.scratch),
      factory: 'NB',
      source: url,
      start: true,
    })
    await waitUntil(async () => (await getTask(client, task.id)).leadRunId, 'the Task Lead')
    await seenAfterNow()

    expect(moves()).toEqual([])
    expect(issue().state).toBe('In Review')
  })

  test('with sync off or no key, TED doesn’t touch Linear', async () => {
    const client = await startWithLinear()
    await client.ok('PATCH', '/settings', { linearSync: false })
    const task = await client.ok<Task>('POST', '/tasks', {
      title: waiting(ctx.scratch),
      factory: 'NB',
      source: url,
      start: true,
    })
    await waitUntil(async () => (await getTask(client, task.id)).leadRunId, 'the Task Lead')
    const before = linear.requests.length
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(linear.requests.slice(before)).toEqual([])
    expect(asked('TedIssueStates')).toEqual([])
    expect(issue().state).toBe('Todo')
  })

  test('without a key, the sync makes no request', async () => {
    const client = await startWithLinear({ withKey: false })
    const task = await client.ok<Task>('POST', '/tasks', {
      title: waiting(ctx.scratch),
      factory: 'NB',
      source: url,
      start: true,
    })
    await waitUntil(async () => (await getTask(client, task.id)).leadRunId, 'the Task Lead')
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(linear.requests).toEqual([])
  })
})

describe('Linear → TED', () => {
  test('a canceled issue archives a Task that hasn’t started, saying why', async () => {
    const client = await startWithLinear()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: 'Offline notes',
      factory: 'NB',
      source: url,
    })
    await seenAfterNow()

    issue().state = 'Canceled'
    const archived = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.archived ? current : undefined
    }, 'the Task to be archived')

    expect(archived.stage).toBe('backlog')
    expect(await lines(client, task)).toContain(
      'TED archived this Task · NOTE-1 was marked Canceled in Linear',
    )
    expect(moves()).toEqual([])
  })

  test('a Task with a live Run asks the human once; Keep going keeps it, Archive archives it', async () => {
    const client = await startWithLinear()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: waiting(ctx.scratch),
      factory: 'NB',
      source: url,
      start: true,
    })
    await waitUntil(() => issue().state === 'In Progress' || undefined, 'In Progress')
    await seenAfterNow()

    issue().state = 'Done'
    const question = await waitUntil(async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      return items.find((i) => i.task.id === task.id && i.request.kind === 'question')
    }, 'the question')
    await seenAfterNow()

    expect(question.request).toMatchObject({
      author: { kind: 'ted' },
      title: 'NOTE-1 was marked Done in Linear',
      choices: ['Archive', 'Keep going'],
    })
    const open = (await client.ok<InboxItem[]>('GET', '/inbox')).filter(
      (i) => i.task.id === task.id,
    )
    expect(open).toHaveLength(1)
    const current = await getTask(client, task.id)
    expect(current.archived).toBeUndefined()
    expect(current.leadRunId).toBeDefined()

    await client.ok('POST', `/comments/${question.request.id}/answer`, {
      action: 'answer',
      choice: 'Keep going',
    })
    await seenAfterNow()
    expect((await getTask(client, task.id)).archived).toBeUndefined()
    expect(
      (await client.ok<InboxItem[]>('GET', '/inbox')).filter((i) => i.task.id === task.id),
    ).toEqual([])

    issue().state = 'In Progress'
    await seenAfterNow()
    issue().state = 'Canceled'
    const again = await waitUntil(async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      return items.find((i) => i.task.id === task.id && i.request.kind === 'question')
    }, 'the second question')
    await client.ok('POST', `/comments/${again.request.id}/answer`, {
      action: 'answer',
      choice: 'Archive',
    })
    await waitUntil(
      async () => (await getTask(client, task.id)).archived !== undefined,
      'the Task to be archived',
    )
  })

  test('a reopened issue withdraws the open question', async () => {
    const client = await startWithLinear()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: waiting(ctx.scratch),
      factory: 'NB',
      source: url,
      start: true,
    })
    await waitUntil(() => issue().state === 'In Progress' || undefined, 'In Progress')
    await seenAfterNow()
    issue().state = 'Canceled'
    await waitUntil(async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      return items.find((i) => i.task.id === task.id)
    }, 'the question')

    issue().state = 'Todo'
    await waitUntil(
      async () =>
        (await client.ok<InboxItem[]>('GET', '/inbox')).every((i) => i.task.id !== task.id),
      'the question to be withdrawn',
    )
    expect((await getTask(client, task.id)).archived).toBeUndefined()
  })
})
