import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Comment, RunSummary, Task, TaskBrief, TaskPullRequest, TaskRepo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import {
  briefLines,
  briefPart,
  briefSummary,
  briefUpdatedLine,
  codeSummary,
  runsCollapsedSummary,
} from '../src/renderer/details.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { firstWindow } from './first-window.ts'

const now = Date.parse('2026-11-09T12:00:00Z')
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString()

const briefText = [
  '## Goal\n\nStop the TypeError in SearchPanel.',
  '## Decisions so far\n\n- Guard in SearchPanel.\n- Empty list for an empty query.',
  '## Current state\n\nBoth pull requests open.',
  '## Open questions\n\nNone.',
  '## Next step\n\nYour sign-off.\n',
].join('\n\n')

const brief = (stage: TaskBrief['stage'], at: string): TaskBrief => ({
  taskId: 't1',
  version: 1,
  text: briefText,
  stage,
  createdAt: at,
})

const comment = (fields: Partial<Comment>): Comment => ({
  id: 'c1',
  taskId: 't1',
  kind: 'note',
  body: '',
  author: { kind: 'human' },
  createdAt: minutesAgo(0),
  ...fields,
})

const run = (fields: Partial<RunSummary>): RunSummary => ({
  id: 'r1',
  name: 'Task Lead',
  role: 'lead',
  agent: 'claude',
  state: 'idle',
  startedAt: minutesAgo(60),
  current: true,
  ...fields,
})

const repo = (fields: Partial<TaskRepo>): TaskRepo =>
  ({
    name: 'widgets',
    repo: 'acme/widgets',
    branch: 'nb-1-fix',
    worktree: '/w',
    ...fields,
  }) as TaskRepo

describe('Task details summaries', () => {
  test('the brief’s parts come from its fixed headings', () => {
    expect(briefPart(briefText, 'Goal')).toBe('Stop the TypeError in SearchPanel.')
    expect(briefPart(briefText, 'Next step')).toBe('Your sign-off.')
    expect(briefPart('## Goal\n\n', 'Next step')).toBeUndefined()
    expect(briefLines('- Guard in SearchPanel.\n* Empty list.\nPlain')).toEqual([
      '• Guard in SearchPanel.',
      '• Empty list.',
      'Plain',
    ])
  })

  test('a brief written just before a Gate request says it was at that Gate', () => {
    const written = brief('review', minutesAgo(31))
    const gate = comment({
      kind: 'signoff',
      stage: 'review',
      createdAt: minutesAgo(30),
      gate: { approveLabel: 'Approve' },
    })
    expect(briefUpdatedLine(written, [gate], now)).toBe(
      'Updated by the Task Lead at the Review Gate · 31m ago',
    )
    expect(briefUpdatedLine(written, [], now)).toBe('Updated by the Task Lead in Review · 31m ago')
    const earlier = { ...gate, createdAt: minutesAgo(40) }
    expect(briefUpdatedLine(written, [earlier], now)).toBe(
      'Updated by the Task Lead in Review · 31m ago',
    )
    expect(briefSummary(written, now)).toBe('updated 31m ago')
    expect(briefSummary(null, now)).toBe('not written yet')
  })

  test('Runs collapse to the Task Lead’s state, live sub-agents and stopped Runs', () => {
    expect(
      runsCollapsedSummary([
        run({}),
        run({ id: 'r2', state: 'finished' }),
        run({ id: 'r3', state: 'finished', role: 'sub-agent' }),
        run({ id: 'r4', state: 'finished' }),
      ]),
    ).toBe('Task Lead idle · 3 stopped')
    expect(
      runsCollapsedSummary([
        run({ state: 'working', onSubAgents: true }),
        run({ id: 'r2', role: 'sub-agent', parentRunId: 'r1', state: 'working' }),
      ]),
    ).toBe('Task Lead on sub-agents · 1 sub-agent')
    expect(runsCollapsedSummary([run({ state: 'finished' })])).toBe('1 stopped')
  })

  test('Code collapses to the pull request, the branch or the repo count', () => {
    const task = (repos: TaskRepo[]) => ({ repos }) as unknown as Task
    expect(codeSummary(task([]))).toBe('no worktree yet')
    expect(codeSummary(task([repo({})]))).toBe('nb-1-fix')
    expect(
      codeSummary(
        task([repo({ pullRequest: { number: 482, state: 'draft' } as TaskPullRequest })]),
      ),
    ).toBe('PR #482 · draft')
    expect(codeSummary(task([repo({}), repo({ name: 'api' })]))).toBe('2 repos')
    expect(codeSummary(task([repo({ removed: { at: minutesAgo(5) } })]))).toBe('worktree removed')
  })
})

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)

