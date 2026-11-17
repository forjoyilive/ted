import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeOriginRepo, waitForExit, waitUntil } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  daemonPid,
  launchApp,
  openAllTasks,
  setUpAppTests,
  taskRow,
  ted,
} from './app-harness.ts'
import { closeApp } from './close-app.ts'

setUpAppTests()

describe('Resume after a full quit', () => {
  test.each(['Resume', 'Send and resume'] as const)(
    '%s continues without Stop Task first',
    async (action) => {
      const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
      await addFactory(origin, 'NB')
      await ted(
        'task',
        'create',
        '--factory',
        'NB',
        '--start',
        JSON.stringify({ steps: [{ waitFor: path.join(ctx.home, 'never') }] }),
      )
      let window = await launchApp()
      let client = await daemonClient()
      const first = await waitUntil(async () => {
        const task = (await client.listTasks())[0]
        return task?.runs[0]?.state === 'working' ? task : undefined
      }, 'the original Task Lead to work')
      await client.updateSettings({ quitWithWorkRunning: 'stop' })
      const pid = await daemonPid()
      await closeApp(ctx.app)
      ctx.app = undefined
      await waitForExit(pid)

      window = await launchApp()
      client = await daemonClient()
      const offer = window.getByRole('dialog', { name: '1 Task was working when Ted quit' })
      await offer.getByRole('button', { name: 'Leave stopped' }).click()
      await offer.waitFor({ state: 'detached' })
      await openAllTasks(window)
      await taskRow(window, 'NB-1').click()
      const thread = window.getByRole('region', { name: 'Task thread' })
      const header = thread.locator('header')
      await header.getByRole('button', { name: 'Resume', exact: true }).waitFor()
      await thread
        .getByText(
          'Resume starts a fresh Task Lead Run from the brief and comments when a slot is free.',
        )
        .waitFor()
      expect((await client.listTasks())[0]?.leadRunId).toBe(first.leadRunId)
      await client.openRunTab(first.id, first.leadRunId ?? '')
      const chat = window.getByRole('region', { name: 'Run chat' })
      expect(await chat.getByRole('textbox', { name: 'Comment' }).isEnabled()).toBe(true)
      await header.getByRole('button', { name: 'Resume', exact: true }).waitFor()

      if (action === 'Resume') {
        await header.getByRole('button', { name: 'Resume', exact: true }).click()
      } else {
        await thread
          .getByRole('textbox', { name: 'Comment', exact: true })
          .fill('Keep the current work.')
        await thread.getByRole('button', { name: 'Send and resume' }).click()
      }
      const resumed = await waitUntil(async () => {
        const task = (await client.listTasks())[0]
        return task?.runs[0]?.state === 'working' && task.leadRunId !== first.leadRunId
          ? task
          : undefined
      }, 'a fresh Task Lead to work')
      expect(resumed.stage).toBe(first.stage)
      await header
        .getByRole('button', { name: 'Resume', exact: true })
        .waitFor({ state: 'detached' })
      expect((await client.getRun(first.leadRunId ?? '')).run.state).toBe('finished')
      if (action === 'Send and resume') {
        const comments = await client.listComments(first.id)
        expect(comments.find((c) => c.body === 'Keep the current work.')?.delivered?.runId).toBe(
          resumed.leadRunId,
        )
      }
    },
  )
})
