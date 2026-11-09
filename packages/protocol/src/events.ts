import type { Activity } from './activity.ts'
import type { Banner } from './banner.ts'
import type { Factory } from './factory.ts'
import type { MachineSettings } from './settings.ts'
import type { Comment, Task } from './task.ts'

export type DaemonEvent =
  | { type: 'task-created'; task: Task }
  | { type: 'task-updated'; task: Task }
  | { type: 'comment-posted'; comment: Comment }
  | { type: 'factory-added'; factory: Factory }
  | { type: 'settings-changed'; settings: MachineSettings }
  | { type: 'banner-raised'; banner: Banner }
  | { type: 'banner-updated'; banner: Banner }
  | { type: 'banner-cleared'; id: string }
  | { type: 'activity-changed'; activity: Activity }
  | { type: 'open-requested' }
