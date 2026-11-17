import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'
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

describe('Stage effort', () => {
  test('recovers a crashed host with the entered Stage’s flags and instructions on its first turn', async () => {
    await commitToOrigin(ctx.scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, work, merge]\nlead: { agent: claude, effort: medium }\nstages:\n  work: { effort: high }\n',
    })
    await writeFile(
      path.join(ctx.home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    const go = path.join(ctx.scratch, 'advance')
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: steps(
        { waitFor: go },
        { run: ['ted', 'outcome', 'advance'] },
        { waitFor: path.join(ctx.scratch, 'never') },
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
    await killRunHosts(ctx.home)
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
      await commitToOrigin(ctx.scratch, {
        '.ted/workflow.yaml':
          'version: 1\norder: [intake, work, merge]\nlead: { agent: claude, effort: medium }\nstages:\n  work: { effort: high }\n',
      })
      const gate = path.join(ctx.scratch, 'resume-gate')
      await writeFile(
        path.join(ctx.home, 'stub-claude.json'),
        JSON.stringify({ resumeInputWaitsFor: gate, resumeSteps: [{ endTurn: true }] }),
      )
      const go = path.join(ctx.scratch, 'advance')
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
          path.join(ctx.home, 'runs', initial.id, 'input.jsonl'),
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
      await killRunHosts(ctx.home)
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
    await commitToOrigin(ctx.scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, work, review, merge]\nlead: { agent: claude, effort: medium }\nstages:\n  work: { effort: high }\n  review: { gate: false }\n',
    })
    await writeFile(
      path.join(ctx.home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    const go = path.join(ctx.scratch, 'advance')
    const finish = path.join(ctx.scratch, 'finish')
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
    await ctx.daemon?.stop()
    ctx.daemon = await startDaemon({
      home: ctx.home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
    })
    client = connect(ctx.daemon)
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
    await commitToOrigin(ctx.scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, work, merge]\nstages:\n  intake: { effort: high }\n  work: { effort: high }\n',
    })
    await writeFile(
      path.join(ctx.home, 'stub-claude.json'),
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
    await client.ok('POST', `/tasks/${task.id}/lead/restart`)
    await waitForRun(
      client,
      task,
      (r) => r.effort === undefined && r.state === 'idle',
      'explicit CLI default',
    )
    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', effortMode: 'stage' })
    await client.ok('POST', `/tasks/${task.id}/lead/restart`)
    await waitForRun(client, task, (r) => r.effort === 'high' && r.state === 'idle', 'Stage effort')
    await waitUntil(
      async () => (await claudeStarts()).length === 3,
      'both effort changes acknowledged',
    )
    const before = (await claudeStarts()).length
    await ctx.daemon?.stop()
    ctx.daemon = await startDaemon({
      home: ctx.home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
    })
    const restarted = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
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
  await commitToOrigin(ctx.scratch, {
    '.ted/workflow.yaml':
      'version: 1\norder: [intake, work, merge]\nlead: { agent: codex, effort: low }\nstages:\n  work: { effort: high }\n',
  })
  await writeFile(
    path.join(ctx.home, 'stub-codex.json'),
    JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
  )
  const go = path.join(ctx.scratch, 'advance-codex')
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
