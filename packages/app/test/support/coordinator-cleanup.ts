import type { ElectronApplication } from 'playwright'
import { killRunHosts, removeHome, stopDaemonIn } from '../../../daemon/test/helpers.ts'
import { closeApp } from '../close-app.ts'
import { type CleanupEvidence, cleanupWithEvidence } from './cleanup-evidence.ts'

export async function cleanupCoordinator(
  home: string,
  app: ElectronApplication | undefined,
  report: (evidence: CleanupEvidence) => void,
): Promise<void> {
  await cleanupWithEvidence(
    [
      { name: 'closeApp', run: () => closeApp(app, 1000) },
      { name: 'stopDaemonIn', run: () => stopDaemonIn(home) },
      { name: 'killRunHosts', run: () => killRunHosts(home) },
      { name: 'removeHome', run: () => removeHome(home) },
    ],
    report,
  )
}
