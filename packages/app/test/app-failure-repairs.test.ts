import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { FailureCase } from '@ted/protocol'
import { readDaemonInfo, tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { loadRunTokens } from '../../daemon/src/run-token.ts'
import { api, commitToOrigin, makeOriginRepo, waitUntil } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  setUpAppTests,
} from './app-harness.ts'

setUpAppTests()

test.each(['new', 'existing'] as const)(
  'the native failure decision approves the %s repair through the app bridge',
  async (kind) => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, validate, work, review, merge]',
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Tests, run: "exit 1" }',
      ].join('\n'),
    })
    await addFactory(origin, 'NB')
    const client = await daemonClient()
    const created = await client.createTask({
      factory: 'NB',
      title: JSON.stringify({
        steps: [{ run: ['ted', 'outcome', 'advance'] }, { endTurn: true }],
      }),
      start: true,
    })
    const task = await waitUntil(async () => {
      const current = (await client.listTasks()).find((t) => t.id === created.id)
      return current?.stage === 'validate' && current.runs[0]?.state === 'idle'
        ? current
        : undefined
    }, 'Validate Task Lead')
    const failure = await waitUntil(
      async () => (await client.listFailures(task.id))[0],
      'failed Check',
    )
    const info = await readDaemonInfo(ctx.home)
    if (!info || !task.leadRunId) throw new Error('missing Task Lead')
    const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
    const lead = api(info.port, tokens.issue(task.leadRunId))
    const root = `/tasks/${task.id}/failures/${failure.id}`
    expect(
      (
        await lead.call('POST', `${root}/assessments`, {
          assessment: 'unrelated',
          recommendation: 'Repair the separate test environment.',
        })
      ).status,
    ).toBe(200)
    const asked = await lead.call('POST', `${root}/decision`, {})
    expect(asked.status).toBe(201)
    const requestId = (asked.body as FailureCase).decisions.at(-1)?.commentId
    if (!requestId) throw new Error('missing failure decision')
    const existing =
      kind === 'existing'
        ? await client.createTask({ factory: 'NB', title: 'Existing environment repair' })
        : undefined
    if (existing) await client.blockTask(existing.id, task.id)
    const before = (await client.listTasks()).length
    const window = await launchApp()
    await openAllTasks(window)
    await window.locator(`tr[data-task="${task.displayId}"]`).click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    const question = thread
      .getByRole('region', { name: 'Question', exact: true })
      .filter({ hasText: 'How should we handle the Tests failure?' })
    await question.getByRole('radio', { name: 'Wait for a repair Task', exact: true }).click()
    const form = question.getByRole('region', { name: 'Wait for a repair Task', exact: true })
    await form.waitFor()
    expect((await client.listInbox()).some((i) => i.request.id === requestId)).toBe(true)
    expect(await client.listTasks()).toHaveLength(before)
    expect(await form.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true)
    if (kind === 'new') {
      await form.getByRole('radio', { name: 'Create a repair Task' }).check()
      expect(await form.getByRole('checkbox').isChecked()).toBe(true)
      const description = await form.getByLabel('Repair description').inputValue()
      expect(description).toContain(`Failure ${failure.id.slice(0, 6)}\n`)
      if (!failure.contextId) throw new Error('missing tested context')
      expect(description).toContain(`Original tested context: ${failure.contextId.slice(0, 6)}\n`)
      await form.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await client.listTasks()).toHaveLength(before)
      expect((await client.listInbox()).some((i) => i.request.id === requestId)).toBe(true)
      await question.getByRole('radio', { name: 'Wait for a repair Task', exact: true }).click()
      await form.getByRole('radio', { name: 'Create a repair Task' }).check()
      await form.getByLabel('Repair title', { exact: true }).fill('Repair environment')
      await form
        .getByRole('textbox', { name: /^Repair description/ })
        .fill('Restore test execution.')
      await form.getByRole('checkbox').uncheck()
    } else if (existing) {
      await form.getByRole('button', { name: 'Choose repair', exact: true }).click()
      await form.getByRole('combobox', { name: 'Find a Task' }).fill(existing.displayId)
      await form.getByRole('option').filter({ hasText: existing.displayId }).click()
      await form.getByRole('button', { name: 'Send', exact: true }).click()
      await form.getByRole('alert').waitFor()
      expect(await form.getByRole('alert').textContent()).toContain('cycle')
      expect(await client.listTasks()).toHaveLength(before)
      expect((await client.listInbox()).some((i) => i.request.id === requestId)).toBe(true)
      await client.unblockTask(existing.id, task.id)
    }
    const captures = path.resolve('node_modules/.cache/ted-8')
    await mkdir(captures, { recursive: true })
    await form.screenshot({ path: path.join(captures, `native-repair-${kind}.png`) })
    await form
      .getByRole('button', {
        name: 'Send',
        exact: true,
      })
      .click()
    const waiting = await waitUntil(async () => {
      const current = (await client.listTasks()).find((t) => t.id === task.id)
      return current?.blockedBy.length === 1 && current.runs.length === 0 ? current : undefined
    }, 'approved repair wait')
    expect(waiting.stage).toBe('validate')
    const tasks = await client.listTasks()
    const repair = tasks.find((t) => t.id === waiting.blockedBy[0])
    expect(repair).toMatchObject({
      title: existing?.title ?? 'Repair environment',
      stage: 'backlog',
    })
    expect(tasks).toHaveLength(before + (kind === 'new' ? 1 : 0))
    expect((await client.listFailures(task.id))[0]?.originalCheck?.state).toBe('failed')
    const answered = thread
      .getByRole('region', { name: 'Question, answered', exact: true })
      .filter({ hasText: 'How should we handle the Tests failure?' })
    await answered.getByRole('button', { name: 'Show request', exact: true }).click()
    await answered.getByRole('heading', { name: 'Repair Task', exact: true }).waitFor()
    expect(await answered.textContent()).toContain(repair?.displayId)
  },
)
