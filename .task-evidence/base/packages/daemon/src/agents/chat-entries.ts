import path from 'node:path'
import type { AgentChatEntry } from './agent.ts'

const maxOutput = 8000
const maxTitle = 120

export function chatList() {
  const order: string[] = []
  const byKey = new Map<string, AgentChatEntry>()
  const userFrom = new Map<string, number>()
  let reading = 0
  let listed: AgentChatEntry[] | undefined
  return {
    reading(offset: number) {
      reading = offset
    },
    put(entry: AgentChatEntry) {
      if (!byKey.has(entry.key)) order.push(entry.key)
      byKey.set(entry.key, entry)
      if (entry.kind === 'user' && !userFrom.has(entry.key)) userFrom.set(entry.key, reading)
      listed = undefined
    },
    get: (key: string) => byKey.get(key),
    entries(): readonly AgentChatEntry[] {
      listed ??= order.flatMap((key) => byKey.get(key) ?? [])
      return listed
    },
    userFrom: (key: string) => userFrom.get(key),
  }
}

export function clip(text: string): string {
  return text.length <= maxOutput ? text : `${text.slice(0, maxOutput)}\n…`
}

export function label(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length <= maxTitle ? line : `${line.slice(0, maxTitle)}…`
}

export function shortPath(file: string, cwd: string): string {
  if (!path.isAbsolute(file)) return file
  const relative = path.relative(cwd, file)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : file
}

export function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
