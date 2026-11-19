import { agentsArea } from './agents.ts'
import { appsArea } from './apps.ts'
import { checksArea } from './checks.ts'
import { openContext } from './context.ts'
import { factoriesArea } from './factories.ts'
import { machineArea } from './machine.ts'
import { mergeArea } from './merge.ts'
import { requestsArea } from './requests.ts'
import { runsArea } from './runs.ts'
import { taskTreeArea } from './task-tree.ts'
import { tasksArea } from './tasks.ts'
import { trackersArea } from './trackers.ts'
import type { OpenProgress, TedStore } from './types.ts'

export async function openStore(options: {
  directory: string
  onProgress?: (progress: OpenProgress) => void
}): Promise<TedStore> {
  const ctx = await openContext(options)
  return {
    ...agentsArea(ctx),
    ...appsArea(ctx),
    ...checksArea(ctx),
    ...factoriesArea(ctx),
    ...machineArea(ctx),
    ...mergeArea(ctx),
    ...requestsArea(ctx),
    ...runsArea(ctx),
    ...taskTreeArea(ctx),
    ...tasksArea(ctx),
    ...trackersArea(ctx),
  }
}
