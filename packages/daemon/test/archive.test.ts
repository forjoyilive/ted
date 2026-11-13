import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type Comment,
  type Factory,
  readDaemonInfo,
  type Task,
  type ThreadEvent,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  storeDbFiles,
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
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
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const advance = ['ted', 'outcome', 'advance']
const doneWhen = (gate: string) =>
  steps({ waitFor: gate }, { everyMessage: [{ run: advance }] }, { run: advance })
const never = () => steps({ waitFor: path.join(scratch, 'never') })

const create = (client: Client, title: string, extra: Record<string, unknown> = {}) =>
  client.ok<Task>('POST', '/tasks', { title, factory: 'NB', ...extra })

const find = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const getTask = async (client: Client, id: string) => {
  const task = await find(client, id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const waitFor = (client: Client, task: Task, check: (t: Task) => boolean, what: string) =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return check(current) ? current : undefined
  }, `${task.displayId} ${what}`)

const cleared = (client: Client, task: Task) =>
  waitFor(
    client,
    task,
    (t) => t.runs.length === 0 && t.repos.length > 0 && t.repos.every((r) => r.removed),
    'to have its Runs stopped and worktree removed',
  )

const threadTexts = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)

const commitFile = (name: string) => ({
  run: [
    'sh',
    '-c',
    `echo kept > ${name} && git add ${name} && git -c user.name=TED -c user.email=ted@example.com commit -qm ${name}`,
  ],
})

describe('unarchive', () => {
  test('a Backlog Task goes back to Backlog with nothing running', async () => {
    const client = await startTed()
    const task = await create(client, 'Idea')
    await client.ok('POST', `/tasks/${task.id}/archive`)

    const back = await client.ok<Task>('POST', `/tasks/${task.id}/unarchive`)

    expect(back.archived).toBeUndefined()
    expect(back.stage).toBe('backlog')
    expect(back.leadRunId).toBeUndefined()
    expect(await threadTexts(client, task)).toEqual([
      'You created this Task',
      'You archived this Task',
      'You unarchived this Task',
    ])
    expect((await client.call('POST', `/tasks/${task.id}/unarchive`)).status).toBe(409)
  })

  test('a Task mid-flow gets its worktree back from its branch and a fresh Task Lead Run', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const task = await create(client, steps(commitFile('first.txt'), { waitFor: gate }), {
      start: true,
    })
    const first = await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
    const worktree = path.join(home, 'worktrees', task.displayId, 'widgets')
    await waitUntil(
      () =>
        stat(path.join(worktree, 'first.txt')).then(
          () => true,
          () => false,
        ),
      'the Task Lead to commit',
    )
    const branch = first.repos[0]?.branch

    await client.ok('POST', `/tasks/${task.id}/archive`)
    await cleared(client, task)
    await expect(stat(worktree)).rejects.toThrow()

    await client.ok('POST', `/tasks/${task.id}/unarchive`)

    const fresh = await waitFor(
      client,
      task,
      (t) => t.leadRunId !== undefined && t.leadRunId !== first.leadRunId,
      'to get a fresh Run',
    )
    expect(fresh.archived).toBeUndefined()
    expect(fresh.stage).toBe(first.stage)
    expect(fresh.repos).toHaveLength(1)
    expect(fresh.repos[0]).toMatchObject({ branch, worktree })
    expect(fresh.repos[0]?.removed).toBeUndefined()
    expect(await readFile(path.join(worktree, 'first.txt'), 'utf8')).toBe('kept\n')
    const { prompt } = (await client.getRun(fresh.leadRunId ?? '')).run as { prompt?: string }
    expect(prompt).toContain('# Picking up after unarchiving')
    await writeFile(gate, '')
  })

  test('a Done Task goes back to Done with no Run and no worktree', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const task = await create(client, doneWhen(gate), { start: true })
    await writeFile(gate, '')
    await waitFor(client, task, (t) => t.stage === 'done', 'to reach Done')
    await client.ok('POST', `/tasks/${task.id}/archive`)

    const back = await client.ok<Task>('POST', `/tasks/${task.id}/unarchive`)
    expect(back).toMatchObject({ stage: 'done', runs: [] })
    expect(back.archived).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const later = await getTask(client, task.id)
    expect(later.runs).toEqual([])
    expect(later.repos.every((r) => r.removed)).toBe(true)
    expect(later.statuses).toEqual([])
  })
})

