import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import {
  commitToOrigin,
  makeOriginRepo,
  stopDaemonIn,
  stubCodexPath,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  githubReady,
  launchApp,
  setUpAppTests,
  sidebar,
  twoFactories,
  waitFor,
} from './app-harness.ts'
import { closeApp } from './close-app.ts'

setUpAppTests()
const form = (window: Page) => window.getByRole('dialog', { name: 'New Task' })
async function open(window: Page) {
  await window.keyboard.press('Meta+N')
  await form(window).waitFor()
  await waitFor(() => form(window).getByLabel('Description', { exact: true }).isEnabled())
}
async function setup() {
  await twoFactories()
  const window = await launchApp()
  await sidebar(window).getByRole('button', { name: 'notebook', exact: true }).click()
  await open(window)
  return window
}

describe('New Task drafts', () => {
  test('opening the setup Task dismisses New Task and preserves its draft', async () => {
    await makeOriginRepo(path.join(ctx.home, 'origin'))
    await githubReady(['acme/widgets'])
    const window = await launchApp()
    const client = await daemonClient()
    const factory = await client.createFactory({
      name: 'Widgets',
      key: 'WD',
      repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
      showTutorial: false,
    })
    const setup = await waitUntil(
      async () => (await client.listTasks()).find((task) => task.setup),
      'the setup Task',
    )
    await sidebar(window).getByRole('button', { name: 'Widgets', exact: true }).click()
    await open(window)
    await form(window).getByLabel('Description', { exact: true }).fill('Keep this unfinished Task')
    await form(window).getByRole('button', { name: 'Open setup Task', exact: true }).click()
    await form(window).waitFor({ state: 'detached', timeout: 5000 })
    await window
      .getByRole('region', { name: 'Task thread' })
      .getByRole('heading', { name: setup.title, exact: true })
      .waitFor()
    expect((await client.taskDraft(factory.id)).draft?.description).toBe(
      'Keep this unfinished Task',
    )
    await open(window)
    expect(await form(window).getByLabel('Description', { exact: true }).inputValue()).toBe(
      'Keep this unfinished Task',
    )
  })

  test('restores the whole form after closing and after an app restart', async () => {
    let window = await setup()
    const client = await daemonClient()
    const blocker = await client.createTask({ factory: 'NB', title: 'Prepare the data' })
    await form(window).getByLabel('Title', { exact: true }).fill('Keep my unfinished Task')
    await form(window)
      .getByLabel('Description', { exact: true })
      .fill('Remember this description.\nAnd this second line.')
    await form(window).getByLabel('Priority', { exact: true }).selectOption('high')
    await form(window).getByLabel('Start now', { exact: true }).uncheck()
    await form(window).getByRole('button', { name: 'Add blocker', exact: true }).click()
    await form(window).getByLabel('Find a Task').fill(blocker.displayId)
    await form(window).getByRole('option').filter({ hasText: blocker.displayId }).click()
    await form(window)
      .getByLabel('Attach files')
      .setInputFiles({
        name: 'draft.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Draft file'),
      })
    await form(window).getByRole('button', { name: 'Remove draft.txt' }).waitFor()
    await form(window).getByRole('button', { name: /^More/ }).click()
    await form(window)
      .getByRole('radiogroup', { name: 'Clarify depth' })
      .getByText('Few', { exact: true })
      .click()
    await form(window).getByLabel('Agent', { exact: true }).selectOption('codex')
    await form(window).getByLabel('Effort', { exact: true }).selectOption('high')
    await window.keyboard.press('Escape')
    await form(window).waitFor({ state: 'detached' })
    await open(window)
    expect(await form(window).getByLabel('Title', { exact: true }).inputValue()).toBe(
      'Keep my unfinished Task',
    )
    expect(await form(window).getByLabel('Start now', { exact: true }).isChecked()).toBe(false)
    await closeApp(ctx.app)
    ctx.app = undefined
    window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'notebook', exact: true }).click()
    await open(window)
    expect(await form(window).getByLabel('Title', { exact: true }).inputValue()).toBe(
      'Keep my unfinished Task',
    )
    expect(await form(window).getByLabel('Description', { exact: true }).inputValue()).toContain(
      'And this second line.',
    )
    expect(await form(window).getByLabel('Priority', { exact: true }).inputValue()).toBe('high')
    expect(await form(window).getByLabel('Agent', { exact: true }).inputValue()).toBe('codex')
    expect(await form(window).getByLabel('Effort', { exact: true }).inputValue()).toBe('high')
    expect(await form(window).getByRole('radio', { name: 'Few', exact: true }).isChecked()).toBe(
      true,
    )
    await form(window).getByRole('button', { name: 'Remove draft.txt' }).waitFor()
    await form(window)
      .getByRole('button', { name: `Remove ${blocker.displayId}` })
      .waitFor()
    if (process.env.TED_DRAFT_SCREENSHOT) {
      const file = path.resolve(process.env.TED_DRAFT_SCREENSHOT)
      await mkdir(path.dirname(file), { recursive: true })
      await window.screenshot({ path: file })
    }
  })

  test('switches independent Factory drafts and clears only the submitted draft with Create more and Create', async () => {
    const window = await setup()
    const client = await daemonClient()
    const factories = await client.listFactories()
    const first = factories.find((f) => f.key === 'NB')
    const second = factories.find((f) => f.key === 'MS')
    if (!first || !second) throw new Error('missing Factory')
    await form(window).getByLabel('Description', { exact: true }).fill('Notebook draft')
    await form(window).getByLabel('Factory', { exact: true }).selectOption(second.id)
    await waitFor(() => form(window).getByLabel('Description', { exact: true }).isEnabled())
    expect(await form(window).getByLabel('Description', { exact: true }).inputValue()).toBe('')
    await form(window).getByLabel('Description', { exact: true }).fill('Site draft')
    await form(window).getByLabel('Start now', { exact: true }).uncheck()
    await form(window).getByLabel('Factory', { exact: true }).selectOption(first.id)
    await waitFor(
      async () =>
        (await form(window).getByLabel('Description', { exact: true }).inputValue()) ===
        'Notebook draft',
    )
    await form(window).getByLabel('Start now', { exact: true }).uncheck()
    await form(window).getByRole('button', { name: 'Create more', exact: true }).click()
    await waitFor(
      async () =>
        (await form(window).getByLabel('Description', { exact: true }).inputValue()) === '',
    )
    expect((await client.taskDraft(first.id)).draft).toBeNull()
    await waitFor(() =>
      form(window)
        .getByLabel('Description', { exact: true })
        .evaluate((field) => field === document.activeElement),
    )
    expect((await client.taskDraft(second.id)).draft?.description).toBe('Site draft')
    await form(window).getByLabel('Factory', { exact: true }).selectOption(second.id)
    await waitFor(
      async () =>
        (await form(window).getByLabel('Description', { exact: true }).inputValue()) ===
        'Site draft',
    )
    await form(window).getByRole('button', { name: 'Create', exact: true }).click()
    await form(window).waitFor({ state: 'detached' })
    expect((await client.taskDraft(second.id)).draft).toBeNull()
    expect((await client.listTasks()).some((t) => t.description === 'Site draft')).toBe(true)
  })

  test('waits for incomplete startup health and keeps an available lead after Create more', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, {
      '.ted/workflow.yaml':
        'version: 1\nlead: { agent: claude }\nstages:\n  intake: { effort: high }\n',
    })
    await addFactory(origin, 'NB')
    let window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets', exact: true }).click()
    await open(window)
    await form(window)
      .getByLabel('Description', { exact: true })
      .fill('Keep my Task when the installed agents change')
    await form(window).getByLabel('Start now', { exact: true }).uncheck()
    await form(window).getByRole('button', { name: /^More/ }).click()
    await form(window).getByLabel('Agent', { exact: true }).selectOption('claude')
    await window.keyboard.press('Escape')
    await form(window).waitFor({ state: 'detached' })
    await closeApp(ctx.app)
    ctx.app = undefined
    await stopDaemonIn(ctx.home)
    ctx.extraEnv.TED_CLAUDE_BIN = path.join(ctx.home, 'uninstalled-claude')
    const release = path.join(ctx.home, 'release-codex-health')
    const delayedCodex = path.join(ctx.home, 'delayed-codex.mjs')
    await writeFile(
      delayedCodex,
      `#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
if (process.argv[2] === '--version') while (!existsSync(${JSON.stringify(release)})) await sleep(25)
await import(${JSON.stringify(pathToFileURL(stubCodexPath).href)})
`,
      { mode: 0o755 },
    )
    ctx.extraEnv.TED_CODEX_BIN = delayedCodex
    window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets', exact: true }).click()
    const restarted = await daemonClient()
    await waitUntil(async () => {
      const health = await restarted.agentHealth()
      return (
        health.some((entry) => entry.agent === 'claude' && entry.state === 'not-installed') &&
        !health.some((entry) => entry.agent === 'codex')
      )
    }, 'partial startup health')
    await window.keyboard.press('Meta+N')
    await form(window).waitFor()
    expect(
      await form(window).getByRole('button', { name: 'Create', exact: true }).isDisabled(),
    ).toBe(true)
    await writeFile(release, 'ready')
    await form(window)
      .getByRole('status')
      .filter({ hasText: 'Task Lead changed to Codex' })
      .waitFor()
    expect(await form(window).getByLabel('Agent', { exact: true }).inputValue()).toBe('codex')
    expect(await form(window).getByLabel('Effort', { exact: true }).inputValue()).toBe('stage')
    await window.keyboard.press('Escape')
    await form(window).waitFor({ state: 'detached' })
    await open(window)
    expect(await form(window).getByLabel('Agent', { exact: true }).inputValue()).toBe('codex')
    expect(await form(window).getByLabel('Effort', { exact: true }).inputValue()).toBe('stage')
    expect(await form(window).getByRole('status').count()).toBe(0)
    await form(window).getByRole('button', { name: 'Create more', exact: true }).click()
    await waitFor(
      async () =>
        (await form(window).getByLabel('Description', { exact: true }).inputValue()) === '',
    )
    await form(window)
      .getByLabel('Description', { exact: true })
      .fill('Another Task after Create more')
    await form(window).getByLabel('Start now', { exact: true }).uncheck()
    await form(window).getByRole('button', { name: /^More/ }).click()
    expect(await form(window).getByLabel('Agent', { exact: true }).inputValue()).toBe('codex')
    expect(await form(window).getByLabel('Effort', { exact: true }).inputValue()).toBe('stage')
    expect(
      await form(window).getByRole('button', { name: 'Create', exact: true }).isEnabled(),
    ).toBe(true)
    await form(window).getByRole('button', { name: 'Create', exact: true }).click()
    await form(window).waitFor({ state: 'detached' })
    const task = (await (await daemonClient()).listTasks()).find(
      (task) => task.description === 'Keep my Task when the installed agents change',
    )
    expect(task?.lead).toMatchObject({ agent: 'codex', effortMode: 'stage' })
    expect(
      (await restarted.listTasks()).find(
        (task) => task.description === 'Another Task after Create more',
      )?.lead,
    ).toMatchObject({ agent: 'codex', effortMode: 'stage' })
    if (!task) throw new Error('Created Task missing')
    await restarted.startTask(task.displayId)
    await waitUntil(async () => {
      const current = (await restarted.listTasks()).find((entry) => entry.id === task.id)
      if (!current?.leadRunId) return false
      return (await restarted.getRun(current.leadRunId)).run.effort === 'high'
    }, 'fallback Task Lead to use the configured Intake effort')
    await restarted.stopTask(task.displayId)
  })

  test('a removed Linear source stays dismissed on reopening', async () => {
    const window = await setup()
    const client = await daemonClient()
    await form(window)
      .getByLabel('Description', { exact: true })
      .fill('https://linear.app/kriyadesign/issue/KRI-229')
    await form(window).getByRole('button', { name: 'Remove source' }).click()
    await form(window).getByLabel('Start now', { exact: true }).uncheck()
    const factory = (await client.listFactories()).find((f) => f.key === 'NB')
    if (!factory) throw new Error('no Factory')
    const blocker = await client.createTask({ factory: 'NB', title: 'Temporary blocker' })
    await form(window).getByRole('button', { name: 'Add blocker', exact: true }).click()
    await form(window).getByLabel('Find a Task').fill(blocker.displayId)
    await form(window).getByRole('option').filter({ hasText: blocker.displayId }).click()
    await window.keyboard.press('Escape')
    await form(window).waitFor({ state: 'detached' })
    await open(window)
    expect(await form(window).getByRole('button', { name: 'Remove source' }).count()).toBe(0)
    await form(window).getByRole('button', { name: 'Close', exact: true }).click()
    await form(window).waitFor({ state: 'detached' })
    await waitUntil(async () => (await client.taskDraft(factory.id)).draft, 'saved draft')
  })
})
