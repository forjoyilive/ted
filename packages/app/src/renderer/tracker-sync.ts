import type { Task } from '@ted/protocol'
import { ted } from './ted.ts'

export interface TrackerSyncChoice {
  name: string
  state: 'on' | 'ask'
  allow(): Promise<Task>
}

export function trackerSyncOf(task: Task): TrackerSyncChoice | undefined {
  if (task.source?.linear && task.linearSync) {
    return { name: 'Linear', state: task.linearSync, allow: () => ted.allowLinearSync(task.id) }
  }
  return undefined
}
