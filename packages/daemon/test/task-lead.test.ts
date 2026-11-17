import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Comment, Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { eventlogFile } from '../src/store/files.ts'
import { commitToOrigin, stubClaudePath, stubCodexPath, waitUntil } from './helpers.ts'
import {
  claudeStarts,
  codexRequests,
  connect,
  ctx,
  flag,
  getTask,
  leadRun,
  startTed,
  steps,
  userMessages,
  useTaskLeadHarness,
  waitForRun,
} from './support/task-lead.ts'

useTaskLeadHarness()

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
    await mkdir(path.join(ctx.home, 'library'), { recursive: true })
    await writeFile(
      path.join(ctx.home, 'library', 'workflow.yaml'),
      'version: 1\nlead: { model: sonnet, effort: low }\n',
    )
    await commitToOrigin(ctx.scratch, {
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
    await commitToOrigin(ctx.scratch, {
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
  test('a model or effort change waits for Restart now, then resumes the same Run with new flags', async () => {
    const client = await startTed()
    const go = path.join(ctx.scratch, 'go')
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
    await writeFile(go, '')
    await waitForRun(client, task, (r) => r.state === 'idle', 'the turn to end')
    await sleep(500)
    expect(await claudeStarts()).toHaveLength(1)
    expect((await leadRun(client, task)).model).toBeUndefined()

    await client.ok('POST', `/tasks/${task.id}/lead/restart`)
    const starts = await waitUntil(async () => {
      const all = await claudeStarts()
      return all.length === 2 ? all : undefined
    }, 'the agent to restart')
    const argv = starts[1]?.argv ?? []
    expect(flag(argv, '--resume')).toBe(working.sessionId)
    expect(flag(argv, '--model')).toBe('opus')
    expect(flag(argv, '--effort')).toBe('low')
    const after = await leadRun(client, task)
    expect(after).toMatchObject({ id: working.id, model: 'opus', effort: 'low' })
    const again = await client.call('POST', `/tasks/${task.id}/lead/restart`)
    expect(again.status).toBe(409)
  })

  test('an agent change waits for Restart now, then starts a fresh Run with the brief and conversation', async () => {
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const first = await waitForRun(client, task, (r) => r.state === 'idle', 'an idle Run')

    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'codex', effort: 'high' })
    await sleep(500)
    expect((await leadRun(client, task)).id).toBe(first.id)

    await client.ok('POST', `/tasks/${task.id}/lead/restart`)
    const fresh = await waitForRun(client, task, (r) => r.id !== first.id, 'a fresh Run')
    expect(fresh).toMatchObject({ agent: 'codex', effort: 'high' })
    expect(fresh.prompt).toContain('# Your Task: NB-1')
    expect(fresh.prompt).toContain('# Picking up after an agent change')
    expect(fresh.prompt).toContain('from Claude to Codex')
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
      await commitToOrigin(ctx.scratch, {
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
      }, 'Ted’s question')
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
        await ctx.daemon?.stop()
        ctx.daemon = await startDaemon({
          home: ctx.home,
          version: '9.9.9',
          claudeBin: stubClaudePath,
          codexBin: stubCodexPath,
        })
        client = connect(ctx.daemon)
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
      const log = new DatabaseSync((await eventlogFile(path.join(ctx.home, 'store'))) as string, {
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
    await commitToOrigin(ctx.scratch, {
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
    await commitToOrigin(ctx.scratch, {
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
    }, 'Ted’s question')

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
