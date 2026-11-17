import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { openStore } from '../src/store/index.ts'
import { killRunHosts, stubClaudePath, stubCodexPath, waitUntil } from './helpers.ts'
import {
  claudeStarts,
  connect,
  ctx,
  leadRun,
  startTed,
  steps,
  userMessages,
  useTaskLeadHarness,
  waitForRun,
} from './support/task-lead.ts'

useTaskLeadHarness()

describe('Stage effort', () => {
  test.each(['send-now', 'new-message'] as const)(
    'Stop holds Task Lead messages until %s, including after an effort change',
    async (release) => {
      const client = await startTed()
      const task = await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        title: steps(
          { everyMessage: [{ endTurn: true }] },
          { waitFor: path.join(ctx.scratch, 'never') },
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
          path.join(ctx.home, 'stub-claude.json'),
          JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
        )
        await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', effort: 'high' })
      }
      await client.ok('POST', `/runs/${run.id}/interrupt`)
      await waitForRun(client, task, (r) => r.state === 'idle', 'Stop', 60_000)
      if (release === 'new-message') {
        await client.ok('POST', `/tasks/${task.id}/lead/restart`)
        await waitForRun(client, task, (r) => r.effort === 'high', 'pending effort applied')
      }
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

  test('delivers a human message while a saved effort change waits for Restart now', async () => {
    const client = await startTed()
    const finish = path.join(ctx.scratch, 'finish-turn')
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: steps({ waitFor: finish }, { endTurn: true }),
    })
    await writeFile(
      path.join(ctx.home, 'stub-claude.json'),
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
      'note delivery without a restart',
    )
    expect((await leadRun(client, task)).effort).toBeUndefined()
    expect(await claudeStarts()).toHaveLength(1)
  })

  test.each([false, true])(
    'a fresh launch keeps held instructions durable (wait for host before shutdown: %s)',
    async (waitForHost) => {
      let client = await startTed()
      const task = await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        title: steps({ endTurn: true }),
      })
      await ctx.daemon?.stop()
      ctx.daemon = undefined
      const store = await openStore({ directory: path.join(ctx.home, 'store') })
      try {
        store.holdLeadMessage(
          task.id,
          'Held Stage instructions before a replacement Task Lead starts.',
        )
        await store.persisted()
      } finally {
        await store.close()
      }
      const gate = path.join(ctx.scratch, 'accept-initial')
      await writeFile(
        path.join(ctx.home, 'stub-claude.json'),
        JSON.stringify({ inputWaitsFor: gate, resumeSteps: [{ endTurn: true }] }),
      )
      ctx.daemon = await startDaemon({
        home: ctx.home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
      })
      client = connect(ctx.daemon)
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
      await ctx.daemon.stop()
      ctx.daemon = undefined
      const reopened = await openStore({ directory: path.join(ctx.home, 'store') })
      try {
        expect(reopened.getTask(task.id)?.pendingLeadMessages).toHaveLength(1)
      } finally {
        await reopened.close()
      }
      ctx.daemon = await startDaemon({
        home: ctx.home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
      })
      client = connect(ctx.daemon)
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
      await killRunHosts(ctx.home)
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
})
