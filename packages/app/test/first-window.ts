import type { ElectronApplication, Page } from 'playwright'

export const firstWindow = (app: ElectronApplication): Promise<Page> =>
  app.firstWindow({ timeout: 60_000 })
