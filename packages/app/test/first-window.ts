import type { ElectronApplication, Page } from 'playwright'

export const firstWindow = (app: ElectronApplication): Promise<Page> =>
  app.firstWindow({ timeout: 60_000 })

export async function appLoaded(window: Page): Promise<void> {
  await window.locator('[data-loaded="true"]').waitFor()
}

export async function loadedWindow(app: ElectronApplication): Promise<Page> {
  const window = await firstWindow(app)
  await appLoaded(window)
  return window
}
