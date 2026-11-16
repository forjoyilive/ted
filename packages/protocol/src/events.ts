import type { Activity } from './activity.ts'
import type { SimulatorSlots } from './app.ts'
import type { Banner } from './banner.ts'
import type { CheckRun, SendBack } from './checks.ts'
import type { DataStatus } from './data.ts'
import type { Factory, FactoryLayout } from './factory.ts'
import type { CheckTry, DriftCounts } from './factory-settings.ts'
import type { FactoryGuide } from './guide.ts'
import type { AgentHealth } from './health.ts'
import type { IntegrationsHealth } from './integrations.ts'
import type { Run } from './run.ts'
import type { MachineSettings } from './settings.ts'
import type { RunSlots } from './slots.ts'
import type { Comment, Task } from './task.ts'
import type { SnoozedRequest, WaitingRequest } from './waiting.ts'

export type DaemonEvent =
  | { type: 'side-chat-changed'; sourceRunId: string }
  | { type: 'coordinator-changed'; factoryId: string }
  | { type: 'task-created'; task: Task }
  | { type: 'task-updated'; task: Task }
  | { type: 'task-deleted'; taskId: string }
  | { type: 'task-reset'; taskId: string }
  | { type: 'comment-posted'; comment: Comment }
  | { type: 'comment-updated'; comment: Comment }
  | { type: 'check-run-updated'; checkRun: CheckRun }
  | { type: 'sent-back'; sendBack: SendBack }
  | { type: 'run-updated'; run: Run }
  | { type: 'run-output'; runId: string; lines?: true }
  | { type: 'factory-added'; factory: Factory }
  | { type: 'factory-updated'; factory: Factory }
  | { type: 'factory-removed'; factoryId: string }
  | { type: 'factory-layout-changed'; layout: FactoryLayout }
  | { type: 'factory-settings-changed'; factoryId: string }
  | { type: 'factory-stages-changed'; factoryId: string }
  | { type: 'guides-changed'; guides: FactoryGuide[] }
  | { type: 'settings-changed'; settings: MachineSettings }
  | { type: 'banner-raised'; banner: Banner }
  | { type: 'banner-updated'; banner: Banner }
  | { type: 'banner-cleared'; id: string }
  | { type: 'data-status'; status: DataStatus }
  | { type: 'agent-health-changed'; health: AgentHealth }
  | { type: 'slots-changed'; slots: RunSlots }
  | { type: 'apps-changed'; taskId: string }
  | { type: 'simulators-changed'; simulators: SimulatorSlots }
  | { type: 'emulators-changed'; emulators: SimulatorSlots }
  | { type: 'integrations-checked'; health: IntegrationsHealth }
  | { type: 'activity-changed'; activity: Activity }
  | { type: 'inbox-changed'; waiting: WaitingRequest[]; snoozed: SnoozedRequest[] }
  | { type: 'open-requested' }
  | { type: 'check-try-updated'; checkTry: CheckTry }
  | { type: 'automation-updated'; automationId: string }
  | { type: 'automation-deleted'; automationId: string }
  | { type: 'plan-updated'; planId: string }
  | { type: 'plan-deleted'; planId: string }
  | { type: 'library-changed'; version?: string }
  | { type: 'drift-changed'; drift: DriftCounts }
  | { type: 'line-comments-changed'; taskId: string }
  | { type: 'ted-stops-changed' }
