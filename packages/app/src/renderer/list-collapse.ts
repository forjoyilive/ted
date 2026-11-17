import type { ListView } from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { useState } from 'react'

const storageKey = 'ted.list.collapsed'
const foldsKey = 'ted.list.folded'

function readStored<T>(name: string, valid: (value: unknown) => value is T): Record<string, T> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(name) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => valid(value)))
  } catch {
    return {}
  }
}

function writeStored(name: string, value: JsonObject) {
  try {
    localStorage.setItem(name, JSON.stringify(value))
  } catch {}
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string')

const none: ReadonlySet<string> = new Set()

export function useListCollapsed(scope: string, grouping: ListView['group']) {
  const [choices, setChoices] = useState(() => readStored(storageKey, isBoolean))
  const [folds, setFolds] = useState(() => readStored(foldsKey, isIds))
  const key = (group: string) => JSON.stringify([scope, grouping, group])
  const collapsed = (group: string, fallback: boolean) => choices[key(group)] ?? fallback
  const change = (group: string, closed: boolean) => {
    const next = { ...choices, [key(group)]: closed }
    setChoices(next)
    writeStored(storageKey, next)
  }
  const folded = (group: string): ReadonlySet<string> => {
    const ids = folds[key(group)]
    return ids ? new Set(ids) : none
  }
  const fold = (group: string, taskId: string) => {
    const ids = folds[key(group)] ?? []
    const rest = ids.filter((id) => id !== taskId)
    const nextIds = rest.length === ids.length ? [...ids, taskId] : rest
    const { [key(group)]: _, ...others } = folds
    const next = nextIds.length > 0 ? { ...others, [key(group)]: nextIds } : others
    setFolds(next)
    writeStored(foldsKey, next)
  }
  return { collapsed, change, folded, fold }
}
