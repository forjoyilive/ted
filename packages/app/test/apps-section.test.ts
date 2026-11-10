import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import {
  commitToOrigin,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const stubApp = fileURLToPath(new URL('../../daemon/test/fixtures/stub-app.ts', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string
const run = promisify(execFile)

vi.setConfig({ testTimeout: 90_000 })

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-'))
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

const ted = (...args: string[]) => run(process.execPath, [cliPath, ...args], { env: env() })

async function launchApp(): Promise<Page> {
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await app.firstWindow()
  await window.getByRole('navigation', { name: 'Sidebar' }).waitFor()
  return window
}

test('the Apps section runs a Web App, shows its log in the middle pane, and stops it', async () => {
  const scratch = path.join(home, 'origin')
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '    apps:',
      '      - name: Web',
      `        run: "'${process.execPath}' '${stubApp}'"`,
      '      - name: API',
      '        kind: command',
      `        run: "'${process.execPath}' '${stubApp}'"`,
      '',
    ].join('\n'),
  })
  const marker = path.join(home, 'go')
  const client = await daemonAsApp(home, env())
  await client.addFactory({ repo: origin, key: 'NB' })
  await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ waitFor: marker }] }))
  await ted('task', 'start', 'NB-1')
  const window = await launchApp()
  await window
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'All Tasks' })
    .click()
  await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
  const section = window
    .getByRole('complementary', { name: 'Task details' })
    .getByRole('region', { name: 'Apps' })
  await section.getByText('Not running').first().waitFor()

  await section.getByRole('button', { name: 'Run Web' }).click()
  const confirm = window.getByRole('dialog', { name: 'Run Web outside the sandbox?' })
  await confirm.getByText(/runs code from the Task’s branch on your Mac/).waitFor()
  await confirm.getByRole('button', { name: 'Run' }).click()

  const status = section.getByText(/^localhost:\d+$/)
  await status.waitFor()
  await section.getByText('Apps · 1 running').waitFor()
  const port = (await status.textContent())?.split(':')[1]
  await section.getByRole('button', { name: /^Web/ }).click()
  const log = window.getByRole('region', { name: 'Web log' })
  await log.getByText(`stub app listening on ${port}`).waitFor()
  await log.getByText(`Running · localhost:${port}`).waitFor()
  await log.getByRole('button', { name: 'Stop' }).click()
  await log.getByRole('button', { name: 'Run' }).waitFor()
  await log.getByRole('button', { name: '← Thread' }).click()
  const thread = window.getByRole('region', { name: 'Task thread' })
  await thread.getByText(`You started Web · localhost:${port}`).waitFor()
  await thread.getByText('You stopped Web').waitFor()
  expect(await section.getByText(/^Stopped/).count()).toBe(1)
  await writeFile(marker, '')
}, 90_000)

test('the sign-off’s Preview row opens a command App after one confirmation, then remembers it', async () => {
  const scratch = path.join(home, 'origin')
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.gitignore': 'stub-*\nn\nbrief.md\n',
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, review]',
      'repos:',
      '  - name: widgets',
      '    apps:',
      '      - name: Desk',
      '        kind: command',
      `        run: "'${process.execPath}' '${stubApp}'"`,
      '',
    ].join('\n'),
  })
  const brief = [
    '## Goal',
    'Export works.',
    '## Decisions so far',
    'None.',
    '## Current state',
    'Done.',
    '## Open questions',
    'None.',
    '## Next step',
    'Merge.',
  ].join('\n\n')
  const script = [
    'n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n;',
    'case $n in',
    '2) echo x > work.txt; ted outcome advance;;',
    `3) printf '%s' '${brief}' > brief.md; ted brief write --file brief.md; ted outcome advance;;`,
    '[4-9]) :;;',
    '*) ted outcome advance;;',
    'esac',
  ].join(' ')
  const step = { run: ['sh', '-c', script] }
  const client = await daemonAsApp(home, env())
  const factory = await client.addFactory({ repo: origin, key: 'NB' })
  await ted(
    'task',
    'create',
    '--factory',
    'NB',
    JSON.stringify({ steps: [{ everyMessage: [step, { endTurn: true }] }, step] }),
  )
  await ted('task', 'start', 'NB-1')
  const window = await launchApp()
  await window
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'All Tasks' })
    .click()
  await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
  const card = window.getByRole('region', { name: 'Task thread' }).getByRole('region', {
    name: 'Sign-off',
  })
  await card.waitFor({ timeout: 60_000 })
  await card.getByText('Desk isn’t running').waitFor()

  await card.getByRole('button', { name: 'Open Desk' }).click()
  const confirm = window.getByRole('dialog', { name: 'Run Desk outside the sandbox?' })
  await confirm.getByRole('checkbox', { name: 'Always for Desk in this Factory' }).check()
  await confirm.getByRole('button', { name: 'Run' }).click()

  await card.getByRole('button', { name: 'Running' }).waitFor()
  expect((await client.getSettings()).appsOutsideSandbox[factory.id]).toEqual(['Desk'])
  const section = window
    .getByRole('complementary', { name: 'Task details' })
    .getByRole('region', { name: 'Apps' })
  await section.getByRole('button', { name: 'Stop Desk' }).click()
  await card.getByRole('button', { name: 'Open Desk' }).waitFor()
  await section.getByRole('button', { name: 'Run Desk' }).click()
  await card.getByRole('button', { name: 'Running' }).waitFor()
  expect(await window.getByRole('dialog').count()).toBe(0)
}, 120_000)