describe('the archived Task', () => {
  test('is read-only: its comment box says so and Comments are refused', async () => {
    const client = await startTed()
    const task = await create(client, 'Idea')
    const archived = await client.ok<Task>('POST', `/tasks/${task.id}/archive`)

    expect(archived.commentBox).toBe('archived')
    const refused = await client.call('POST', `/tasks/${task.id}/comments`, { body: 'Hello' })
    expect(refused.status).toBe(409)
  })

  test('its thread line names the pull requests it closed and the branches it kept', async () => {
    const client = await startTed()
    const task = await create(client, never(), { start: true })
    await waitFor(client, task, (t) => t.repos.length > 0, 'to get a worktree')

    await client.ok('POST', `/tasks/${task.id}/archive`)
    await cleared(client, task)

    const texts = await threadTexts(client, task)
    expect(texts.find((t) => t.startsWith('You archived'))).toBe(
      'You archived this Task · kept the branch',
    )
  })
})

describe('blocking others', () => {
  test('archiving unblocks the Tasks it blocks by default', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const waiting = await create(client, 'Waiting', { blockedBy: [blocker.id] })

    await client.ok('POST', `/tasks/${blocker.id}/archive`)

    const now = await getTask(client, waiting.id)
    expect(now.blockedBy).toEqual([])
    expect(now.markers).toEqual([])
  })

  test('archiving can keep them blocked, and the link says the blocker is archived', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const waiting = await create(client, 'Waiting', { blockedBy: [blocker.id] })

    await client.ok('POST', `/tasks/${blocker.id}/archive`, { blocked: 'keep' })

    const now = await getTask(client, waiting.id)
    expect(now.blockedBy).toEqual([blocker.id])
    expect(now.markers).toEqual([{ kind: 'blocked-by', by: 'NB-1', ended: 'archived' }])
    expect(now.activity).toBe('Blocked by archived NB-1')
  })

  test('deleting can keep them blocked, and the link still names the deleted Task', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const waiting = await create(client, 'Waiting', { blockedBy: [blocker.id] })

    await client.ok('POST', `/tasks/${blocker.id}/delete`, { blocked: 'keep' })

    const now = await getTask(client, waiting.id)
    expect(now.markers).toEqual([{ kind: 'blocked-by', by: 'NB-1', ended: 'deleted' }])
    expect(now.activity).toBe('Blocked by deleted NB-1')
    expect((await client.call('POST', `/tasks/${waiting.id}/start`)).body).toMatchObject({
      stage: 'backlog',
    })

    const removed = await client.call('DELETE', `/tasks/${waiting.id}/blockers/${blocker.id}`)
    expect(removed.status).toBe(200)
    expect((await getTask(client, waiting.id)).blockedBy).toEqual([])
  })

  test('deleting unblocks them by default', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const waiting = await create(client, 'Waiting', { blockedBy: [blocker.id] })

    await client.ok('POST', `/tasks/${blocker.id}/delete`)

    expect((await getTask(client, waiting.id)).blockedBy).toEqual([])
  })

  test('a blocked choice other than unblock or keep is refused', async () => {
    const client = await startTed()
    const task = await create(client, 'A')
    const res = await client.call('POST', `/tasks/${task.id}/archive`, { blocked: 'maybe' })
    expect(res.status).toBe(400)
  })
})

