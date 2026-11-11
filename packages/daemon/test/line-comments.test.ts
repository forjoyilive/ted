import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Comment, Factory, InboxItem, LineComment, Run, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

const execFileAsync = promisify(execFile)
let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-line-comments-'))
  origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.gitignore': 'stub-*\n',
    'app.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n',
  })
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home, { waitForStart: true })
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed(workflow?: string) {
  if (workflow !== undefined) await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
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

async function startedTask(
  client: Client,
  title = steps({ endTurn: true }),
): Promise<{ task: Task; worktree: string }> {
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  const worktree = await waitUntil(async () => {
    const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return current?.repos[0]?.worktree
  }, 'the worktree')
  return { task, worktree }
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })

const edited =
  'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\n'

async function changeApp(worktree: string) {
  await writeFile(path.join(worktree, 'app.txt'), edited)
  await gitIn(worktree, 'commit', '-qam', 'edit app')
}

const drafts = async (client: Client, task: Task) =>
  (await client.ok<LineComment[]>('GET', `/tasks/${task.id}/line-comments`)).filter(
    (c) => c.sent === undefined,
  )

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const leadRun = async (client: Client, task: Task): Promise<Run> => {
  const { leadRunId } = await getTask(client, task.id)
  if (!leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return (await client.getRun(leadRunId)).run
}

const userMessages = async (client: Client, task: Task) =>
  (await client.getRun((await leadRun(client, task)).id)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const waitForIdle = async (client: Client, task: Task) => {
  const run = await leadRun(client, task)
  await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle')
}

describe('drafting', () => {
  test('single-line and range drafts quote the lines and the commit, and survive a restart', async () => {
    const client = await startTed()
    const { task, worktree } = await startedTask(client)
    await changeApp(worktree)
    const head = (await gitIn(worktree, 'rev-parse', 'HEAD')).stdout.trim()

    const single = await client.ok<LineComment>('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { new: 5 },
      body: '  Keep it lower case.  ',
    })
    const range = await client.ok<LineComment>('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { old: 5 },
      to: { new: 6 },
      body: 'Why both?',
    })

    expect(single).toMatchObject({
      taskId: task.id,
      repo: 'widgets',
      path: 'app.txt',
      side: 'new',
      start: 5,
      end: 5,
      commit: head,
      quoted: [{ kind: 'added', text: 'FIVE', new: 5 }],
      body: 'Keep it lower case.',
    })
    expect(range).toMatchObject({ side: 'new', start: 5, end: 6 })
    expect(range.quoted.map((r) => r.kind)).toEqual(['removed', 'added', 'context'])

    await daemon?.stop()
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    const again = api(daemon.port, { appKey: daemon.appToken })
    const listed = await again.call('GET', `/tasks/${task.id}/line-comments`)
    expect((listed.body as LineComment[]).map((c) => c.body)).toEqual([
      'Keep it lower case.',
      'Why both?',
    ])
  })

  test('drafts must point at lines in the diff and need text; Runs can’t write them', async () => {
    const client = await startTed()
    const { task, worktree } = await startedTask(client)
    await changeApp(worktree)
    const draft = (body: Record<string, unknown>) =>
      client.call('POST', `/tasks/${task.id}/line-comments`, {
        repo: 'widgets',
        path: 'app.txt',
        body: 'x',
        ...body,
      })

    expect((await draft({ from: { new: 1 } })).status).toBe(409)
    expect((await draft({ from: { new: 5 }, body: '  ' })).status).toBe(400)
    expect((await draft({ from: { new: 5 }, to: { new: 99 } })).status).toBe(400)
    expect((await draft({ from: { new: 5 }, path: 'missing.txt' })).status).toBe(409)
    expect((await draft({ from: {} })).status).toBe(400)
    const fileToken = api(daemon?.port ?? 0, await tokenFor(home))
    const asFile = await fileToken.call('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { new: 5 },
      body: 'x',
    })
    expect(asFile.status).toBe(403)
  })

  test('drafts can be edited and deleted until they’re sent; Discard all removes the rest', async () => {
    const client = await startTed()
    const { task, worktree } = await startedTask(client)
    await changeApp(worktree)
    const post = (body: string) =>
      client.ok<LineComment>('POST', `/tasks/${task.id}/line-comments`, {
        repo: 'widgets',
        path: 'app.txt',
        from: { new: 5 },
        body,
      })
    const first = await post('First')
    const second = await post('Second')
    await post('Third')

    const changed = await client.ok<LineComment>('PATCH', `/line-comments/${first.id}`, {
      body: 'First, edited',
    })
    await client.ok('DELETE', `/line-comments/${second.id}`)

    expect(changed.body).toBe('First, edited')
    expect(changed.editedAt).toBeDefined()
    expect((await drafts(client, task)).map((c) => c.body)).toEqual(['First, edited', 'Third'])
    await client.ok('DELETE', `/tasks/${task.id}/line-comments`)
    expect(await drafts(client, task)).toEqual([])
  })
})

