import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Comment, Factory, Run, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { eventlogFile } from '../src/store/files.ts'
import { openStore } from '../src/store/index.ts'
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
  const client = connect(daemon)

  await client.ok<Factory>('POST', '/dev/factories', {
    repo: path.join(scratch, 'acme', 'widgets.git'),
    key: 'NB',
  })
  return client
}

function connect(daemon: RunningDaemon) {
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

const waitForRun = (
  client: Client,
  task: Task,
  check: (run: Run) => boolean,
  what: string,
  timeoutMs?: number,
) =>
  waitUntil(
    async () => {
      const run = await leadRun(client, task).catch(() => undefined)
      return run && check(run) ? run : undefined
    },
    what,
    timeoutMs,
  )

const userMessages = async (client: Client, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

describe('lead from workflow.yaml', () => {
  test('a Task Lead model that isn’t a plain model name is refused', async () => {
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', { title: 'Plain', factory: 'NB' })
    for (const model of ['--dangerously-skip-permissions', '-x', 'opus sonnet', 'a"b', 'x\ny']) {
      const put = await client.call('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', model })
      expect(put.status).toBe(400)
      expect(put.body).toMatchObject({ error: expect.stringMatching(/model name/) })
      const created = await client.call('POST', '/tasks', {
        title: 'Other',
        factory: 'NB',
        lead: { agent: 'codex', model },
      })
      expect(created.status).toBe(400)
    }
    const fine = await client.ok<Task>('PUT', `/tasks/${task.id}/lead`, {
      agent: 'codex',
      model: 'openai/gpt-6.1:latest',
    })
    expect(fine.lead).toEqual({ agent: 'codex', model: 'openai/gpt-6.1:latest' })
  })

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
    expect(task.lead).toEqual({
      agent: 'claude',
      model: 'sonnet',
      effort: 'high',
      effortMode: 'stage',
    })

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

    expect(task.lead).toEqual({ agent: 'claude', effortMode: 'stage' })
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
    await waitUntil(async () => (await claudeStarts()).length > 0, 'the agent’s first start')
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
  test.each([false, true])(
    'the human picks the default model (daemon restarted: %s)',
    async (restart) => {
      await commitToOrigin(scratch, {
        '.ted/workflow.yaml': 'version: 1\nlead: { model: unavailable-9, effort: high }\n',
      })
      let client = await startTed()
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

      if (restart) {
        await daemon?.stop()
        daemon = await startDaemon({
          home,
          version: '9.9.9',
          claudeBin: stubClaudePath,
          codexBin: stubCodexPath,
        })
        client = connect(daemon)
      }

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
      expect(after).toMatchObject({
        id: waiting.id,
        model: 'unavailable-9',
        usesDefaultModel: true,
      })
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
      const log = new DatabaseSync((await eventlogFile(path.join(home, 'store'))) as string, {
        readOnly: true,
      })
      try {
        expect(
          log
            .prepare(
              "SELECT COUNT(*) AS count FROM eventlog WHERE name = 'v1.CommentAnswered' AND json_extract(argsJson, '$.id') = ?",
            )
            .get(question?.id ?? '')?.count,
        ).toBe(1)
      } finally {
        log.close()
      }
    },
  )

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

describe('Stage effort', () => {
  test.each(['send-now', 'new-message'] as const)(
    'Stop holds Task Lead messages until %s, including after an effort change',
    async (release) => {
      const client = await startTed()
      const task = await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        title: steps(
          { everyMessage: [{ endTurn: true }] },
          { waitFor: path.join(scratch, 'never') },
          { endTurn: true },
        ),
      })
      await client.ok('POST', `/tasks/${task.id}/start`)
      const run = await waitForRun(
        client,
        task,
        (r) => r.state === 'working' && r.sessionId !== undefined,
        'working Task Lead',
      )
      await waitUntil(
        async () => (await userMessages(client, run.id)).length > 0,
        'the Task Lead’s first turn to begin',
      )
      const text = 'Keep this note held after Stop.'
      const queued = await client.ok<{ id: string }>('POST', `/runs/${run.id}/messages`, { text })
      if (release === 'new-message') {
        await writeFile(
          path.join(home, 'stub-claude.json'),
          JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
        )
        await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', effort: 'high' })
      }
      await client.ok('POST', `/runs/${run.id}/interrupt`)
      await waitForRun(
        client,
        task,
        (r) => r.state === 'idle' && (release === 'send-now' || r.effort === 'high'),
        'Stop and pending effort applied',
        60_000,
      )
      if (release === 'new-message')
        await waitUntil(
          async () => (await claudeStarts()).length === 2,
          'effort restart acknowledgement',
        )
      await sleep(400)
      expect(await userMessages(client, run.id)).not.toContain(text)
      if (release === 'send-now')
        await client.ok('POST', `/runs/${run.id}/messages/${queued.id}/send-now`)
      else await client.ok('POST', `/runs/${run.id}/messages`, { text: 'Continue now.' })
      await waitUntil(
        async () => (await userMessages(client, run.id)).includes(text),
        'explicit release of held note',
      )
      expect(
        (await userMessages(client, run.id)).filter((message) => message === text),
      ).toHaveLength(1)
    },
    90_000,
  )

  test.each([
    ['new-message', false],
    ['send-now', false],
    ['new-message', true],
    ['send-now', true],
    ['send-now-after-new-message', false],
    ['send-now-after-new-message', true],
  ] as const)(
    'retains %s during blocked Stage delivery (daemon recovery: %s)',
    async (release, recover) => {
      await commitToOrigin(scratch, {
        '.ted/workflow.yaml':
          'version: 1\norder: [intake, work, merge]\nlead: { agent: claude, effort: medium }\nstages:\n  work: { effort: high }\n',
      })
      const gate = path.join(scratch, 'accept-stage')
      const go = path.join(scratch, 'advance')
      await writeFile(
        path.join(home, 'stub-claude.json'),
        JSON.stringify({ resumeInputWaitsFor: gate, resumeSteps: [{ endTurn: true }] }),
      )
      let client = await startTed()
      const task = await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        title: steps(
          { waitFor: go },
          { run: ['ted', 'outcome', 'advance'] },
          { waitFor: path.join(scratch, 'never') },
        ),
      })
      await client.ok('POST', `/tasks/${task.id}/start`)
      const run = await waitForRun(
        client,
        task,
        (r) => r.state === 'working' && r.sessionId !== undefined,
        'Intake session',
      )
      await writeFile(go, '')
      await waitUntil(async () => (await getTask(client, task.id))?.stage === 'work', 'Work entry')
      const firstText = 'Held first note.'
      const selectedText = 'Held selected note.'
      const newerText = 'Explicit new message.'
      await client.ok('POST', `/runs/${run.id}/messages`, { text: firstText })
      const selected = await client.ok<{ id: string }>('POST', `/runs/${run.id}/messages`, {
        text: selectedText,
      })
      await client.ok('POST', `/runs/${run.id}/interrupt`)
      await waitUntil(async () => {
        const input = await readFile(path.join(home, 'runs', run.id, 'input.jsonl'), 'utf8')
        return input.includes('TED moved this Task to Work')
      }, 'Stage instructions appended before acceptance')
      expect((await client.getRun(run.id)).run.state).toBe('idle')
      expect(await userMessages(client, run.id)).not.toContain(firstText)
      if (release !== 'send-now')
        await client.ok('POST', `/runs/${run.id}/messages`, { text: newerText })
      if (release !== 'new-message')
        await client.ok('POST', `/runs/${run.id}/messages/${selected.id}/send-now`)
      if (recover) {
        await daemon?.stop()
        daemon = undefined
        daemon = await startDaemon({
          home,
          version: '9.9.9',
          claudeBin: stubClaudePath,
          codexBin: stubCodexPath,
        })
        client = connect(daemon)
      }
      await writeFile(gate, '')
      const last = release === 'send-now' ? selectedText : newerText
      await waitUntil(
        async () => (await userMessages(client, run.id)).includes(last),
        'explicit release after Stage acceptance',
      )
      const messages = (await userMessages(client, run.id)).filter((text) =>
        [firstText, selectedText, newerText].includes(text),
      )
      expect(messages).toEqual(
        release === 'new-message'
          ? [firstText, selectedText, newerText]
          : release === 'send-now'
            ? [selectedText]
            : [selectedText, firstText, newerText],
      )
      expect((await leadRun(client, task)).id).toBe(run.id)
      expect((await leadRun(client, task)).effort).toBe('high')
    },
  )

  test('delivers an unheld human message after an idle effort restart', async () => {
    const client = await startTed()
    const finish = path.join(scratch, 'finish-turn')
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: steps({ waitFor: finish }, { endTurn: true }),
    })
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    await client.ok('POST', `/tasks/${task.id}/start`)
    const run = await waitForRun(
      client,
      task,
      (r) => r.state === 'working' && r.sessionId !== undefined,
      'working Task Lead',
    )
    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', effort: 'high' })
    const text = 'Deliver this note after the effort change.'
    await client.ok('POST', `/runs/${run.id}/messages`, { text })
    expect(await userMessages(client, run.id)).not.toContain(text)
    await writeFile(finish, '')
    await waitUntil(
      async () => (await userMessages(client, run.id)).includes(text),
      'unheld note delivery after restart',
    )
    expect((await leadRun(client, task)).effort).toBe('high')
    expect(await claudeStarts()).toHaveLength(2)
  })

  test.each([false, true])(
    'a fresh launch keeps held instructions durable (wait for host before shutdown: %s)',
    async (waitForHost) => {
      let client = await startTed()
      const task = await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        title: steps({ endTurn: true }),
      })
      await daemon?.stop()
      daemon = undefined
      const store = await openStore({ directory: path.join(home, 'store') })
      try {
        store.holdLeadMessage(
          task.id,
          'Held Stage instructions before a replacement Task Lead starts.',
        )
        await store.persisted()
      } finally {
        await store.close()
      }
      const gate = path.join(scratch, 'accept-initial')
      await writeFile(
        path.join(home, 'stub-claude.json'),
        JSON.stringify({ inputWaitsFor: gate, resumeSteps: [{ endTurn: true }] }),
      )
      daemon = await startDaemon({
        home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
      })
      client = connect(daemon)
      await client.ok('POST', `/tasks/${task.id}/start`)
      const initial = await waitForRun(
        client,
        task,
        (r) => r.sessionId !== undefined,
        'new Task Lead session before acceptance',
      )
      if (waitForHost) {
        await waitUntil(async () => (await claudeStarts()).length === 1, 'initial agent spawn')
      }
      expect(await userMessages(client, initial.id)).toHaveLength(0)
      await daemon.stop()
      daemon = undefined
      const reopened = await openStore({ directory: path.join(home, 'store') })
      try {
        expect(reopened.getTask(task.id)?.pendingLeadMessages).toHaveLength(1)
      } finally {
        await reopened.close()
      }
      daemon = await startDaemon({
        home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
      })
      client = connect(daemon)
      await writeFile(gate, '')
      const accepted = await waitForRun(
        client,
        task,
        (r) => r.state === 'idle',
        'initial prompt acceptance',
      )
      if (!waitForHost) {
        const messages = await userMessages(client, initial.id)
        expect(
          messages.filter((m) => m.includes('Held Stage instructions before a replacement')),
        ).toHaveLength(1)
        return
      }
      await killRunHosts(home)
      await waitForRun(
        client,
        task,
        (r) => r.revivedAt !== accepted.revivedAt && r.state === 'idle',
        'recovery after initial acceptance',
      )
      const messages = await userMessages(client, initial.id)
      expect(
        messages.filter((m) => m.includes('Held Stage instructions before a replacement')),
      ).toHaveLength(1)
      expect(messages.at(-1)).not.toContain('Held Stage instructions before a replacement')
    },
  )

  test('recovers a crashed host with the entered Stage’s flags and instructions on its first turn', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, work, merge]\nlead: { agent: claude, effort: medium }\nstages:\n  work: { effort: high }\n',
    })
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    const go = path.join(scratch, 'advance')
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: steps(
        { waitFor: go },
        { run: ['ted', 'outcome', 'advance'] },
        { waitFor: path.join(scratch, 'never') },
      ),
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const initial = await waitForRun(
      client,
      task,
      (r) => r.state === 'working' && r.sessionId !== undefined,
      'Intake session',
    )
    await writeFile(go, '')
    await waitUntil(async () => (await getTask(client, task.id))?.stage === 'work', 'Work entry')
    await killRunHosts(home)
    await waitUntil(async () => (await claudeStarts()).length === 2, 'host recovery')
    await waitForRun(
      client,
      task,
      (r) => r.revivedAt !== undefined && r.state === 'idle',
      'recovery turn',
    )
    const starts = await claudeStarts()
    expect(flag(starts[1]?.argv ?? [], '--effort')).toBe('high')
    expect(flag(starts[1]?.argv ?? [], '--resume')).toBe(initial.sessionId)
    expect((await leadRun(client, task)).id).toBe(initial.id)
    expect((await userMessages(client, initial.id)).at(-1)).toContain('TED moved this Task to Work')
    expect(starts).toHaveLength(2)
  })

  test.each([false, true])(
    'replays Stage delivery only when the crashed host did not accept it (accepted: %s)',
    async (accepted) => {
      await commitToOrigin(scratch, {
        '.ted/workflow.yaml':
          'version: 1\norder: [intake, work, merge]\nlead: { agent: claude, effort: medium }\nstages:\n  work: { effort: high }\n',
      })
      const gate = path.join(scratch, 'resume-gate')
      await writeFile(
        path.join(home, 'stub-claude.json'),
        JSON.stringify({ resumeInputWaitsFor: gate, resumeSteps: [{ endTurn: true }] }),
      )
      const go = path.join(scratch, 'advance')
      const client = await startTed()
      const task = await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        title: steps({ waitFor: go }, { run: ['ted', 'outcome', 'advance'] }, { endTurn: true }),
      })
      await client.ok('POST', `/tasks/${task.id}/start`)
      const initial = await waitForRun(
        client,
        task,
        (r) => r.state === 'working' && r.sessionId !== undefined,
        'Intake session',
      )
      await writeFile(go, '')
      await waitUntil(async () => {
        const input = await readFile(
          path.join(home, 'runs', initial.id, 'input.jsonl'),
          'utf8',
        ).catch(() => '')
        return input.includes('TED moved this Task to Work')
      }, 'Stage input appended before acceptance')
      await waitUntil(async () => {
        const { conversation } = await client.getRun(initial.id)
        return (
          conversation.filter((entry) => {
            const line = JSON.parse(entry.line) as { type?: string; subtype?: string }
            return line.type === 'system' && line.subtype === 'init'
          }).length >= 2
        )
      }, 'resumed agent session acknowledgement before input acceptance')
      if (accepted) {
        await writeFile(gate, '')
        await waitUntil(
          async () =>
            (await userMessages(client, initial.id)).some((m) =>
              m.includes('TED moved this Task to Work'),
            ),
          'Stage acceptance',
        )
        await waitForRun(client, task, (r) => r.state === 'idle', 'accepted Stage turn')
      }
      await killRunHosts(home)
      await writeFile(gate, '')
      await waitUntil(
        async () => (await claudeStarts()).length === 3,
        'host recovery after delivery',
      )
      await waitForRun(
        client,
        task,
        (r) => r.revivedAt !== undefined && r.state === 'idle',
        'recovery turn',
      )
      const messages = await userMessages(client, initial.id)
      expect(messages.filter((m) => m.includes('TED moved this Task to Work'))).toHaveLength(1)
      if (!accepted) expect(messages.at(-1)).toContain('TED moved this Task to Work')
      else expect(messages.at(-1)).not.toContain('TED moved this Task to Work')
      expect(await claudeStarts()).toHaveLength(3)
    },
  )

  test('holds Stage instructions until idle, resumes the same session, and restores the baseline on an unconfigured Stage', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, work, review, merge]\nlead: { agent: claude, effort: medium }\nstages:\n  work: { effort: high }\n  review: { gate: false }\n',
    })
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    const go = path.join(scratch, 'advance')
    const finish = path.join(scratch, 'finish')
    let client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: steps(
        { waitFor: go },
        { run: ['ted', 'outcome', 'advance'] },
        { waitFor: finish },
        { endTurn: true },
      ),
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const initial = await waitForRun(client, task, (r) => r.state === 'working', 'the Intake turn')
    expect(initial.effort).toBe('medium')
    await writeFile(go, '')
    await waitUntil(async () => (await getTask(client, task.id))?.stage === 'work', 'Work entry')
    await sleep(200)
    expect(await claudeStarts()).toHaveLength(1)
    expect(
      (await userMessages(client, initial.id)).some((m) =>
        m.includes('TED moved this Task to Work'),
      ),
    ).toBe(false)
    await daemon?.stop()
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
    })
    client = connect(daemon)
    expect((await getTask(client, task.id))?.stageEffort).toBe('high')
    await writeFile(finish, '')
    await waitForRun(
      client,
      task,
      (r) => r.effort === 'high' && r.state === 'idle',
      'Work effort and Stage delivery',
    )
    const starts = await waitUntil(async () => {
      const all = await claudeStarts()
      return all.length === 2 ? all : undefined
    }, 'the resumed host acknowledgement')
    await waitUntil(
      async () =>
        (await userMessages(client, initial.id)).some((m) =>
          m.includes('TED moved this Task to Work'),
        ),
      'Work instructions after restart',
    )
    expect(starts).toHaveLength(2)
    expect(flag(starts[1]?.argv ?? [], '--resume')).toBe(initial.sessionId)
    expect((await leadRun(client, task)).id).toBe(initial.id)
    expect((await getTask(client, task.id))?.lead).toMatchObject({
      effort: 'medium',
      effortMode: 'stage',
    })
    expect(
      (await userMessages(client, initial.id)).some((m) =>
        m.includes('TED moved this Task to Work'),
      ),
    ).toBe(true)

    await client.ok('POST', `/runs/${initial.id}/messages`, {
      text: steps({ run: ['ted', 'outcome', 'advance'] }, { endTurn: true }),
    })
    await waitForRun(
      client,
      task,
      (r) => r.effort === 'medium' && r.state === 'idle',
      'baseline effort in Review',
    )
    expect((await getTask(client, task.id))?.stage).toBe('review')
    await waitUntil(async () => (await claudeStarts()).length === 3, 'Review host acknowledgement')
    await waitUntil(
      async () =>
        (await userMessages(client, initial.id)).some((m) =>
          m.includes('TED moved this Task to Review'),
        ),
      'Review instructions',
    )
  })

  test('fixed effort and explicit CLI default win; returning to Stage settings survives daemon restart', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, work, merge]\nstages:\n  intake: { effort: high }\n  work: { effort: high }\n',
    })
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: steps({ endTurn: true }),
      lead: { agent: 'claude', effort: 'low' },
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const initial = await waitForRun(client, task, (r) => r.state === 'idle', 'fixed effort')
    expect(initial.effort).toBe('low')
    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude' })
    await waitForRun(
      client,
      task,
      (r) => r.effort === undefined && r.state === 'idle',
      'explicit CLI default',
    )
    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', effortMode: 'stage' })
    await waitForRun(client, task, (r) => r.effort === 'high' && r.state === 'idle', 'Stage effort')
    await waitUntil(
      async () => (await claudeStarts()).length === 3,
      'both effort changes acknowledged',
    )
    const before = (await claudeStarts()).length
    await daemon?.stop()
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
    })
    const restarted = api(daemon.port, { appKey: daemon.appToken })
    await waitUntil(
      async () => (await restarted.getRun(initial.id)).run.state === 'idle',
      'the restored Run',
    )
    await restarted.call('POST', `/runs/${initial.id}/messages`, {
      text: steps({ run: ['ted', 'outcome', 'advance'] }, { endTurn: true }),
    })
    await waitUntil(
      async () =>
        ((await restarted.call('GET', '/tasks')).body as Task[]).find((t) => t.id === task.id)
          ?.stage === 'work',
      'Work',
    )
    await waitUntil(
      async () => (await restarted.getRun(initial.id)).run.state === 'idle',
      'the Work turn',
    )
    expect((await restarted.getRun(initial.id)).run.effort).toBe('high')
    expect(await claudeStarts()).toHaveLength(before)
  })
})

test('Codex resumes its thread with Stage effort before receiving Work instructions', async () => {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml':
      'version: 1\norder: [intake, work, merge]\nlead: { agent: codex, effort: low }\nstages:\n  work: { effort: high }\n',
  })
  await writeFile(
    path.join(home, 'stub-codex.json'),
    JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
  )
  const go = path.join(scratch, 'advance-codex')
  const client = await startTed()
  const task = await client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: steps({ waitFor: go }, { run: ['ted', 'outcome', 'advance'] }, { endTurn: true }),
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  const initial = await waitForRun(
    client,
    task,
    (r) => r.state === 'working' && r.sessionId !== undefined,
    'Codex Intake',
  )
  await writeFile(go, '')
  const requests = await waitUntil(async () => {
    const all = await codexRequests()
    return all.some((r) => r.method === 'thread/resume') &&
      all.some((r) => r.method === 'turn/start' && r.params?.effort === 'high')
      ? all
      : undefined
  }, 'Codex resumed at high effort')
  expect(requests.find((r) => r.method === 'thread/resume')?.params?.threadId).toBe(
    initial.sessionId,
  )
  expect((await leadRun(client, task)).id).toBe(initial.id)
  expect((await getTask(client, task.id))?.stage).toBe('work')
})
