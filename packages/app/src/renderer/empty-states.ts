import type { ListFilters, Task } from '@ted/protocol'
import { filterTasks } from './list-view.ts'

export type InboxEmptyAction = 'show-answered' | 'new-task' | 'show-all-factories'

export interface InboxEmpty {
  title: string
  action?: InboxEmptyAction
}

export function inboxEmpty({
  showAnswered,
  anyTasks,
  factoryName,
}: {
  showAnswered: boolean
  anyTasks: boolean
  factoryName?: string | undefined
}): InboxEmpty {
  if (showAnswered) {
    return {
      title:
        factoryName === undefined
          ? 'Nothing answered in the last 30 days'
          : `Nothing answered in ${factoryName} in the last 30 days`,
    }
  }
  if (factoryName !== undefined) {
    return { title: `Nothing waiting in ${factoryName}`, action: 'show-all-factories' }
  }
  return { title: 'Nothing waiting on you', action: anyTasks ? 'show-answered' : 'new-task' }
}

export function boardEmpty(
  tasks: readonly Task[],
  filters: ListFilters,
): 'no-tasks' | 'no-matches' | undefined {
  if (!tasks.some((t) => !t.archived)) return 'no-tasks'
  if (filterTasks(tasks, filters).length === 0) return 'no-matches'
  return undefined
}
