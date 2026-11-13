import { useState } from 'react'
import { type InboxGrouping, inboxGroupings } from './inbox.ts'

const storageKey = 'ted.inbox.grouping'

interface Stored {
  grouping: InboxGrouping
  collapsed: Record<string, boolean>
}

function read(): Stored {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('not saved')
    const { grouping, collapsed } = stored as { grouping?: unknown; collapsed?: unknown }
    return {
      grouping: inboxGroupings.find((known) => known === grouping) ?? 'none',
      collapsed:
        collapsed && typeof collapsed === 'object' && !Array.isArray(collapsed)
          ? Object.fromEntries(
              Object.entries(collapsed).filter(([, value]) => typeof value === 'boolean'),
            )
          : {},
    }
  } catch {
    return { grouping: 'none', collapsed: {} }
  }
}

export function useInboxGrouping(view: 'waiting' | 'answered') {
  const [stored, setStored] = useState(read)
  const save = (next: Stored) => {
    setStored(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {}
  }
  const key = (group: string) => JSON.stringify([view, stored.grouping, group])
  return {
    grouping: stored.grouping,
    setGrouping: (grouping: InboxGrouping) => save({ ...stored, grouping }),
    collapsed: (group: string) => stored.collapsed[key(group)] === true,
    setCollapsed: (group: string, closed: boolean) =>
      save({ ...stored, collapsed: { ...stored.collapsed, [key(group)]: closed } }),
  }
}
