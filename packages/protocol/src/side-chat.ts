import type { RunChat } from './chat.ts'

export interface SideChat {
  id: string
  sourceRunId: string
  snapshotAt: string
  truncated: boolean
  state: 'ready' | 'queued' | 'working' | 'failed'
  available: boolean
  paused?: string
  error?: string
  chat?: RunChat
}

export interface SideChatMessageRequest {
  text: string
}

export function parseSideChatMessageRequest(input: unknown): SideChatMessageRequest {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('text' in input) ||
    typeof input.text !== 'string'
  )
    throw new Error('text is required')
  const text = input.text.trim()
  if (text.length === 0 || text.length > 10_000)
    throw new Error('text must be between 1 and 10000 characters')
  return { text }
}
