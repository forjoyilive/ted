import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type BrowserRequest, readDaemonInfo, tedPaths } from '@ted/protocol'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { loadRunTokens } from '../../daemon/src/run-token.ts'
import {
  commitToOrigin,
  daemonAsApp,
  killAppHosts,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import {
  checkGuestNetwork,
  checkInFlightNavigation,
  checkModalRace,
  guestWorkerTraffic,
  startGuestWorker,
} from './browser-probes.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { firstWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
const stubClaude = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const stubApp = fileURLToPath(new URL('../../daemon/test/fixtures/stub-app.ts', import.meta.url))
const electronPath = resolveElectron()
const exec = promisify(execFile)
let home: string | undefined
let app: ElectronApplication | undefined
vi.setConfig({ testTimeout: 120_000 })
beforeAll(async () => {
  await buildRenderer()
})
afterEach(async () => {
  await closeApp(app)
  if (home) {
    await stopDaemonIn(home)
    await killAppHosts(home)
    await removeHome(home)
  }
}, 30_000)

test('Preview embeds a shared isolated browser; agents click, fill and capture without a debugging port', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-browser-ui-'))
  const env = {
    ...process.env,
    TED_HOME: home,
    TED_CLAUDE_BIN: stubClaude,
    TED_HIDDEN_WINDOW: '1',
    TED_IDLE_EXIT_MS: '30000',
  }
  const originDir = path.join(home, 'origin')
  const origin = await makeOriginRepo(originDir)
  await commitToOrigin(originDir, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '    apps:',
      '      - name: Web',
      `        run: "'${process.execPath}' '${stubApp}'"`,
      '        env:',
      '          STUB_APP_BROWSER: "1"',
      '      - name: Admin',
      `        run: "'${process.execPath}' '${stubApp}'"`,
      '        env:',
      '          STUB_APP_BROWSER: "1"',
    ].join('\n'),
  })
  let client = await daemonAsApp(home, env)
  await client.addFactory({ repo: origin, key: 'NB' })
  const task = await client.createTask({ factory: 'NB', title: '{"steps":[{"endTurn":true}]}' })
  await client.startTask(task.id)
  const current = await waitUntil(
    async () => (await client.listTasks()).find((t) => t.id === task.id && t.leadRunId),
    'Task Lead',
  )
  await client.startApp(task.id, { name: 'Web' })
  const running = await waitUntil(
    async () => (await client.listApps(task.id)).find((a) => a.state === 'running'),
    'Web App',
  )
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env })
  const window = await firstWindow(app)
  await window
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'All Tasks' })
    .click()
  await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
  await window.getByRole('button', { name: 'Preview Web', exact: true }).click()
  const panel = window.getByRole('region', { name: 'Task browser' })
  await panel
    .getByRole('status')
    .filter({ hasText: 'Ready' })
    .waitFor()
    .catch(async (error: unknown) => {
      console.log('Browser panel:', await panel.textContent())
      console.log(
        'App log:',
        await readFile(path.join(home ?? '', 'logs/app.log'), 'utf8').catch(() => 'No app log'),
      )
      throw error
    })
  const command = (request: BrowserRequest) => client.browserCommand(task.id, request)
  const snapshot = await command({ action: 'snapshot' })
  expect(snapshot.text).toContain('Browser fixture')
  const field = snapshot.text?.match(/([^\s]+) input Name/)?.[1]
  if (!field) throw new Error('Name field missing from snapshot')
  await command({ action: 'fill', ref: field, value: 'Ada' })
  await expect(command({ action: 'click', ref: field })).rejects.toThrow(/Stale/)
  await app.evaluate(async ({ webContents }, url) => {
    await webContents
      .getAllWebContents()
      .find((c) => c.getURL() === new URL(url ?? '').href)
      ?.executeJavaScript(
        'globalThis.keyEvents=0; document.addEventListener("keydown",()=>globalThis.keyEvents++)',
      )
  }, running.url)
  await command({ action: 'press', value: 'Enter' })
  expect(
    await app.evaluate(async ({ webContents }, url) => {
      return webContents
        .getAllWebContents()
        .find((c) => c.getURL() === new URL(url ?? '').href)
        ?.executeJavaScript('globalThis.keyEvents')
    }, running.url),
  ).toBe(1)
  const next = await command({ action: 'snapshot' })
  const button = next.text?.match(/([^\s]+) button Try it/)?.[1]
  if (!button) throw new Error('Button missing from snapshot')
  await command({ action: 'click', ref: button })
  await expect.poll(async () => (await command({ action: 'snapshot' })).text).toContain('Clicked')
  expect(
    await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === new URL(url ?? '').href)
      return guest?.executeJavaScript(
        '({ted:typeof window.ted,node:typeof require,value:document.querySelector("input").value,cookie:document.cookie})',
      )
    }, running.url),
  ).toMatchObject({ ted: 'undefined', node: 'undefined', value: 'Ada', cookie: 'taskSession=yes' })
  await expect(command({ action: 'navigate', value: 'file:///etc/passwd' })).rejects.toThrow(
    /origin/,
  )
  await expect(command({ action: 'navigate', value: 'http://127.0.0.1:9/' })).rejects.toThrow(
    /origin/,
  )
  await checkGuestNetwork(app, new URL(running.url ?? '').href)
  const daemonInfo = await readDaemonInfo(home)
  if (!daemonInfo) throw new Error('Missing daemon info')
  expect(
    await app.evaluate(
      async ({ webContents }, { url, port }) => {
        const guest = webContents
          .getAllWebContents()
          .find((c) => c.getURL() === new URL(url ?? '').href)
        return guest?.executeJavaScript(
          `Promise.all([fetch('http://127.0.0.1:${port}/healthz',{mode:'no-cors'}).then(()=>false,()=>true),Promise.resolve(window.open('file:///etc/passwd')===null)])`,
        )
      },
      { url: running.url, port: daemonInfo.port },
    ),
  ).toEqual([true, true])
  expect(
    await app.evaluate(async ({ webContents }, url) => {
      return webContents
        .getAllWebContents()
        .find((c) => c.getURL() === new URL(url ?? '').href)
        ?.executeJavaScript("alert('Browser fixture'); 'dismissed'")
    }, running.url),
  ).toBe('dismissed')
  const capture = await command({ action: 'screenshot' })
  expect(capture.attachment?.mediaType).toBe('image/png')
  if (!capture.attachment) throw new Error('Screenshot missing')
  const bytes = await client.readBrowserCapture(task.id, capture.attachment.hash)
  expect(Buffer.from(bytes.data, 'base64').subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )
  await window.setViewportSize({ width: 900, height: 560 })
  await client.editTask(task.id, {
    description: 'A local browser with a description that takes some space above the controls.',
  })
  await panel.getByRole('button', { name: 'Screenshot', exact: true }).click()
  const postCapture = panel.getByRole('button', { name: 'Post screenshot to Task', exact: true })
  await postCapture.scrollIntoViewIfNeeded()
  for (const control of [
    postCapture,
    panel.getByRole('status'),
    panel.getByRole('button', { name: '← Task Lead' }),
  ]) {
    const bounds = await control.boundingBox()
    if (!bounds) throw new Error('Missing browser control')
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(560)
  }
  await postCapture.click()
  await expect
    .poll(async () =>
      (await client.listComments(task.id)).some(
        (comment) => comment.body === 'Browser screenshot' && comment.attachments?.length === 1,
      ),
    )
    .toBe(true)
  await client.editTask(task.id, { description: '' })
  await checkModalRace(app, window, new URL(running.url ?? '').href)
  await mkdir('node_modules/.cache/browser-work', { recursive: true })
  await window.screenshot({ path: 'node_modules/.cache/browser-work/panel.png' })
  await writeFile('node_modules/.cache/browser-work/page.png', Buffer.from(bytes.data, 'base64'))
  const key = await loadRunTokens(tedPaths(home).runTokenKey)
  const cli = await exec(process.execPath, [cliPath, 'browser', 'screenshot'], {
    cwd: home,
    env: {
      ...env,
      TED_TASK: task.displayId,
      TED_RUN: current.leadRunId,
      TED_RUN_CAPABILITY: key.issue(current.leadRunId ?? ''),
    },
  })
  expect(cli.stdout).toContain('Saved')
  const saved = (await readdir(home)).find((f) => /^ted-browser-.*\.png$/.test(f))
  if (!saved) throw new Error('CLI screenshot missing')
  expect((await readFile(path.join(home, saved))).subarray(0, 4)).toEqual(
    Buffer.from([137, 80, 78, 71]),
  )
  await panel.getByRole('button', { name: '← Task Lead' }).click()
  await window.getByRole('button', { name: 'Preview Web', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: 'Ready' }).waitFor()
  expect((await command({ action: 'snapshot' })).text).toContain('Clicked')
  const firstPage = new URL(running.url ?? '').href
  await app.evaluate(async ({ webContents }, url) => {
    await webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)
      ?.executeJavaScript("document.cookie='taskSession=first'")
  }, firstPage)
  const beforeRestart = await readDaemonInfo(home)
  if (!beforeRestart) throw new Error('Missing daemon before restart')
  process.kill(beforeRestart.pid, 'SIGKILL')
  await waitUntil(async () => {
    const info = await readDaemonInfo(home ?? '')
    return info && info.pid !== beforeRestart.pid ? info : undefined
  }, 'replacement daemon')
  client = await daemonAsApp(home, env)
  await expect
    .poll(
      async () => {
        try {
          return (await command({ action: 'snapshot' })).text
        } catch {
          return ''
        }
      },
      { timeout: 30_000 },
    )
    .toContain('Clicked')
  await panel.getByRole('status').filter({ hasText: 'Ready' }).waitFor()
  expect(
    await app.evaluate(async ({ webContents }, url) => {
      return webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)
        ?.executeJavaScript(
          '({value:document.querySelector("input").value,cookie:document.cookie})',
        )
    }, firstPage),
  ).toEqual({ value: 'Ada', cookie: 'taskSession=first' })
  await expect
    .poll(async () =>
      app?.evaluate(({ BrowserWindow }, url) => {
        return BrowserWindow.getAllWindows()[0]?.contentView.children.some(
          (v) =>
            'webContents' in v &&
            (v.webContents as import('electron').WebContents).getURL() === url &&
            v.getBounds().width > 200,
        )
      }, firstPage),
    )
    .toBe(true)
  const other = await client.createTask({ factory: 'NB', title: '{"steps":[{"endTurn":true}]}' })
  await client.startTask(other.id)
  await waitUntil(
    async () => (await client.listTasks()).find((t) => t.id === other.id && t.leadRunId),
    'second Task Lead',
  )
  await client.startApp(other.id, { name: 'Web' })
  const otherApp = await waitUntil(
    async () => (await client.listApps(other.id)).find((a) => a.state === 'running'),
    'second App',
  )
  await client.browserCommand(other.id, { action: 'open', app: { name: 'Web' } })
  expect(
    await app.evaluate(async ({ webContents }, url) => {
      return webContents
        .getAllWebContents()
        .find((c) => c.getURL() === new URL(url ?? '').href)
        ?.executeJavaScript('document.cookie')
    }, otherApp.url),
  ).toBe('taskSession=yes')
  await expect
    .poll(() => panel.getByRole('textbox', { name: 'App address' }).inputValue())
    .toBe(firstPage)
  expect((await command({ action: 'snapshot' })).text).toContain('Clicked')
  await client.startApp(task.id, { name: 'Admin' })
  const admin = await waitUntil(
    async () =>
      (await client.listApps(task.id)).find((a) => a.name === 'Admin' && a.state === 'running'),
    'Admin App',
  )
  const otherPage = new URL(otherApp.url ?? '').href
  await app.evaluate(async ({ webContents }, url) => {
    await webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)
      ?.executeJavaScript(
        "localStorage.setItem('switchMarker', 'retained'); document.cookie='switchMarker=retained'",
      )
  }, firstPage)
  await startGuestWorker(app, firstPage)
  await startGuestWorker(app, otherPage)
  const otherTraffic = await guestWorkerTraffic(otherPage)
  await command({ action: 'open', app: { name: 'Admin' } })
  await expect.poll(async () => (await guestWorkerTraffic(firstPage)).connections).toBe(0)
  const stoppedTraffic = await guestWorkerTraffic(firstPage)
  await expect
    .poll(async () => (await guestWorkerTraffic(otherPage)).messages)
    .toBeGreaterThan(otherTraffic.messages + 2)
  expect(await guestWorkerTraffic(firstPage)).toEqual(stoppedTraffic)
  await expect
    .poll(() => panel.getByRole('combobox', { name: 'Web App' }).inputValue())
    .toBe('widgets/Admin')
  await panel.getByRole('status').filter({ hasText: 'Ready' }).waitFor()
  expect((await command({ action: 'snapshot' })).url).toBe(new URL(admin.url ?? '').href)
  await command({ action: 'open', app: { name: 'Web' } })
  expect(
    await app.evaluate(async ({ webContents }, url) => {
      return webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)
        ?.executeJavaScript(`(async () => ({
          stored: localStorage.getItem('switchMarker'),
          cookie: document.cookie.includes('switchMarker=retained'),
          registrations: (await navigator.serviceWorker.getRegistrations()).length,
        }))()`)
    }, firstPage),
  ).toEqual({ stored: 'retained', cookie: true, registrations: 0 })
  await expect
    .poll(() => panel.getByRole('combobox', { name: 'Web App' }).inputValue())
    .toBe('widgets/Web')
  await panel.getByRole('status').filter({ hasText: 'Ready' }).waitFor()
  await window.setViewportSize({ width: 1100, height: 760 })
  await expect
    .poll(async () =>
      app?.evaluate(({ BrowserWindow }, url) => {
        const win = BrowserWindow.getAllWindows()[0]
        const child = win?.contentView.children.find(
          (v) =>
            'webContents' in v &&
            (v.webContents as import('electron').WebContents).getURL() === url,
        )
        return child?.getBounds().width
      }, firstPage),
    )
    .toBeGreaterThan(200)
  await window.evaluate(() => {
    const dialog = document.createElement('dialog')
    dialog.id = 'browser-test-dialog'
    dialog.textContent = 'Modal fixture'
    document.body.append(dialog)
    dialog.showModal()
  })
  await expect
    .poll(async () =>
      app?.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length,
      ),
    )
    .toBe(0)
  await window.evaluate(() => document.querySelector('#browser-test-dialog')?.remove())
  await app.evaluate(({ webContents }, url) => {
    webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)
      ?.forcefullyCrashRenderer()
  }, firstPage)
  await expect
    .poll(async () =>
      app?.evaluate(
        ({ webContents }, url) => webContents.getAllWebContents().some((c) => c.getURL() === url),
        firstPage,
      ),
    )
    .toBe(false)
  await command({ action: 'reload' })
  expect((await command({ action: 'snapshot' })).text).toContain('Project')
  await checkInFlightNavigation(app, firstPage, command)
  const storageKey = 'before-app-restart'
  await app.evaluate(
    async ({ webContents }, { url, storageKey }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
      await guest?.executeJavaScript(
        `localStorage.setItem(${JSON.stringify(storageKey)}, 'old'); document.cookie='restartMarker=old'`,
      )
    },
    { url: firstPage, storageKey },
  )
  await command({ action: 'open', app: { name: 'Admin' } })
  const adminUrl = new URL(admin.url ?? '').href
  const selectedGuest = () =>
    app?.evaluate(
      ({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)?.id,
      adminUrl,
    )
  const previousGuest = await selectedGuest()
  expect(previousGuest).toBeTypeOf('number')
  await startGuestWorker(app, adminUrl)
  await client.stopApp(task.id, { name: 'Web' })
  await expect.poll(async () => (await guestWorkerTraffic(adminUrl)).connections).toBe(0)
  await expect
    .poll(
      async () => {
        const current = await selectedGuest()
        return current !== undefined && current !== previousGuest
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  await panel.getByRole('status').filter({ hasText: 'Ready' }).waitFor()
  await expect
    .poll(
      () =>
        app?.evaluate(
          ({ BrowserWindow }, url) =>
            BrowserWindow.getAllWindows()[0]?.contentView.children.some(
              (v) =>
                'webContents' in v &&
                (v.webContents as import('electron').WebContents).getURL() === url,
            ),
          adminUrl,
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
  await client.startApp(task.id, { name: 'Web' })
  const restarted = await waitUntil(
    async () =>
      (await client.listApps(task.id)).find(
        (a) => a.name === 'Web' && a.state === 'running' && a.startedAt !== running.startedAt,
      ),
    'restarted Web App',
  )
  await command({ action: 'open', app: { name: 'Web' } })
  expect(
    await app.evaluate(
      async ({ webContents }, { url, storageKey }) => {
        const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
        return guest?.executeJavaScript(
          `({stored:localStorage.getItem(${JSON.stringify(storageKey)}),cookie:document.cookie})`,
        )
      },
      { url: new URL(restarted.url ?? '').href, storageKey },
    ),
  ).toEqual({ stored: null, cookie: 'taskSession=yes' })
  await client.stopApp(task.id, { name: 'Web' })
  await expect(command({ action: 'snapshot' })).rejects.toThrow(/running/)
  await panel.getByRole('status').filter({ hasText: 'isn’t running' }).waitFor()
})