describe('delete', () => {
  test('removes the Task and its files from disk, and its events stay in the log', async () => {
    const client = await startTed()
    const task = await create(
      client,
      steps({ say: 'hello' }, { waitFor: path.join(scratch, 'x') }),
      {
        start: true,
      },
    )
    const started = await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
    const runId = started.leadRunId ?? ''
    await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'A note' })
    const runDir = path.join(home, 'runs', runId)
    expect((await stat(runDir)).isDirectory()).toBe(true)
    const worktree = path.join(home, 'worktrees', task.displayId)

    const res = await client.call('POST', `/tasks/${task.id}/delete`)
    expect(res.status).toBe(200)

    expect(await find(client, task.id)).toBeUndefined()
    expect((await client.call('GET', `/tasks/${task.id}/comments`)).status).toBe(404)
    expect((await client.call('GET', `/runs/${runId}`)).status).toBe(404)
    await expect(stat(runDir)).rejects.toThrow()
    await expect(stat(worktree)).rejects.toThrow()
    const logs = await readdir(path.join(home, 'logs'), { recursive: true }).catch(() => [])
    expect(logs.filter((f) => String(f).includes(`${task.displayId}-`))).toEqual([])

    const dir = path.join(home, 'store', 'ted')
    const file = (await storeDbFiles(dir)).find((f) => f.startsWith('eventlog'))
    const db = new DatabaseSync(path.join(dir, file ?? ''))
    const names = db
      .prepare('SELECT name FROM eventlog WHERE argsJson LIKE ?')
      .all(`%${task.id}%`)
      .map((row) => String(row.name))
    db.close()
    expect(names).toContain('v1.TaskDeleted')
    expect(names.some((n) => n.endsWith('.TaskCreated'))).toBe(true)
  })

  test('removes an archived Task, and its number isn’t used again', async () => {
    const client = await startTed()
    await create(client, 'One')
    const two = await create(client, 'Two')
    await client.ok('POST', `/tasks/${two.id}/archive`)

    await client.ok('POST', `/tasks/${two.id}/delete`)
    const three = await create(client, 'Three')

    expect(three.displayId).toBe('NB-3')
    expect((await client.call('POST', `/tasks/${two.id}/delete`)).status).toBe(404)
  })
})

describe('reset', () => {
  test('discards the worktree, branch, thread and Runs, then starts the same Task again from its original request', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const blocker = await create(client, 'Earlier')
    await client.ok('POST', `/tasks/${blocker.id}/archive`)
    const task = await create(client, steps(commitFile('first.txt'), { waitFor: gate }), {
      description: 'The original request',
      priority: 'high',
      start: true,
    })
    const first = await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
    const worktree = path.join(home, 'worktrees', task.displayId, 'widgets')
    const committed = () =>
      waitUntil(
        () =>
          stat(path.join(worktree, 'first.txt')).then(
            () => true,
            () => false,
          ),
        'the Task Lead to commit',
      )
    await committed()
    const started = await getTask(client, task.id)
    const branch = started.repos[0]?.branch
    const runId = first.leadRunId ?? ''
    const runDir = path.join(home, 'runs', runId)
    await writeFile(path.join(worktree, 'stray.txt'), 'uncommitted')
    await client.ok('PUT', `/tasks/${task.id}`, { description: 'An edited request' })
    await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'A note' })

    const file = api(daemon?.port ?? 0, (await readDaemonInfo(home))?.token ?? '')
    expect((await file.call('POST', `/tasks/${task.id}/reset`)).status).toBe(403)
    expect((await client.call('POST', `/tasks/${blocker.id}/reset`)).status).toBe(409)
    const idea = await create(client, 'Idea')
    expect((await client.call('POST', `/tasks/${idea.id}/reset`)).status).toBe(409)

    await client.ok('POST', `/tasks/${task.id}/reset`)

    const fresh = await waitFor(
      client,
      task,
      (t) => t.leadRunId !== undefined && t.leadRunId !== runId && t.repos.length > 0,
      'to get a fresh Run after the reset',
    )
    expect(fresh).toMatchObject({
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      description: 'The original request',
      priority: 'high',
      rank: started.rank,
      stage: 'intake',
    })
    expect(fresh.runs.map((r) => r.id)).toEqual([fresh.leadRunId])
    expect(fresh.repos[0]).toMatchObject({ branch, worktree })
    expect(fresh.repos[0]?.removed).toBeUndefined()
    await committed()
    await expect(stat(path.join(worktree, 'stray.txt'))).rejects.toThrow()
    await expect(stat(runDir)).rejects.toThrow()
    expect((await client.call('GET', `/runs/${runId}`)).status).toBe(404)
    expect(await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).toEqual([])
    const texts = await threadTexts(client, task)
    expect(texts[0]).toBe('Task was reset')
    expect(texts).not.toContain('You created this Task')
    const versions = await client.ok<{ text: string }[]>('GET', `/tasks/${task.id}/descriptions`)
    expect(versions.map((v) => v.text)).toEqual(['The original request'])
    await writeFile(gate, '')
  })
})
