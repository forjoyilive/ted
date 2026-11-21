import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkDemoHome,
  DemoAppRunningError,
  demoEnvironment,
  demoHome,
  seedDemoFromCli,
  stopDemoFromCli,
  verifyDemo,
} from '@ted/daemon/demo'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import { _electron as electron } from 'playwright'
import { buildRenderer } from '../test/build-renderer.ts'
import { closeApp } from '../test/close-app.ts'
import { loadedWindow } from '../test/first-window.ts'
import { prepareElectron } from '../test/support/electron-installation.ts'
import { sandboxRefusal } from './sandbox-refusal.ts'

const refusal = sandboxRefusal()
if (refusal) {
  console.error(refusal)
  process.exit(1)
}
const executablePath = await prepareElectron()
const home = demoHome()
const output = path.resolve(process.argv[2] || path.join(home, 'screenshots'))
const env = { ...demoEnvironment(home), TED_HIDDEN_WINDOW: '1' }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, env)
await buildRenderer()
try {
  await takeScreenshots()
} finally {
  await stopDemoProcesses()
}

async function stopDemoProcesses(): Promise<void> {
  try {
    await stopDemoFromCli(home)
  } catch (error) {
    if (!(error instanceof DemoAppRunningError)) throw error
    console.log(
      `The demo app is open on ${home}, so its daemon and Runs are still running. Quit it, then run pnpm ted dev stop.`,
    )
  }
}

async function takeScreenshots(): Promise<void> {
  await seedDemoFromCli(home, (await checkDemoHome(home))?.complete === false)
  await mkdir(output, { recursive: true })
  const app = await electron.launch({
    executablePath,
    args: [fileURLToPath(new URL('..', import.meta.url))],
    env,
    timeout: 120_000,
  })
  try {
    const window = await loadedWindow(app)
    await window.setViewportSize({ width: 1600, height: 1000 })
    const nav = () => window.getByRole('navigation', { name: 'Sidebar' })
    const openBoard = async () => {
      const row = nav().getByRole('article', { name: 'Garden', exact: true })
      const views = row.getByRole('button', { name: 'Views' })
      if ((await views.getAttribute('aria-expanded')) !== 'true') await views.click()
      const taskViews = row.locator('..').getByRole('button', { name: 'Task views' })
      if ((await taskViews.getAttribute('aria-expanded')) === 'false') await taskViews.click()
      await row.locator('..').getByRole('button', { name: 'Board', exact: true }).click()
      await window.getByRole('region', { name: 'Backlog', exact: true }).waitFor()
    }
    await nav().waitFor({ timeout: 120_000 })
    const manifest = JSON.parse(await readFile(path.join(home, 'demo.json'), 'utf8'))
    if (!manifest.complete) throw new Error('The demo seed did not finish.')
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('The demo daemon did not start.')
    await verifyDemo(new DaemonClient(info, info.token))
    for (const theme of ['light', 'dark'] as const) {
      await app.evaluate(async (_electron, appearance) => {
        const windows = _electron.BrowserWindow.getAllWindows()
        await windows[0]?.webContents.executeJavaScript(
          `window.ted.request('updateSettings', ${JSON.stringify({ appearance })})`,
        )
      }, theme)
      await window.emulateMedia({ colorScheme: theme })
      await openBoard()
      await window.screenshot({
        path: path.join(output, `board-${theme}.png`),
        animations: 'disabled',
      })
      await nav()
        .getByRole('button', { name: /^Inbox/ })
        .click()
      await window.getByRole('region', { name: 'Inbox', exact: true }).waitFor()
      await window.getByText('Which notebook should new notes use?', { exact: true }).click()
      await window.getByRole('radio', { name: 'Personal', exact: true }).waitFor()
      await window.screenshot({
        path: path.join(output, `inbox-${theme}.png`),
        animations: 'disabled',
      })
      await openBoard()
      await window.getByText('Keep the last edited note close at hand', { exact: true }).click()
      await window.getByRole('region', { name: 'Task thread', exact: true }).waitFor()
      await window
        .getByText('The editor now remembers the last note. I’m checking empty notebooks next.', {
          exact: true,
        })
        .waitFor()
      await window.screenshot({
        path: path.join(output, `thread-${theme}.png`),
        animations: 'disabled',
      })
      await nav()
        .getByRole('button', { name: /^Settings/ })
        .last()
        .click()
      await window.getByRole('navigation', { name: 'Settings', exact: true }).waitFor()
      await window.screenshot({
        path: path.join(output, `settings-${theme}.png`),
        animations: 'disabled',
      })
      await window.keyboard.press('Escape')
    }
    console.log(`Saved eight demo screenshots in ${output}.`)
  } finally {
    await closeApp(app)
  }
}