describe('sending', () => {
  test('the next Comment carries the drafts to the Task Lead with path, range, commit, quote and text', async () => {
    const client = await startTed()
    const { task, worktree } = await startedTask(client)
    await changeApp(worktree)
    await waitForIdle(client, task)
    const head = (await gitIn(worktree, 'rev-parse', 'HEAD')).stdout.trim()
    const draft = await client.ok<LineComment>('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { old: 5 },
      to: { new: 5 },
      body: 'Keep it lower case.',
    })

    const comment = await client.ok<Comment>('POST', `/tasks/${task.id}/comments`, {
      body: `Looks close.\n${steps({ endTurn: true })}`,
    })

    expect(comment.lineComments?.map((c) => c.id)).toEqual([draft.id])
    expect(comment.lineComments?.[0]?.sent?.commentId).toBe(comment.id)
    expect(await drafts(client, task)).toEqual([])
    const message = await waitUntil(
      async () => (await userMessages(client, task)).find((m) => m.includes('Looks close.')),
      'the Comment to reach the Task Lead',
    )
    expect(message).toContain('Line comments (1):')
    expect(message).toContain(`1. app.txt line 5, repo widgets, commit ${head}`)
    expect(message).toContain('```diff\n-five\n+FIVE\n```')
    expect(message).toContain('Keep it lower case.')
  })

  test('Send to Task Lead posts the drafts as one Comment; with none it refuses', async () => {
    const client = await startTed()
    const { task, worktree } = await startedTask(client)
    await changeApp(worktree)
    await client.ok('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { new: 5 },
      body: 'One',
    })
    await client.ok('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { new: 13 },
      body: 'Two',
    })

    const sent = await client.ok<Comment>('POST', `/tasks/${task.id}/line-comments/send`)

    expect(sent).toMatchObject({ kind: 'note', body: '', author: { kind: 'human' } })
    expect(sent.lineComments?.map((c) => c.body)).toEqual(['One', 'Two'])
    const again = await client.call('POST', `/tasks/${task.id}/line-comments/send`)
    expect(again.status).toBe(409)
    const late = await client.call('PATCH', `/line-comments/${sent.lineComments?.[0]?.id}`, {
      body: 'changed',
    })
    expect(late.status).toBe(409)
  })

  test('a sent line comment whose lines changed since shows Outdated', async () => {
    const client = await startTed()
    const { task, worktree } = await startedTask(client)
    await changeApp(worktree)
    for (const line of [5, 13]) {
      await client.ok('POST', `/tasks/${task.id}/line-comments`, {
        repo: 'widgets',
        path: 'app.txt',
        from: { new: line },
        body: `About ${line}`,
      })
    }
    await client.ok('POST', `/tasks/${task.id}/line-comments/send`)

    await writeFile(path.join(worktree, 'app.txt'), edited.replace('FIVE', 'Five'))

    const listed = await client.ok<LineComment[]>('GET', `/tasks/${task.id}/line-comments`)
    expect(listed.map((c) => [c.body, c.outdated ?? false])).toEqual([
      ['About 5', true],
      ['About 13', false],
    ])
  })
})

test('a line comment on a file with CRLF line endings isn’t outdated until its line changes', async () => {
  const client = await startTed()
  const { task, worktree } = await startedTask(client)
  await writeFile(path.join(worktree, 'win.txt'), 'alpha\r\nbeta\r\n')
  await client.ok('POST', `/tasks/${task.id}/line-comments`, {
    repo: 'widgets',
    path: 'win.txt',
    from: { new: 2 },
    body: 'Rename beta.',
  })

  const before = await client.ok<LineComment[]>('GET', `/tasks/${task.id}/line-comments`)
  await writeFile(path.join(worktree, 'win.txt'), 'alpha\r\ngamma\r\n')
  const after = await client.ok<LineComment[]>('GET', `/tasks/${task.id}/line-comments`)

  expect(before[0]?.outdated).toBeUndefined()
  expect(after[0]?.outdated).toBe(true)
})

