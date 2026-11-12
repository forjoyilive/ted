import { createContext } from 'react'
import type { MenuPosition } from './components/ContextMenu.tsx'
import { formatDate } from './time.ts'

export const snoozeRequestEvent = 'ted:snooze-request'

export interface SnoozeRequestDetail {
  requestId: string
  at: MenuPosition
  snoozedUntil?: string | undefined
}

export const SnoozedContext = createContext<ReadonlyMap<string, string>>(new Map())

export function openSnoozeMenu(detail: SnoozeRequestDetail): void {
  window.dispatchEvent(new CustomEvent(snoozeRequestEvent, { detail }))
}

export function snoozeTime(at: string): string {
  return formatDate(at, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
