import type { DailyBackupFailure, DataStatus } from './data.ts'
import type { Factory } from './factory.ts'
import type { MachineSettings } from './settings.ts'
import type { Comment, Task } from './task.ts'

export type DaemonEvent =
  | { type: 'task-created'; task: Task }
  | { type: 'task-updated'; task: Task }
  | { type: 'comment-posted'; comment: Comment }
  | { type: 'factory-added'; factory: Factory }
  | { type: 'settings-changed'; settings: MachineSettings }
  | { type: 'data-status'; status: DataStatus }
  | { type: 'daily-backup'; failure: DailyBackupFailure | null }
