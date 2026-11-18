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
  checkOutsideRequests,
  checkRefusedNames,
  checkWorkerMedia,
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
    TED_BROWSER_HOSTS: 'private.example=10.0.0.1',
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
      '        preview: mobile',
      `        run: "'${process.execPath}' '${stubApp}'"`,
      '        env:',
      '          STUB_APP_BROWSER: "1"',
      '          STUB_APP_EDGE_MARKS: "1"',
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
  await window.getByRole('tab', { name: 'Apps' }).click()
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
  const backButton = panel.getByRole('button', { name: 'Back', exact: true })
  const forwardButton = panel.getByRole('button', { name: 'Forward', exact: true })
  expect(await backButton.isDisabled()).toBe(true)
  expect(await forwardButton.isDisabled()).toBe(true)
  await command({ action: 'navigate', value: new URL('?second', running.url).href })
  await expect.poll(() => backButton.isEnabled()).toBe(true)
  expect(await forwardButton.isDisabled()).toBe(true)
  await backButton.click()
  await expect.poll(() => forwardButton.isEnabled()).toBe(true)
  await expect.poll(() => backButton.isDisabled()).toBe(true)
  await panel.getByRole('status').filter({ hasText: 'Ready' }).waitFor()
  await checkRefusedNames(app, panel, new URL(running.url ?? '').href, () =>
    command({ action: 'reload' }),
  )
  await checkWorkerMedia(app, panel, new URL(running.url ?? '').href)
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
  await checkOutsideRequests(app, panel, new URL(running.url ?? '').href)
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
  await window.getByRole('tab', { name: 'Apps' }).click()
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
  await panel.getByRole('combobox', { name: 'Web App' }).click()
  await window
    .getByRole('listbox', { name: 'Web App' })
    .getByRole('option', { name: 'Admin' })
    .click()
  await window
    .getByRole('dialog', { name: 'Run Admin outside the sandbox?' })
    .getByRole('button', { name: 'Run', exact: true })
    .click()
  const admin = await waitUntil(
    async () =>
      (await client.listApps(task.id)).find((a) => a.name === 'Admin' && a.state === 'running'),
    'Admin App started from the Web App list',
  )
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
  const sizeButton = panel.getByRole('button', { name: /^Preview size:/ })
  const adminScreen = () =>
    app?.evaluate(
      async ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((c) => c.getURL() === url)
          ?.executeJavaScript(
            '({width: screen.width, touch: navigator.maxTouchPoints, phone: navigator.userAgent.includes("iPhone")})',
          ),
      new URL(admin.url ?? '').href,
    )
  await expect
    .poll(() => sizeButton.getAttribute('aria-label'))
    .toBe('Preview size: Mobile · 390 × 844')
  await expect.poll(adminScreen).toEqual({ width: 390, touch: 5, phone: true })
  const adminPage = new URL(admin.url ?? '').href
  await checkRefusedNames(app, panel, adminPage)
  const screenshot = async () => {
    const shot = await command({ action: 'screenshot' })
    if (!shot.attachment) throw new Error('Screenshot missing')
    const data = (await client.readBrowserCapture(task.id, shot.attachment.hash)).data
    return app?.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
      const { width, height } = image.getSize()
      const bitmap = image.toBitmap()
      // toBitmap's channel order depends on the platform; the fixture's corner colours read the same in RGBA and BGRA.
      const channels = (x: number, y: number) =>
        [0, 1, 2].map((c) => ((bitmap[(y * width + x) * 4 + c] ?? 0) > 127 ? 1 : 0)).join('')
      return {
        width,
        height,
        topRight: channels(width - 10, 10),
        bottomRight: channels(width - 10, height - 10),
        bottomLeft: channels(10, height - 10),
      }
    }, data)
  }
  const mobileShot = {
    width: 390,
    height: 844,
    topRight: '010',
    bottomRight: '101',
    bottomLeft: '000',
  }
  expect(await screenshot()).toEqual(mobileShot)
  const unscaledPage = new URL('?no-viewport', adminPage).href
  await command({ action: 'navigate', value: unscaledPage })
  await expect
    .poll(() =>
      app?.evaluate(
        async ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .find((c) => c.getURL() === url)
            ?.executeJavaScript('({ width: innerWidth, scale: visualViewport.scale < 1 })'),
        unscaledPage,
      ),
    )
    .toEqual({ width: 980, scale: true })
  expect(await screenshot()).toEqual(mobileShot)
  await command({ action: 'navigate', value: adminPage })
  const adminAttached = () =>
    app?.evaluate(({ BrowserWindow }, url) => {
      const children = BrowserWindow.getAllWindows()[0]?.contentView.children ?? []
      return children.some(
        (v) =>
          'webContents' in v && (v.webContents as import('electron').WebContents).getURL() === url,
      )
    }, adminPage)
  await panel.getByRole('button', { name: '← Task Lead' }).click()
  await expect.poll(adminAttached).toBe(false)
  expect(await screenshot()).toEqual(mobileShot)
  await window.getByRole('tab', { name: 'Apps' }).click()
  await window.getByRole('button', { name: 'Preview Admin', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: 'Ready' }).waitFor()
  const onAdmin = (script: string) =>
    app?.evaluate(
      async ({ webContents }, { url, script }) =>
        webContents
          .getAllWebContents()
          .find((c) => c.getURL() === url)
          ?.executeJavaScript(script),
      { url: adminPage, script },
    )
  const addTarget = (event: 'touchend' | 'click') =>
    onAdmin(`(() => {
      globalThis.hits = 0
      const target = document.createElement('div')
      target.setAttribute('role', 'button')
      target.textContent = 'Tap target'
      target.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:80px;z-index:2147483647'
      target.addEventListener('${event}', () => globalThis.hits++)
      document.body.append(target)
    })()`)
  const clickTargetAsAgent = async () => {
    const ref = (await command({ action: 'snapshot' })).text?.match(
      /([^\s]+) button Tap target/,
    )?.[1]
    if (!ref) throw new Error('Tap target missing from snapshot')
    await command({ action: 'click', ref })
  }
  await addTarget('touchend')
  await expect.poll(adminAttached).toBe(true)
  await expect
    .poll(() => onAdmin('document.elementFromPoint(5, 5)?.textContent'))
    .toBe('Tap target')
  await app.evaluate(({ webContents }, url) => {
    const page = webContents.getAllWebContents().find((c) => c.getURL() === url)
    // sendInputEvent skips Chromium's touch emulation; a mouse event sent this way never answers.
    for (const type of ['mousePressed', 'mouseReleased'])
      void page?.debugger
        .sendCommand('Input.dispatchMouseEvent', {
          type,
          x: 5,
          y: 5,
          button: 'left',
          clickCount: 1,
        })
        .catch(() => {})
  }, adminPage)
  await expect.poll(() => onAdmin('globalThis.hits')).toBe(1)
  await clickTargetAsAgent()
  await expect.poll(() => onAdmin('globalThis.hits')).toBe(2)
  await sizeButton.click()
  await window.getByRole('menuitemradio', { name: /^Landscape/ }).click()
  await expect.poll(adminScreen).toMatchObject({ width: 844, phone: true })
  await sizeButton.click()
  await window.getByRole('menuitemradio', { name: /^Desktop/ }).click()
  await expect.poll(adminScreen).toMatchObject({ touch: 0, phone: false })
  await panel.getByRole('status').filter({ hasText: 'Ready' }).waitFor()
  await expect.poll(() => onAdmin('document.readyState')).toBe('complete')
  await addTarget('click')
  await clickTargetAsAgent()
  await expect.poll(() => onAdmin('globalThis.hits')).toBe(1)
  await expect
    .poll(() => panel.locator('[data-preview-size]').getAttribute('data-preview-size'))
    .toBe('desktop')
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
  const addressRow = panel.locator('form:has(input[aria-label="App address"])')
  const addressRowSpread = () =>
    addressRow.evaluate((form) => {
      const centers = [...form.querySelectorAll(':scope > *, :scope > span > *')].flatMap((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 ? [r.top + r.height / 2] : []
      })
      return Math.max(...centers) - Math.min(...centers)
    })
  const widthField = panel.getByLabel('Custom width in pixels')
  const sizeButtonFocused = () =>
    sizeButton.evaluate((button) => button === document.activeElement).catch(() => false)
  const openCustomWidth = async () => {
    await sizeButton.click()
    await window.getByRole('menuitemradio', { name: /^Custom width/ }).click()
    await widthField.waitFor()
  }
  for (const width of [1440, 1280]) {
    await window.setViewportSize({ width, height: 900 })
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(width)
    await openCustomWidth()
    expect(await sizeButton.count()).toBe(0)
    await expect.poll(addressRowSpread).toBeLessThan(4)
    await widthField.fill('10')
    await addressRow.getByRole('button', { name: 'Apply' }).click()
    await expect.poll(() => addressRow.getByRole('alert').textContent()).toBe('Use 320–3840 px')
    expect(await widthField.getAttribute('aria-invalid')).toBe('true')
    await expect.poll(addressRowSpread).toBeLessThan(4)
    await addressRow.getByRole('button', { name: 'Cancel' }).click()
    await sizeButton.waitFor()
    expect(await widthField.count()).toBe(0)
    await expect.poll(sizeButtonFocused).toBe(true)
  }
  await openCustomWidth()
  await widthField.press('Escape')
  await expect.poll(sizeButtonFocused).toBe(true)
  const previewSize = () => panel.locator('[data-preview-size]').getAttribute('data-preview-size')
  await openCustomWidth()
  await widthField.fill('1024')
  await widthField.press('Enter')
  await expect.poll(sizeButtonFocused).toBe(true)
  await expect.poll(previewSize).toBe('1024')
  await openCustomWidth()
  await widthField.fill('1200')
  await addressRow.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(sizeButtonFocused).toBe(true)
  await expect.poll(previewSize).toBe('1200')
  await sizeButton.click()
  await window.getByRole('menuitemradio', { name: /^Desktop/ }).click()
  await expect.poll(previewSize).toBe('desktop')
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
  type CrashRecovery = typeof globalThis & { crashRecovery?: { busy: boolean; done: boolean } }
  // The panel reopens a crashed page itself. Until its open command finishes,
  // the daemon refuses any other browser command for the Task.
  await panel.evaluate((region) => {
    const recovery = { busy: false, done: false }
    ;(globalThis as CrashRecovery).crashRecovery = recovery
    new MutationObserver((_records, observer) => {
      const text = region.querySelector('[role="status"]')?.textContent ?? ''
      if (!text.includes('Ready')) recovery.busy = true
      else if (recovery.busy) {
        recovery.done = true
        observer.disconnect()
      }
    }).observe(region, { childList: true, subtree: true, characterData: true })
  })
  const crashed = await app.evaluate(({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
    guest?.forcefullyCrashRenderer()
    return guest?.id
  }, firstPage)
  await expect
    .poll(async () =>
      app?.evaluate(
        ({ webContents }, { url, crashed }) =>
          webContents.getAllWebContents().some((c) => c.getURL() === url && c.id !== crashed),
        { url: firstPage, crashed },
      ),
    )
    .toBe(true)
  await expect
    .poll(() => window.evaluate(() => (globalThis as CrashRecovery).crashRecovery?.done))
    .toBe(true)
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
