import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Comment, Factory, Run, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
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
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  await makeOriginRepo(scratch)
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
  const client = api(daemon.port, daemon.appToken)
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', {
    repo: path.join(scratch, 'acme', 'widgets.git'),
    key: 'NB',
  })
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const worktreeFile = (name: string) => path.join(home, 'worktrees', 'NB-1', 'widgets', name)

const jsonLines = async <T>(name: string): Promise<T[]> =>
  (await readFile(worktreeFile(name), 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as T)

const claudeStarts = () => jsonLines<{ argv: string[] }>('stub-starts.jsonl')

const codexRequests = () =>
  jsonLines<{ method?: string; params?: Record<string, unknown> }>('stub-requests.jsonl')

const flag = (argv: string[], name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const leadRun = async (client: Client, task: Task): Promise<Run> => {
  const current = await getTask(client, task.id)
  if (!current?.leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return (await client.getRun(current.leadRunId)).run
}

const waitForRun = (client: Client, task: Task, check: (run: Run) => boolean, what: string) =>
  waitUntil(async () => {
    const run = await leadRun(client, task).catch(() => undefined)
    return run && check(run) ? run : undefined
  }, what)

const userMessages = async (client: Client, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

describe('lead from workflow.yaml', () => {
  test('each layer’s lead reaches a Claude Code Run as --model and --effort', async () => {
    await mkdir(path.join(home, 'library'), { recursive: true })
    await writeFile(
      path.join(home, 'library', 'workflow.yaml'),
      'version: 1\nlead: { model: sonnet, effort: low }\n',
    )
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nlead: { agent: claude, effort: high }\n',
    })
    const client = await startTed()

    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    expect(task.lead).toEqual({ agent: 'claude', model: 'sonnet', effort: 'high' })

    await client.ok('POST', `/tasks/${task.id}/start`)
    const [start] = await waitUntil(async () => {
      const starts = await claudeStarts()
      return starts.length > 0 ? starts : undefined
    }, 'the Task Lead to start')
    expect(flag(start?.argv ?? [], '--model')).toBe('sonnet')
    expect(flag(start?.argv ?? [], '--effort')).toBe('high')
    expect(await leadRun(client, task)).toMatchObject({
      agent: 'claude',
      model: 'sonnet',
      effort: 'high',
    })
  })

  test('a Codex lead gets the model on its thread and the effort, clamped to the model’s, on each turn', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nlead: { agent: codex, model: gpt-6-mini, effort: max }\n',
    })
    const client = await startTed()

    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)

    const turn = await waitUntil(
      async () => (await codexRequests()).find((r) => r.method === 'turn/start'),
      'the first Codex turn',
    )
    const thread = (await codexRequests()).find((r) => r.method === 'thread/start')
    expect(thread?.params?.model).toBe('gpt-6-mini')
    expect(turn.params).toMatchObject({ model: 'gpt-6-mini', effort: 'medium' })
    expect(await leadRun(client, task)).toMatchObject({
      agent: 'codex',
      model: 'gpt-6-mini',
      effort: 'max',
    })
  })

  test('with no lead set, the Task Lead field holds the default agent and no model or effort', async () => {
    const client = await startTed()

    const task = await client.ok<Task>('POST', '/tasks', { title: 'Plain', factory: 'NB' })

    expect(task.lead).toEqual({ agent: 'claude' })
  })
})

describe('changing the Task Lead field', () => {
  test('a model or effort change waits for the turn to end, then resumes the same Run with new flags', async () => {
    const client = await startTed()
    const go = path.join(scratch, 'go')
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ waitFor: go }, { endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const working = await waitForRun(client, task, (r) => r.state === 'working', 'a working Run')

    const changed = await client.ok<Task>('PUT', `/tasks/${task.id}/lead`, {
      agent: 'claude',
      model: 'opus',
      effort: 'low',
    })
    expect(changed.lead).toEqual({ agent: 'claude', model: 'opus', effort: 'low' })
    await sleep(500)
    expect(await claudeStarts()).toHaveLength(1)
    expect((await leadRun(client, task)).model).toBeUndefined()

    await writeFile(go, '')
    const starts = await waitUntil(async () => {
      const all = await claudeStarts()
      return all.length === 2 ? all : undefined
    }, 'the agent to restart')
    const argv = starts[1]?.argv ?? []
    expect(flag(argv, '--resume')).toBe(working.sessionId)
    expect(flag(argv, '--model')).toBe('opus')
    expect(flag(argv, '--effort')).toBe('low')
    const after = await leadRun(client, task)
    expect(after).toMatchObject({ id: working.id, model: 'opus', effort: 'low', state: 'idle' })
    await sleep(300)
    expect(await claudeStarts()).toHaveLength(2)
  })

  test('a change made while the Run is idle applies at once', async () => {
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const idle = await waitForRun(client, task, (r) => r.state === 'idle', 'an idle Run')

    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', effort: 'xhigh' })
    await waitUntil(async () => (await claudeStarts()).length === 2, 'the agent to restart')
    const restarted = await waitUntil(async () => {
      const run = await leadRun(client, task)
      return run.effort === 'xhigh' ? run : undefined
    }, 'the new effort')
    expect(restarted.id).toBe(idle.id)
  })

  test('an agent change stops the Run and starts a fresh one with the new agent from the Task', async () => {
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const first = await waitForRun(client, task, (r) => r.state === 'idle', 'an idle Run')

    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'codex', effort: 'high' })

    const fresh = await waitForRun(client, task, (r) => r.id !== first.id, 'a fresh Run')
    expect(fresh).toMatchObject({ agent: 'codex', effort: 'high' })
    expect(fresh.prompt).toContain('# Your Task: NB-1')
    expect(fresh.prompt).toContain('# Intake')
    await waitUntil(
      async () => (await client.getRun(first.id)).run.state === 'finished' || undefined,
      'the old Run to stop',
    )
  })

  test('the field takes only a known agent and effort, and not from inside a Run', async () => {
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', { title: 'Plain', factory: 'NB' })

    for (const body of [
      { agent: 'gemini' },
      { agent: 'claude', effort: 'huge' },
      { agent: 'claude', model: '' },
      { agent: 'claude', model: 3 },
    ]) {
      expect((await client.call('PUT', `/tasks/${task.id}/lead`, body)).status).toBe(400)
    }
    expect((await client.call('PUT', '/tasks/NB-9/lead', { agent: 'codex' })).status).toBe(404)
    const set = await client.ok<Task>('PUT', `/tasks/${task.displayId}/lead`, {
      agent: 'codex',
      model: 'gpt-6-mini',
    })
    expect(set.lead).toEqual({ agent: 'codex', model: 'gpt-6-mini' })
  })
})

