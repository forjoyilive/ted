import type { AppRef, TaskApp } from './app.ts'
import type { Attachment } from './task.ts'

export const browserActions = [
  'open',
  'snapshot',
  'click',
  'fill',
  'press',
  'navigate',
  'back',
  'forward',
  'reload',
  'screenshot',
] as const
export type BrowserAction = (typeof browserActions)[number]

export interface BrowserRequest {
  action: BrowserAction
  app?: AppRef
  value?: string
  ref?: string
}

export interface BrowserCommand {
  id: string
  expiresAt: number
  runId?: string
  taskId: string
  app: TaskApp
  request: BrowserRequest
}

export interface BrowserResult {
  url?: string
  text?: string
  attachment?: Attachment
}

export interface BrowserReply {
  result?: BrowserResult
  error?: string
}
