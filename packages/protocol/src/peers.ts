import type { RunState } from './run.ts'
import type { DescriptionVersion, Task, TaskBrief } from './task.ts'

export interface PeerSummary {
  id: string
  displayId: string
  title: string
  stage: Task['stage']
  status?: Task['status']
  activity?: string
  repos: string[]
  lead?: { id: string; state: RunState }
  updatedAt: string
  briefVersion?: number
  briefAt?: string
}

export interface PeerPage {
  tasks: PeerSummary[]
  at: string
  cursor: string
  nextOffset?: number
}

export interface PeerDetail {
  task: PeerSummary
  description: string
  original?: DescriptionVersion
  brief?: TaskBrief
}

export interface SendPeerMessage {
  operation: string
  text: string
}

export interface PeerMessage extends SendPeerMessage {
  id: string
  factoryId: string
  senderTaskId: string
  senderRunId: string
  recipientTaskId: string
  createdAt: string
  delivered?: { runId: string; at: string }
}

export interface PeerInbox {
  messages: PeerMessage[]
  nextOffset?: number
}
