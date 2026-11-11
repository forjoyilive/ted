import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { commitToOrigin, makeOriginRepo, waitUntil } from '../../daemon/test/helpers.ts'
import {
  ctx,
  daemonClient,
  githubReady,
  launchApp,
  openAllTasks,
  setUpAppTests,
  taskRow,
} from './app-harness.ts'

setUpAppTests()

describe('setup Tasks', () => {
  test('the setup Task shows its Setup chip, its note, Tutorial Comments and the proposal card', async () => {
    const parent = path.join(ctx.home, 'origin')
    await makeOriginRepo(parent)
    await commitToOrigin(parent, { '.ted/workflow.yaml': 'version: 1\n' })
    await githubReady(['acme/widgets'])
    const files = path.join(ctx.home, 'setup')
    await mkdir(files)
    const at = (name: string) => path.join(files, name)
    await writeFile(
      at('brief.md'),
      '## Goal\n\nSet up Widgets\n\n## Decisions so far\n\nNone.\n\n## Current state\n\nRead.\n\n## Open questions\n\nNone.\n\n## Next step\n\nPropose.\n',
    )
    await writeFile(
      at('design.json'),
      JSON.stringify({
        title: 'Proposed setup for Widgets',
        summary:
          'One repo with an npm test script. I ran each Check on main; one fails there, so I left it off.',
        setup: {
          workflow: [
            { stage: 'intake' },
            { stage: 'clarify', setting: 'Depth: Auto' },
            { stage: 'design', setting: 'Sign-off on' },
            { stage: 'validate', setting: 'Send back at most 5 times · validate.md for Widgets' },
          ],
          checks: [
            {
              name: 'Unit tests',
              command: 'npm test',
              repo: 'widgets',
              passed: true,
              durationMs: 112000,
            },
            {
              name: 'End-to-end',
              command: 'npm run test:e2e',
              repo: 'widgets',
              passed: false,
              durationMs: 40000,
              reason: 'Fails on main: needs the API running',
            },
          ],
          apps: [
            {
              name: 'Web',
              repo: 'widgets',
              kind: 'web',
              run: 'npm run dev',
              ready: 'ready in 9s at localhost:5174',
              passed: true,
            },
          ],
          files: [
            {
              path: '.ted/notes.md',
              about: 'Factory notes: product, running locally, conventions',
            },
            { path: '.ted/workflow.yaml', about: 'Checks, Apps and Stage settings' },
            { path: '.ted/stages/validate.md', about: 'Start Web, sign in, check the main flow' },
          ],
          defaults: 'Left as TED’s defaults: agents, permissions Auto, 6 working Runs.',
        },
      }),
    )
    const each = [
      { run: ['ted', 'comment', '--tutorial', 'Design is where the Task Lead writes the plan.'] },
      { run: ['ted', 'brief', 'write', '--file', at('brief.md')] },
      { run: ['ted', 'outcome', 'advance', '--design', at('design.json')] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    const window = await launchApp()
    const client = await daemonClient()
    await client.createFactory({
      name: 'Widgets',
      key: 'WD',
      repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
      showTutorial: true,
    })
    const setup = await waitUntil(
      async () => (await client.listTasks()).find((t) => t.setup),
      'the setup Task',
    )
    await client.editTask(setup.id, {
      title: JSON.stringify({ steps: [{ everyMessage: each }, ...each] }),
    })
    await client.startTask(setup.id)
    const clarify = await waitUntil(
      async () => (await client.listInbox()).find((i) => i.request.stage === 'clarify'),
      'the Clarify sign-off',
    )
    await client.answerRequest(clarify.request.id, { action: 'approve' })

    await openAllTasks(window)
    await taskRow(window, 'WD-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText(/WD-1\s+·\s+Created by TED/).waitFor()
    await thread.getByText('Setup', { exact: true }).waitFor()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details
      .getByText(
        'The Design and Review sign-offs are always on for a setup Task. Tasks started before it merges use TED’s defaults.',
      )
      .waitFor()
    await expect(details.locator(':scope > *').first().textContent()).resolves.toContain(
      'always on for a setup Task',
    )
    await thread.getByText('Tutorial', { exact: true }).first().waitFor()

    const card = thread.getByRole('region', { name: 'Design review' })
    await card.waitFor({ timeout: 40_000 })
    await card.getByRole('heading', { name: 'Proposed setup for Widgets' }).waitFor()
    const workflow = card.getByRole('region', { name: 'Workflow' })
    await workflow.getByText('As TED’s default').waitFor()
    await workflow.getByText('Send back at most 5 times · validate.md for Widgets').waitFor()
    const checks = card.getByRole('region', { name: 'Checks · tried on main' })
    expect(await checks.getByRole('listitem').allTextContents()).toEqual([
      '✓Unit testsnpm testwidgets1m 52s',
      '✕End-to-endnpm run test:e2ewidgetsFails on main: needs the API running · left off',
    ])
    const apps = card.getByRole('region', { name: 'Apps · started on main' })
    await apps.getByText('web · ready in 9s at localhost:5174').waitFor()
    await apps.getByText('npm run dev', { exact: true }).waitFor()
    const written = card.getByRole('region', { name: 'Files it will write' })
    expect(await written.getByRole('listitem').count()).toBe(3)
    await card
      .getByText('Left as TED’s defaults: agents, permissions Auto, 6 working Runs.')
      .waitFor()
    await card.getByRole('button', { name: 'Approve' }).waitFor()
    await thread.getByText('TED created this Task to set up this Factory').waitFor()
  }, 90_000)
})