describe('Model unavailable', () => {
  test('the Run waits, TED asks, and nothing switches until the human picks the default model', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nlead: { model: unavailable-9, effort: high }\n',
    })
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)

    const waiting = await waitForRun(
      client,
      task,
      (r) => r.problem === 'model-unavailable',
      'the model to be unavailable',
    )
    expect(waiting.state).toBe('waiting')
    const [question] = await waitUntil(async () => {
      const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
      return comments.length > 0 ? comments : undefined
    }, 'TED’s question')
    expect(question).toMatchObject({ kind: 'question', author: { kind: 'ted' } })
    expect(question?.body).toContain('unavailable-9')
    expect(question?.body).toContain('Use the default model')
    expect(question?.body).toContain('Change setting')
    await sleep(500)
    expect(await claudeStarts()).toHaveLength(1)
    expect((await leadRun(client, task)).state).toBe('waiting')

    expect(question).toMatchObject({ choices: ['Use the default model', 'Change setting'] })
    expect(question?.answer).toBeUndefined()

    await client.ok('POST', `/comments/${question?.id}/answer`, {
      action: 'answer',
      choice: 'Use the default model',
    })

    const starts = await waitUntil(async () => {
      const all = await claudeStarts()
      return all.length === 2 ? all : undefined
    }, 'the agent to restart on the default model')
    const argv = starts[1]?.argv ?? []
    expect(argv).not.toContain('--model')
    expect(flag(argv, '--effort')).toBe('high')
    expect(flag(argv, '--resume')).toBe(waiting.sessionId)
    const after = await waitForRun(client, task, (r) => r.problem === undefined, 'no problem')
    expect(after).toMatchObject({ id: waiting.id, model: 'unavailable-9', usesDefaultModel: true })
    expect((await getTask(client, task.id))?.lead?.model).toBe('unavailable-9')
    await waitUntil(
      async () => (await userMessages(client, waiting.id)).at(-1)?.includes('default model'),
      'the Run to be told to carry on',
    )
    await sleep(500)
    expect(await claudeStarts()).toHaveLength(2)
    expect(await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).toMatchObject([
      { answer: { kind: 'answered', choice: 'Use the default model' } },
    ])
  })

  test('changing the setting while the model is unavailable resumes with the new model', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nlead: { model: unavailable-9 }\n',
    })
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    await waitForRun(client, task, (r) => r.problem !== undefined, 'the model to be unavailable')

    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', model: 'sonnet' })

    const starts = await waitUntil(async () => {
      const all = await claudeStarts()
      return all.length === 2 ? all : undefined
    }, 'the agent to restart')
    expect(flag(starts[1]?.argv ?? [], '--model')).toBe('sonnet')
    const after = await waitForRun(client, task, (r) => r.problem === undefined, 'no problem')
    expect(after.model).toBe('sonnet')
    expect(after.usesDefaultModel).toBeUndefined()
  })

  test('a Codex Run whose model isn’t available raises the same question', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nlead: { agent: codex, model: unavailable-9 }\n',
    })
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)

    const run = await waitForRun(
      client,
      task,
      (r) => r.problem === 'model-unavailable' && r.state === 'waiting',
      'the model to be unavailable',
    )
    expect(run.agent).toBe('codex')
    await waitUntil(async () => {
      const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
      return comments.some((c) => c.kind === 'question') || undefined
    }, 'TED’s question')

    await client.ok('POST', `/tasks/${task.id}/lead/use-default-model`)
    await waitUntil(async () => {
      const resumes = (await codexRequests()).filter((r) => r.method === 'thread/resume')
      return resumes.length === 1 && resumes[0]?.params?.model === 'gpt-6-astra' ? true : undefined
    }, 'Codex to resume its thread on the default model, named explicitly')
  })

  test('use the default model is refused when the model isn’t the problem', async () => {
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', { title: 'Plain', factory: 'NB' })

    const res = await client.call('POST', `/tasks/${task.id}/lead/use-default-model`)

    expect(res.status).toBe(409)
  })
})
