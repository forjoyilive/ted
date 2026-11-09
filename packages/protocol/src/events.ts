import type { Activity } from './activity.ts'
import type { Banner } from './banner.ts'
import type { DataStatus } from './data.ts'
import type { Factory } from './factory.ts'
import type { IntegrationsHealth } from './integrations.ts'
import type { Run } from './run.ts'
import type { MachineSettings } from './settings.ts'
import type { RunSlots } from './slots.ts'
import type { Comment, Task } from './task.ts'

export type DaemonEvent =
  | { type: 'task-created'; task: Task }
  | { type: 'task-updated'; task: Task }
  | { type: 'comment-posted'; comment: Comment }
  | { type: 'comment-updated'; comment: Comment }
  | { type: 'run-updated'; run: Run }
  | { type: 'factory-added'; factory: Factory }
  | { type: 'settings-changed'; settings: MachineSettings }
  | { type: 'banner-raised'; banner: Banner }
  | { type: 'banner-updated'; banner: Banner }
  | { type: 'banner-cleared'; id: string }
  | { type: 'data-status'; status: DataStatus }
  | { type: 'slots-changed'; slots: RunSlots }
  | { type: 'integrations-checked'; health: IntegrationsHealth }
  | { type: 'activity-changed'; activity: Activity }
  | { type: 'open-requested' }
