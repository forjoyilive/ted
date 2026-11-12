import type { ElectronApplication, Page } from 'playwright'
import { captureStartup } from './startup-evidence.ts'

export async function firstWindow(app: ElectronApplication): Promise<Page> {
  try {
    return await app.firstWindow({ timeout: 60_000 })
  } catch (error) {
    await captureStartup(app)
    throw error
  }
}

export async function appLoaded(window: Page): Promise<void> {
  await window.locator('[data-loaded="true"]').waitFor()
}

export async function loadedWindow(app: ElectronApplication): Promise<Page> {
  const window = await firstWindow(app)
  try {
    await appLoaded(window)
  } catch (error) {
    await captureStartup(app)
    throw error
  }
  return window
}