describe('at a Gate', () => {
  const workflow = 'version: 1\norder: [intake, design, work, merge]\n'
  const gateTask = async (client: Client) => {
    const briefFile = path.join(scratch, 'brief.md')
    await writeFile(
      briefFile,
      ['Goal', 'Decisions so far', 'Current state', 'Open questions', 'Next step']
        .map((heading) => `## ${heading}\n\nLower-case words.\n`)
        .join('\n'),
    )
    const { task, worktree } = await startedTask(
      client,
      steps(
        {
          everyMessage: [
            { run: ['ted', 'brief', 'write', '--file', briefFile] },
            { run: ['ted', 'outcome', 'advance'] },
            { endTurn: true },
          ],
        },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ),
    )
    const { request } = await waitUntil(
      async () => (await client.ok<InboxItem[]>('GET', '/inbox')).at(0),
      'a design review',
    )
    await waitForIdle(client, task)
    await changeApp(worktree)
    await client.ok('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { new: 5 },
      body: 'Lower case, please.',
    })
    return { task, request }
  }

  test('Approve never sends the drafts', async () => {
    const client = await startTed(workflow)
    const { task, request } = await gateTask(client)

    const answered = await client.ok<Comment>('POST', `/comments/${request.id}/answer`, {
      action: 'approve',
    })

    expect(answered.lineComments).toBeUndefined()
    expect((await drafts(client, task)).map((c) => c.body)).toEqual(['Lower case, please.'])
  })

  test('Request changes carries the drafts', async () => {
    const client = await startTed(workflow)
    const { task, request } = await gateTask(client)

    const answered = await client.ok<Comment>('POST', `/comments/${request.id}/answer`, {
      action: 'request-changes',
      text: 'Tighten it up.',
    })

    expect(answered.lineComments?.map((c) => c.body)).toEqual(['Lower case, please.'])
    expect(await drafts(client, task)).toEqual([])
    const message = await waitUntil(
      async () => (await userMessages(client, task)).find((m) => m.includes('Tighten it up.')),
      'the request to reach the Task Lead',
    )
    expect(message).toContain('Line comments (1):')
    expect(message).toContain('Lower case, please.')
  })
})

test('after Done, the drafts go with a Follow up, not with Comment only', async () => {
  const client = await startTed('version: 1\norder: [intake, work, merge]\n')
  const gate = path.join(scratch, 'gate')
  const advance = ['ted', 'outcome', 'advance']
  const { task, worktree } = await startedTask(
    client,
    steps(
      { run: ['sh', '-c', 'printf "Goal: lower-case words\\n" | ted brief write'] },
      { waitFor: gate },
      { everyMessage: [{ run: advance }] },
      { run: advance },
    ),
  )
  await writeFile(path.join(worktree, 'app.txt'), edited)
  await client.ok('POST', `/tasks/${task.id}/line-comments`, {
    repo: 'widgets',
    path: 'app.txt',
    from: { new: 5 },
    body: 'Lower case, please.',
  })
  await writeFile(gate, '')
  await waitUntil(
    async () => {
      const current = await getTask(client, task.id)
      return current.stage === 'done' && current.repos.every((r) => r.removed)
    },
    'the Task to reach Done',
    20_000,
  )

  const only = await client.ok<Comment>('POST', `/tasks/${task.id}/comments`, { body: 'Thanks' })
  expect(only.lineComments).toBeUndefined()
  const refused = await client.call('POST', `/tasks/${task.id}/line-comments/send`)
  expect(refused.status).toBe(409)

  const followUp = await client.ok<Task>('POST', `/tasks/${task.id}/follow-up`, {
    comment: 'One more pass',
  })

  const carried = (await client.ok<Comment[]>('GET', `/tasks/${followUp.id}/comments`)).find(
    (c) => c.lineComments !== undefined,
  )
  expect(carried?.lineComments?.map((c) => c.body)).toEqual(['Lower case, please.'])
  expect(await drafts(client, task)).toEqual([])
})
