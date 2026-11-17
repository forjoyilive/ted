import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type Comment,
  type Factory,
  movePlanKey,
  type Run,
  readDaemonInfo,
  type Task,
  type TaskMovePlan,
  type ThreadEvent,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  hostsStarted,
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const detachedSleep = (pidFile: string) => ({
  run: [
    process.execPath,
    '-e',
    `const c = require('node:child_process').spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
  ],
})

const sleepIn = (cwd: string) => {
  const child = spawn('sleep', ['300'], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })
  child.unref()
  return child.pid ?? 0
}

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
    const pidFile = path.join(scratch, 'sleep.pid')
    const task = await create(
      client,
      steps(
        detachedSleep(pidFile),
        { waitFor: gate },
        { everyMessage: [{ run: advance }] },
        { run: advance },
      ),
      { start: true },
    )
    const pid = Number(
      await waitUntil(
        () => readFile(pidFile, 'utf8').catch(() => undefined),
        'the detached process',
      ),
    )
    expect(alive(pid)).toBe(true)
    await writeFile(gate, '')
    await waitFor(client, task, (t) => t.stage === 'done', 'to reach Done')
    const folder = path.join(home, 'worktrees', task.displayId)
    await waitUntil(
      () =>
        stat(folder).then(
          () => false,
          () => true,
        ),
      'the worktree folder to go',
    )
    expect(alive(pid)).toBe(false)
    await client.ok('POST', `/tasks/${task.id}/archive`)

    const back = await client.ok<Task>('POST', `/tasks/${task.id}/unarchive`)
    expect(back).toMatchObject({ stage: 'done', runs: [] })
    expect(back.archived).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const later = await getTask(client, task.id)
    expect(later.runs).toEqual([])
    expect(later.repos.every((r) => r.removed)).toBe(true)
    expect(later.statuses).toEqual([])
    await expect(stat(folder)).rejects.toThrow()
  })
})

describe('at start', () => {
  test('ends processes and removes folders left by closed Tasks, and leaves an open Task alone', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const done = await create(client, doneWhen(gate), { start: true })
    await writeFile(gate, '')
    await waitFor(client, done, (t) => t.stage === 'done', 'to reach Done')
    await cleared(client, done)
    const open = await create(client, never(), { start: true })
    await waitFor(client, open, (t) => t.leadRunId !== undefined, 'to start')
    const openFolder = path.join(home, 'worktrees', open.displayId, 'widgets')
    await waitUntil(
      () =>
        stat(openFolder).then(
          () => true,
          () => false,
        ),
      'the open worktree',
    )
    await hostsStarted(home)
    await daemon?.stop()
    daemon = undefined

    const doneFolder = path.join(home, 'worktrees', done.displayId, 'widgets', 'node_modules')
    const goneTask = path.join(home, 'sandbox', 'NB-99', 'tmp')
    await mkdir(doneFolder, { recursive: true })
    await mkdir(goneTask, { recursive: true })
    const leftover = [sleepIn(doneFolder), sleepIn(goneTask)]
    const kept = sleepIn(openFolder)

    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    for (const pid of leftover) await waitUntil(() => !alive(pid), `process ${pid} to end`)
    for (const folder of [
      path.join(home, 'worktrees', done.displayId),
      path.join(home, 'sandbox', 'NB-99'),
    ]) {
      await waitUntil(
        () =>
          stat(folder).then(
            () => false,
            () => true,
          ),
        `${folder} to go`,
      )
    }
    expect(alive(kept)).toBe(true)
    expect((await stat(openFolder)).isDirectory()).toBe(true)
    process.kill(kept, 'SIGKILL')
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
  test('archiving unblocks the Tasks it blocks, whatever an older client asks, and unarchiving puts the blocks back unless the user changed them since', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const waiting = await create(client, 'Waiting', { blockedBy: [blocker.id] })
    const alsoWaiting = await create(client, 'Also waiting', { blockedBy: [blocker.id] })
    const archivedSince = await create(client, 'Archived since', { blockedBy: [blocker.id] })
    const changedByHand = await create(client, 'Changed by hand', { blockedBy: [blocker.id] })

    await client.ok('POST', `/tasks/${blocker.id}/archive`, { blocked: 'keep' })

    const now = await getTask(client, waiting.id)
    expect(now.blockedBy).toEqual([])
    expect(now.markers).toEqual([])

    await client.ok('POST', `/tasks/${archivedSince.id}/archive`)
    await client.ok('POST', `/tasks/${changedByHand.id}/blockers`, { by: blocker.displayId })
    await client.ok('DELETE', `/tasks/${changedByHand.id}/blockers/${blocker.displayId}`)

    await client.ok('POST', `/tasks/${blocker.id}/unarchive`)

    const restored = `You unarchived this Task · ${waiting.displayId} and ${alsoWaiting.displayId} are blocked by it again`
    expect((await getTask(client, waiting.id)).blockedBy).toEqual([blocker.id])
    expect((await getTask(client, alsoWaiting.id)).blockedBy).toEqual([blocker.id])
    expect((await getTask(client, archivedSince.id)).blockedBy).toEqual([])
    expect((await getTask(client, changedByHand.id)).blockedBy).toEqual([])
    expect((await threadTexts(client, blocker)).at(-1)).toBe(restored)

    await client.ok('POST', `/tasks/${archivedSince.id}/unarchive`)
    await client.ok('POST', `/tasks/${blocker.id}/archive`)
    await client.ok('POST', `/tasks/${blocker.id}/unarchive`)
    expect((await getTask(client, archivedSince.id)).blockedBy).toEqual([])
    expect((await threadTexts(client, blocker)).at(-1)).toBe(restored)
  })

  test('deleting unblocks them, whatever an older client asks', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const waiting = await create(client, 'Waiting', { blockedBy: [blocker.id] })

    await client.ok('POST', `/tasks/${blocker.id}/delete`, { blocked: 'keep' })

    expect((await getTask(client, waiting.id)).blockedBy).toEqual([])
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

describe('move to another Factory', () => {
  test('discards the work, keeps the thread and starts a Task Lead in the new Factory with the old conversation', async () => {
    const client = await startTed()
    const otherScratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
    try {
      const otherOrigin = await makeOriginRepo(otherScratch)
      await commitToOrigin(otherScratch, {
        '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
      })
      const gadgets = path.join(otherScratch, 'acme', 'gadgets.git')
      await rename(otherOrigin, gadgets)
      const web = await client.ok<Factory>('POST', '/dev/factories', {
        repo: gadgets,
        key: 'WEB',
      })
      const gate = path.join(scratch, 'gate')
      const blocker = await create(client, 'Earlier')
      const task = await create(client, steps(commitFile('first.txt'), { waitFor: gate }), {
        start: true,
      })
      await client.ok('POST', `/tasks/${task.id}/blockers`, { by: blocker.id })
      const first = await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
      const runId = first.leadRunId ?? ''
      const worktree = path.join(home, 'worktrees', task.displayId, 'widgets')
      await waitUntil(
        () =>
          stat(path.join(worktree, 'first.txt')).then(
            () => true,
            () => false,
          ),
        'the Task Lead to commit',
      )
      await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'A note' })

      const own = await client.ok<TaskMovePlan>(
        'GET',
        `/tasks/${task.id}/move-plan?factory=${first.factoryId}`,
      )
      expect(own.refusal).toBe(`${task.displayId} is already in ${own.factoryName}`)
      const plan = await client.ok<TaskMovePlan>(
        'GET',
        `/tasks/${task.id}/move-plan?factory=${web.id}`,
      )
      expect(plan.refusal).toBeUndefined()
      expect(plan.tasks).toHaveLength(1)
      expect(plan.tasks[0]).toMatchObject({
        id: task.id,
        lands: 'intake',
        startsLead: true,
        worktrees: 1,
        unlinked: [{ id: blocker.id, blocks: true }],
      })
      expect(plan.tasks[0]?.newDisplayId.startsWith('WEB-')).toBe(true)
      const file = api(daemon?.port ?? 0, (await readDaemonInfo(home))?.token ?? '')
      const body = { factoryId: web.id }
      expect((await file.call('POST', `/tasks/${task.id}/move-to-factory`, body)).status).toBe(403)

      const lead = api(
        daemon?.port ?? 0,
        (await loadRunTokens(tedPaths(home).runTokenKey)).issue(runId),
      )
      expect(await lead.call('GET', '/factories/others')).toMatchObject({
        status: 200,
        body: [{ id: web.id, key: 'WEB', name: web.name }],
      })
      expect((await client.call('GET', '/factories/others')).status).toBe(403)
      const askPath = `/tasks/${task.id}/move-request`
      const reason = 'Its code is in acme/gadgets'
      expect((await client.call('POST', askPath, { factory: 'WEB', reason })).status).toBe(403)
      expect((await lead.call('POST', askPath, { factory: 'NOPE', reason })).status).toBe(404)
      expect((await lead.call('POST', askPath, { factory: own.factoryId, reason })).status).toBe(
        409,
      )
      expect((await lead.call('POST', askPath, { factory: 'web', reason })).status).toBe(201)
      expect((await lead.call('POST', askPath, { factory: 'WEB', reason })).status).toBe(409)
      const asked = await waitUntil(
        async () =>
          (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
            (c) => c.move !== undefined,
          ),
        'the move request',
      )
      expect(asked).toMatchObject({
        title: `Move ${task.displayId} to ${web.name}?`,
        choices: ['Move', 'Keep it'],
        move: { factoryId: web.id, reason, askedBy: 'task-lead' },
      })
      const shown = await client.ok<TaskMovePlan>(
        'GET',
        `/tasks/${task.id}/move-plan?factory=${web.id}`,
      )
      expect(movePlanKey(shown)).toBe(movePlanKey(plan))
      await client.ok('POST', `/comments/${asked.id}/answer`, {
        action: 'answer',
        choice: 'Move',
        move: { factoryId: web.id, planKey: movePlanKey(shown) },
      })
      const moved = await waitFor(
        client,
        task,
        (t) => t.leadRunId !== undefined && t.leadRunId !== runId && t.repos.length > 0,
        'to get a Task Lead in the new Factory',
      )
      expect(moved).toMatchObject({
        factoryId: web.id,
        displayId: plan.tasks[0]?.newDisplayId,
        stage: 'intake',
      })
      expect(moved.blockedBy ?? []).not.toContain(blocker.id)
      expect((await client.call('GET', `/runs/${runId}`)).status).toBe(200)
      await expect(stat(worktree)).rejects.toThrow()
      const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
      expect(comments.map((c) => c.body)).toContain('A note')
      const texts = await threadTexts(client, moved)
      const line = `You moved this Task from ${task.displayId} in ${own.factoryName} to ${web.name} · a fresh Task Lead Run starts from the brief`
      expect(texts).toContain(line)
      const byOldId = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.displayId}/events`)
      expect(byOldId.map((e) => e.text)).toContain(line)
      const { run: fresh } = await client.ok<{ run: Run }>('GET', `/runs/${moved.leadRunId}`)
      expect(fresh.prompt).toContain('Picking up after a move to another Factory')
      expect(fresh.prompt).toContain(
        `The previous Task Lead asked for the move and the user approved it. The reason given: “${reason}”`,
      )
      expect(fresh.prompt).toContain('## The conversation so far')
      await writeFile(gate, '')
    } finally {
      await rm(otherScratch, { recursive: true, force: true })
    }
  }, 90_000)
})
