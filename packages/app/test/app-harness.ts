import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, vi } from 'vitest'
import {
  appClient,
  daemonAsApp,
  hostRecords,
  makeOriginRepo,
  removeHome,
  spawnDaemonProcess,
  stopDaemonIn,
  stubCodexPath,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { observeStartup } from './startup-evidence.ts'
import { resolveElectron } from './support/electron-installation.ts'

export const appDir = fileURLToPath(new URL('..', import.meta.url))
export const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
export const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
export const electronPath = resolveElectron()
export const run = promisify(execFile)

export const ctx: {
  home: string
  app: ElectronApplication | undefined
  extraEnv: Record<string, string>
} = { home: '', app: undefined, extraEnv: {} }

export function setUpAppTests(): void {
  vi.setConfig({ testTimeout: 90_000 })

  beforeAll(async () => {
    await buildRenderer()
  })

  beforeEach(async () => {
    ctx.home = await mkdtemp(path.join(tmpdir(), 'ted-app-'))
    ctx.extraEnv = {}
  })

  afterEach(async () => {
    await closeApp(ctx.app)
    ctx.app = undefined
    await stopDaemonIn(ctx.home)
    await removeHome(ctx.home)
  }, 30_000)
}

export const env = () => ({
  ...process.env,
  TED_HOME: ctx.home,
  TED_IDLE_EXIT_MS: '30000',
  TED_CLAUDE_BIN: stubClaudePath,
  TED_CODEX_BIN: stubCodexPath,
  TED_ANTIGRAVITY_BIN: path.join(ctx.home, 'no-antigravity-here'),
  TED_HIDDEN_WINDOW: '1',
  ...ctx.extraEnv,
})

export async function launchApp(more: Record<string, string> = {}): Promise<Page> {
  ctx.app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: { ...env(), ...more },
  })
  observeStartup(ctx.app, more.TED_HOME ?? ctx.home)
  const window = await loadedWindow(ctx.app)
  await window.emulateMedia({ colorScheme: null })
  return window
}

export const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
export const settingsNav = (window: Page) => window.getByRole('navigation', { name: 'Settings' })

export async function openSettings(window: Page): Promise<void> {
  await sidebar(window)
    .getByRole('button', { name: /^Settings/ })
    .last()
    .click()
  await settingsNav(window).waitFor()
}

export async function openFactoryView(
  window: Page,
  factory: string,
  view: 'Inbox' | 'Agents' | 'Board' | 'List' | 'Automations' | 'Settings',
): Promise<void> {
  const row = sidebar(window).getByRole('article', { name: factory, exact: true })
  const group = row.locator('..')
  if (view === 'Inbox') return row.getByRole('button', { name: factory, exact: true }).click()
  const views = row.getByRole('button', { name: 'Views' })
  if ((await views.getAttribute('aria-expanded')) !== 'true') await views.click()
  if (view === 'Board' || view === 'List') {
    const taskViews = group.getByRole('button', { name: 'Task views' })
    if ((await taskViews.getAttribute('aria-expanded')) === 'false') await taskViews.click()
  }
  await group.getByRole('button', { name: view, exact: true }).click()
}

export const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

export async function openAllTasks(window: Page): Promise<void> {
  await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
}

export const taskRow = (window: Page, text: string) =>
  window.getByRole('row').filter({ hasText: text })

export async function startDaemonAsApp(): Promise<void> {
  await rm(path.join(ctx.home, 'daemon.json'), { force: true })
  spawnDaemonProcess(['--exit-when-idle'], env())
  await waitUntil(() => readDaemonInfo(ctx.home), 'daemon.json')
}

export async function addFactory(repo: string, key: string, localFolder?: string): Promise<void> {
  const app = await daemonAsApp(ctx.home, env())
  await app.addFactory({ repo, key, ...(localFolder !== undefined && { localFolder }) })
}

export async function daemonClient(): Promise<DaemonClient> {
  const info = await readDaemonInfo(ctx.home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, process.env.TED_APP_TOKEN)
}

export const background = (window: Page) =>
  window.evaluate(() => getComputedStyle(document.body).backgroundColor)

export const lightApp = 'rgb(250, 250, 248)'
export const darkApp = 'rgb(22, 22, 21)'

export function ted(...args: string[]) {
  return run(process.execPath, [cliPath, ...args], { env: env() })
}

export async function daemonPid(): Promise<number> {
  const info = await readDaemonInfo(ctx.home)
  if (!info) throw new Error('no daemon.json')
  return info.pid
}

export async function commandOf(pid: number): Promise<string> {
  const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)])
  return stdout.trim()
}

export async function runHostPids(): Promise<number[]> {
  const pids: number[] = []
  for (const id of await readdir(path.join(ctx.home, 'runs')).catch(() => [])) {
    const start = (await hostRecords(ctx.home, id)).find((r) => r.t === 'start')
    for (const pid of [start?.agentPid, start?.hostPid]) if (typeof pid === 'number') pids.push(pid)
  }
  return pids
}

export async function pickFolderWith(folder: string): Promise<void> {
  await ctx.app?.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never
  }, folder)
}

export async function githubReady(
  repos: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const paths: Record<string, unknown> = {}
  for (const repo of repos) {
    paths[`repos/${repo}`] = {
      body: { full_name: repo, default_branch: 'main', permissions: { push: true } },
    }
    paths[`repos/${repo}/commits?per_page=1`] = { body: [] }
  }
  const state = path.join(ctx.home, 'gh.json')
  await writeFile(state, JSON.stringify({ paths: { ...paths, ...extra } }))
  ctx.extraEnv = {
    ...ctx.extraEnv,
    TED_STUB_GH: state,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${path.join(ctx.home, 'origin')}/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  }
}

export async function channelsOf(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const targets = await Promise.all(
    (await readdir(dir)).map((fd) => readlink(path.join(dir, fd)).catch(() => '')),
  )
  return targets.filter((target) => /^(pipe|socket):/.test(target))
}

export async function twoFactories(): Promise<void> {
  for (const [name, key] of [
    ['notebook', 'NB'],
    ['site', 'MS'],
  ] as const) {
    const parent = path.join(ctx.home, 'origins', name)
    const made = await makeOriginRepo(parent)
    const origin = path.join(path.dirname(made), `${name}.git`)
    await rename(made, origin)
    await addFactory(origin, key)
  }
}

export async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await sleep(100)
  }
}

export function blobHash(text: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex')
    .slice(0, 7)
}

export async function writeLibrary(files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(ctx.home, 'library', name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }
}
