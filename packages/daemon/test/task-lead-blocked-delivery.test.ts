import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { commitToOrigin, stubClaudePath, stubCodexPath, waitUntil } from './helpers.ts'
import {
  connect,
  ctx,
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
      await commitToOrigin(ctx.scratch, {
        '.ted/workflow.yaml':
          'version: 1\norder: [intake, work, merge]\nlead: { agent: claude, effort: medium }\nstages:\n  work: { effort: high }\n',
      })
      const gate = path.join(ctx.scratch, 'accept-stage')
      const go = path.join(ctx.scratch, 'advance')
      await writeFile(
        path.join(ctx.home, 'stub-claude.json'),
        JSON.stringify({ resumeInputWaitsFor: gate, resumeSteps: [{ endTurn: true }] }),
      )
      let client = await startTed()
      const task = await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        title: steps(
          { waitFor: go },
          { run: ['ted', 'outcome', 'advance'] },
          { waitFor: path.join(ctx.scratch, 'never') },
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
      const stageText = 'Ted moved this Task to Work'
      await client.ok('POST', `/runs/${run.id}/messages`, { text: firstText })
      const selected = await client.ok<{ id: string }>('POST', `/runs/${run.id}/messages`, {
        text: selectedText,
      })
      await client.ok('POST', `/runs/${run.id}/interrupt`)
      await waitUntil(async () => {
        const input = await readFile(path.join(ctx.home, 'runs', run.id, 'input.jsonl'), 'utf8')
        return input.includes(stageText)
      }, 'Stage instructions appended before acceptance')
      expect((await client.getRun(run.id)).run.state).toBe('idle')
      expect(await userMessages(client, run.id)).not.toContain(firstText)
      if (release !== 'send-now')
        await client.ok('POST', `/runs/${run.id}/messages`, { text: newerText })
      if (release !== 'new-message')
        await client.ok('POST', `/runs/${run.id}/messages/${selected.id}/send-now`)
      if (recover) {
        await ctx.daemon?.stop()
        ctx.daemon = undefined
        ctx.daemon = await startDaemon({
          home: ctx.home,
          version: '9.9.9',
          claudeBin: stubClaudePath,
          codexBin: stubCodexPath,
        })
        client = connect(ctx.daemon)
      }
      await writeFile(gate, '')
      const last = release === 'send-now' ? selectedText : newerText
      await waitUntil(
        async () => (await userMessages(client, run.id)).includes(last),
        'explicit release after Stage acceptance',
      )
      const messages = (await userMessages(client, run.id))
        .map((text) => (text.includes(stageText) ? stageText : text))
        .filter((text) => [stageText, firstText, selectedText, newerText].includes(text))
      expect(messages).toEqual([
        stageText,
        ...(release === 'new-message'
          ? [firstText, selectedText, newerText]
          : release === 'send-now'
            ? [selectedText]
            : [selectedText, firstText, newerText]),
      ])
      expect((await leadRun(client, task)).id).toBe(run.id)
      expect((await leadRun(client, task)).effort).toBe('high')
    },
  )
})
