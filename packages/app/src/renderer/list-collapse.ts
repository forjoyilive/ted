import type { ListView } from '@ted/protocol'
import { useState } from 'react'

const storageKey = 'ted.list.collapsed'

function readCollapsed(): Record<string, boolean> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(
      Object.entries(stored).filter(([, value]) => typeof value === 'boolean'),
    )
  } catch {
    return {}
  }
}

export function useListCollapsed(scope: string, grouping: ListView['group']) {
  const [choices, setChoices] = useState(readCollapsed)
  const key = (group: string) => JSON.stringify([scope, grouping, group])
  const collapsed = (group: string, fallback: boolean) => choices[key(group)] ?? fallback
  const change = (group: string, closed: boolean) => {
    const next = { ...choices, [key(group)]: closed }
    setChoices(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {}
  }
  return { collapsed, change }
}
