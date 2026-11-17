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
  'resize',
  'color-scheme',
  'size',
] as const
export type BrowserAction = (typeof browserActions)[number]

export const runOnlyBrowserActions: readonly BrowserAction[] = ['resize', 'color-scheme']

export const taskOnlyBrowserActions: readonly BrowserAction[] = ['size']

export const browserViewportLimits = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 240,
  maxHeight: 2160,
}

export function browserViewport(value: string): { width: number; height: number } | string {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(value)
  const width = Number(match?.[1])
  const height = Number(match?.[2])
  const { minWidth, maxWidth, minHeight, maxHeight } = browserViewportLimits
  if (!match || width < minWidth || width > maxWidth || height < minHeight || height > maxHeight)
    return `Give a size like 390x844, ${minWidth}–${maxWidth} wide and ${minHeight}–${maxHeight} high`
  return { width, height }
}

export interface BrowserRequest {
  action: BrowserAction
  app?: AppRef
  value?: string
  ref?: string
}

export interface BrowserCommand {
  id: string
  canceled?: true
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
  canceled?: true
  result?: BrowserResult
  error?: string
}

export interface BrowserPollRequest {
  session: string
}

export interface BrowserReplyRequest extends BrowserPollRequest {
  canceled?: true
  error?: string
  result?: Pick<BrowserResult, 'url' | 'text'>
}
