import type { ConversationEntry } from '@ted/protocol'
import type { AgentChat, AgentChatEntry } from './agent.ts'
import { chatList, clip, label, list, parseObject, record, shortPath, str } from './chat-entries.ts'
import { diffTexts } from './diff.ts'

export function antigravityChatFrom(cwd: string): AgentChat {
  const chat = chatList()
  let current = 0
  let message = 0
  let text = ''
  let key = ''
  const tools = new Map<string, Record<string, unknown>>()
  return {
    entries: chat.entries,
    userFrom: chat.userFrom,
    add(entry) {
      chat.reading(entry.offset)
      const event = parseObject(entry.line)
      if (!event) return
      if (event.ted_antigravity === 'started') {
        const previous = chat.get(key)
        if (previous?.kind === 'agent') chat.put({ ...previous, done: true })
        current = typeof event.turn === 'number' ? event.turn : current + 1
        message = 0
        text = ''
        key = `agent:${entry.offset}`
        chat.put({
          kind: 'user',
          key: `user:${entry.offset}`,
          text: str(event.text),
          ...(entry.at && { at: entry.at }),
        })
      }
      if (event.ted_antigravity === 'completed' || event.ted_antigravity === 'idle') {
        const previous = chat.get(key)
        if (previous?.kind === 'agent') chat.put({ ...previous, done: true })
      }
      if (event.ted_antigravity !== 'update') return
      const update = record(event.update)
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = record(update.content)
        if (content.type !== 'text') return
        text += str(content.text)
        chat.put({ kind: 'agent', key, text, done: false, ...(entry.at && { at: entry.at }) })
      }
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
        return
      const id = str(update.toolCallId)
      if (!id) return
      if (text !== '') {
        const previous = chat.get(key)
        if (previous?.kind === 'agent') chat.put({ ...previous, done: true })
        text = ''
        key = `agent:${current}:${++message}:${entry.offset}`
      }
      const merged = { ...tools.get(id), ...update }
      tools.set(id, merged)
      const diffs = list(merged.content).flatMap((part) => {
        const item = record(part)
        return item.type === 'diff' &&
          typeof item.path === 'string' &&
          typeof item.newText === 'string'
          ? [diffTexts(shortPath(item.path, cwd), str(item.oldText), item.newText)]
          : []
      })
      const output = list(merged.content)
        .map((part) => {
          const item = record(part)
          return item.type === 'content' ? str(record(item.content).text) : ''
        })
        .filter(Boolean)
        .join('\n')
      chat.put({
        kind: 'tool',
        key: `tool:${id}`,
        tool: str(merged.kind) || 'Tool',
        title: label(str(merged.title)) || 'Called a tool',
        status:
          merged.status === 'completed'
            ? 'done'
            : merged.status === 'failed'
              ? 'failed'
              : 'running',
        ...(output && { output: clip(output) }),
        ...(diffs.length > 0 && { diffs }),
        ...(entry.at && { at: entry.at }),
      })
    },
  }
}

export function antigravityChat(
  entries: readonly ConversationEntry[],
  cwd: string,
): AgentChatEntry[] {
  const chat = antigravityChatFrom(cwd)
  for (const entry of entries) chat.add(entry)
  return [...chat.entries()]
}
