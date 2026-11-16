import type { ElectronApplication } from 'playwright'
import { killRunHosts, removeHome, stopDaemonIn } from '../../../daemon/test/helpers.ts'
import { closeApp } from '../close-app.ts'
import { type CleanupEvidence, cleanupWithEvidence } from './cleanup-evidence.ts'

export interface CoordinatorCleanupHelpers {
  stopDaemonIn: (home: string) => Promise<void>
  killRunHosts: (home: string) => Promise<void>
  removeHome: (home: string) => Promise<void>
}

const realHelpers: CoordinatorCleanupHelpers = {
  stopDaemonIn,
  killRunHosts: (home) => killRunHosts(home),
  removeHome,
}

export async function cleanupCoordinator(
  home: string,
  app: ElectronApplication | undefined,
  report: (evidence: CleanupEvidence) => void,
  helpers: CoordinatorCleanupHelpers = realHelpers,
): Promise<void> {
  await cleanupWithEvidence(
    [
      { name: 'closeApp', run: () => closeApp(app, 1000) },
      { name: 'stopDaemonIn', run: () => helpers.stopDaemonIn(home) },
      { name: 'killRunHosts', run: () => helpers.killRunHosts(home) },
      { name: 'removeHome', run: () => helpers.removeHome(home) },
    ],
    report,
  )
}