describe('Task details in the app', () => {
  vi.setConfig({ testTimeout: 90_000 })
  let home: string
  let app: ElectronApplication | undefined

  beforeAll(async () => {
    await buildRenderer()
  })

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'ted-app-details-'))
  })

  afterEach(async () => {
    await closeApp(app)
    app = undefined
    await stopDaemonIn(home)
    await removeHome(home)
  }, 30_000)

  const env = () => ({
    ...process.env,
    TED_HOME: home,
    TED_IDLE_EXIT_MS: '30000',
    TED_CLAUDE_BIN: stubClaudePath,
    TED_HIDDEN_WINDOW: '1',
  })

  async function launch(): Promise<Page> {
    app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await firstWindow(app)
    await window.emulateMedia({ colorScheme: null })
    const sidebar = window.getByRole('navigation', { name: 'Sidebar' })
    await sidebar.waitFor()
    await sidebar.getByRole('button', { name: 'All Tasks' }).click()
    await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
    await window.getByRole('region', { name: 'Task thread' }).waitFor()
    return window
  }

  async function taskAtDesignGate() {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const briefFile = path.join(home, 'brief.md')
    await writeFile(briefFile, briefText)
    const gate = [
      { run: ['ted', 'brief', 'write', '--file', briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    const daemon = await daemonAsApp(home, env())
    await daemon.addFactory({ repo: origin, key: 'NB' })
    const task = await daemon.createTask({
      factory: 'NB',
      title: JSON.stringify({ steps: [{ everyMessage: gate }, ...gate] }),
    })
    await daemon.startTask(task.id)
    await waitUntil(
      async () => (await daemon.listInbox()).some((i) => i.request.kind === 'review') || undefined,
      'the Design review',
    )
    return { daemon, task }
  }

  test('Task Gates edit, cancel, reset and refresh stale choices while a posted Gate stays locked', async () => {
    const { daemon, task } = await taskAtDesignGate()
    const window = await launch()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: 'Use Workflow · Edit' }).click()
    let editor = details.getByRole('region', { name: 'Gates for this Task' })
    await expect(editor.getByLabel('Design', { exact: false }).isDisabled()).resolves.toBe(true)
    const review = () => editor.locator(`select[id="gate-${task.id}-review"]`)
    await review().selectOption('off')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await daemon.taskGates(task.id)).overrides).toEqual({})
    await details.getByRole('button', { name: 'Use Workflow · Edit' }).click()
    await review().selectOption('off')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await details.getByRole('button', { name: '1 overridden · Edit' }).waitFor()
    expect((await daemon.taskGates(task.id)).overrides).toEqual({ review: false })
    await details.getByRole('button', { name: '1 overridden · Edit' }).click()
    const current = await daemon.taskGates(task.id)
    await daemon.setTaskGates(task.id, { overrides: { review: true }, revision: current.revision })
    await editor.getByText('The Task or Workflow changed. Reload Gates before saving.').waitFor()
    await expect(
      editor.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
    ).resolves.toBe(true)
    await editor.getByRole('button', { name: 'Reload Gates' }).click()
    await expect.poll(() => review().inputValue()).toBe('on')
    await editor.getByRole('button', { name: 'Use Workflow', exact: true }).click()
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await details.getByRole('button', { name: 'Use Workflow · Edit' }).waitFor()
    expect((await daemon.taskGates(task.id)).overrides).toEqual({})
    await details.getByRole('button', { name: 'Use Workflow · Edit' }).click()
    editor = details.getByRole('region', { name: 'Gates for this Task' })
    await editor.waitFor()
    if (process.env.TED_GATE_SCREENSHOT) {
      await daemon.editTask(task.id, { title: 'Let notes be edited offline.' })
      if (app)
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.setSize(1400, 1050),
        )
      await window.getByRole('heading', { name: 'Let notes be edited offline.' }).waitFor()
      await details.evaluate((element) => {
        element.scrollTop = 0
      })
      await window.screenshot({ path: process.env.TED_GATE_SCREENSHOT })
    }
  })

  test('a required Gate displays On while retaining a previously saved Off choice', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const daemon = await daemonAsApp(home, env())
    await daemon.addFactory({ repo: origin, key: 'NB' })
    const task = await daemon.createTask({
      factory: 'NB',
      title: 'Choose the Clarify Gate',
      clarifyDepth: 'few',
    })
    const before = await daemon.taskGates(task.id)
    await daemon.setTaskGates(task.id, { overrides: { clarify: false }, revision: before.revision })
    const window = await launch()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: '1 overridden · Edit' }).click()
    const editor = details.getByRole('region', { name: 'Gates for this Task' })
    const clarify = editor.getByLabel('Clarify', { exact: true })
    await expect(clarify.inputValue()).resolves.toBe('off')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await daemon.setClarifyDepth(task.id, { depth: 'grilling' })
    await details.getByRole('button', { name: '1 overridden · Edit' }).click()
    await expect(clarify.inputValue()).resolves.toBe('required')
    await expect(clarify.isDisabled()).resolves.toBe(true)
    await editor.getByText('Required at grilling depth', { exact: true }).waitFor()
    await editor.getByText('Your Off choice applies when this Gate is optional.').waitFor()
    expect((await daemon.taskGates(task.id)).overrides.clarify).toBe(false)
    if (process.env.TED_REQUIRED_GATE_SCREENSHOT) {
      if (app)
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.setSize(1400, 1050),
        )
      for (const theme of ['light', 'dark'] as const) {
        await window.emulateMedia({ colorScheme: theme })
        await window.evaluate((mode) => {
          document.documentElement.style.colorScheme = mode
        }, theme)
        await editor.scrollIntoViewIfNeeded()
        await window.screenshot({
          path: `${process.env.TED_REQUIRED_GATE_SCREENSHOT}-${theme}.png`,
        })
      }
    }
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await daemon.setClarifyDepth(task.id, { depth: 'few' })
    await details.getByRole('button', { name: '1 overridden · Edit' }).click()
    await expect(clarify.inputValue()).resolves.toBe('off')
    await expect(clarify.isDisabled()).resolves.toBe(false)
  })

  test('sections run in order, collapse to a summary line and stay collapsed after a restart', async () => {
    await taskAtDesignGate()
    let window = await launch()
    const details = window.getByRole('complementary', { name: 'Task details' })
    const brief = details.getByRole('region', { name: 'Task brief' })
    await brief.getByText('Goal: Stop the TypeError in SearchPanel.').waitFor()
    await brief.getByText('Next step: Your sign-off.').waitFor()
    await expect
      .poll(() => details.getByRole('region').evaluateAll((els) => els.map((e) => e.ariaLabel)))
      .toEqual(['Code', 'Changes', 'Runs', 'Task brief'])

    const runs = details.getByRole('region', { name: 'Runs' })
    await runs.getByRole('button', { name: /^Runs/ }).click()
    await runs.getByRole('heading', { name: /^Runs · Task Lead (idle|working)/ }).waitFor()
    await runs.getByRole('list').waitFor({ state: 'detached' })
    await expect(
      runs.getByRole('button', { name: /^Runs/ }).getAttribute('aria-expanded'),
    ).resolves.toBe('false')

    await closeApp(app)
    window = await launch()
    const again = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Runs' })
    await again.getByRole('heading', { name: /^Runs · / }).waitFor()
    await expect(
      again.getByRole('button', { name: /^Runs/ }).getAttribute('aria-expanded'),
    ).resolves.toBe('false')
    await again.getByRole('button', { name: /^Runs/ }).click()
    await again.getByRole('heading', { name: /^Runs · \d+ Runs?/ }).waitFor()
  })

  test('Full brief opens in the middle pane with who updated it and when; ← Thread returns', async () => {
    await taskAtDesignGate()
    const window = await launch()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: 'Full brief' }).click()

    const full = window.getByRole('region', { name: 'Full brief' })
    await full.getByText('Updated by the Task Lead at the Design Gate · just now').waitFor()
    await expect
      .poll(() => full.getByRole('heading', { level: 3 }).allTextContents())
      .toEqual(['Goal', 'Decisions so far', 'Current state', 'Open questions', 'Next step'])
    await full.getByText('• Guard in SearchPanel.').waitFor()
    await expect(window.getByRole('region', { name: 'Task thread' }).isVisible()).resolves.toBe(
      false,
    )

    await full.getByRole('button', { name: '← Thread' }).click()
    await full.waitFor({ state: 'detached' })
    await window.getByRole('region', { name: 'Task thread' }).waitFor()
  })
})
