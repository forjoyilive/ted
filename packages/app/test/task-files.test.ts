import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import {
  commitToOrigin,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { firstWindow } from './first-window.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
vi.setConfig({ testTimeout: 90_000 })
let home: string
let app: ElectronApplication | undefined
beforeAll(async () => {
  await buildRenderer()
})
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-files-'))
})
afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await removeHome(home)
}, 30_000)

test('browse and quick open inspect unchanged files, open the editor and leave Changes as diffs', async () => {
  const parent = path.join(home, 'origin')
  const origin = await makeOriginRepo(parent)
  await commitToOrigin(parent, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    '.gitignore': 'stub-*\n',
    'src/hello.ts': 'export const greeting = "Hello from the Task worktree"\n',
  })
  const bin = path.join(home, 'bin')
  const log = path.join(home, 'editor.log')
  await mkdir(bin)
  await writeFile(path.join(bin, 'code'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, {
    mode: 0o755,
  })
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    TED_HOME: home,
    TED_IDLE_EXIT_MS: '30000',
    TED_CLAUDE_BIN: stubClaudePath,
    TED_HIDDEN_WINDOW: '1',
  }
  const daemon = await daemonAsApp(home, env)
  await daemon.updateSettings({ editor: 'code' })
  await daemon.addFactory({ repo: origin, key: 'NB' })
  const task = await daemon.createTask({
    factory: 'NB',
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  await daemon.startTask(task.id)
  const worktree = await waitUntil(
    async () => (await daemon.listTasks()).find((t) => t.id === task.id)?.repos[0]?.worktree,
    'worktree',
  )
  await writeFile(path.join(worktree, 'README.md'), '# widgets\nA changed readme\n')
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env })
  const window = await firstWindow(app)
  await window.setViewportSize({ width: 1440, height: 1000 })
  const nav = window.getByRole('navigation', { name: 'Sidebar' })
  await nav.getByRole('button', { name: 'All Tasks' }).click()
  await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
  const files = window.getByRole('region', { name: 'Files', exact: true })
  await files.getByText('src', { exact: true }).click()
  await files.getByRole('button', { name: 'hello.ts', exact: true }).click()
  const viewer = window.getByRole('region', { name: 'File contents' })
  await expect
    .poll(() => viewer.locator('pre').textContent())
    .toContain('export const greeting = "Hello from the Task worktree"')
  if (process.env.TED_FILES_SCREENSHOTS) {
    await mkdir(process.env.TED_FILES_SCREENSHOTS, { recursive: true })
    await window.screenshot({
      path: path.join(process.env.TED_FILES_SCREENSHOTS, 'files-implemented.png'),
    })
  }
  await viewer.getByRole('button', { name: 'Open in editor' }).click()
  await expect.poll(async () => readFile(log, 'utf8').catch(() => '')).toContain('src/hello.ts:1:1')
  await files.getByRole('button', { name: 'Quick open' }).click()
  const quick = window.getByRole('dialog', { name: 'Quick open' })
  await quick.getByRole('combobox').fill('src/hello')
  await quick.getByRole('option').waitFor()
  if (process.env.TED_FILES_SCREENSHOTS)
    await window.screenshot({
      path: path.join(process.env.TED_FILES_SCREENSHOTS, 'quick-open-implemented.png'),
    })
  await quick.getByRole('combobox').press('Enter')
  await expect.poll(() => quick.count()).toBe(0)
  await viewer.getByRole('button', { name: '← Thread' }).click()
  await window.getByRole('region', { name: 'Task thread' }).waitFor()
  const changes = window.getByRole('region', { name: 'Changes', exact: true })
  await changes.getByRole('button', { name: /^README.md/ }).click()
  await window.getByRole('region', { name: 'Diff', exact: true }).waitFor()
})
