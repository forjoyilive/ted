import type { CommentKind } from './task.ts'

interface WaitingBase {
  id: string
  factoryId: string
  createdAt: string
  headline: string
  uncounted?: true
}

export function countWaiting(requests: readonly WaitingRequest[]): number {
  return requests.filter((r) => !r.uncounted).length
}

export type WaitingRequest =
  | (WaitingBase & {
      source: 'task'
      kind: CommentKind
      failed: boolean
      taskId: string
      displayId: string
      taskTitle: string
    })
  | (WaitingBase & { source: 'automation'; automationId: string; automationName: string })
  | (WaitingBase & { source: 'plan'; kind: CommentKind; planId: string; planTitle: string })

export type SnoozedRequest = WaitingRequest & { snoozedUntil: string }
