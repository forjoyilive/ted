import type { ChatDiff, ConversationEntry } from '@ted/protocol'
import {
  isArray,
  isNumber,
  isObject,
  isString,
  type Json,
  type JsonArray,
  type JsonObject,
  parseJson,
} from '@ted/protocol/parse'
import type { AgentChat, AgentChatEntry } from './agent.ts'
import { chatList, clip, label, shortPath } from './chat-entries.ts'
import { diffTexts } from './diff.ts'

export const piObject = (value: Json | undefined): JsonObject => (isObject(value) ? value : {})
export const piText = (value: Json | undefined): string => (isString(value) ? value : '')
export const piList = (value: Json | undefined): JsonArray => (isArray(value) ? value : [])
export const piNumber = (value: Json | undefined): number => (isNumber(value) ? value : 0)

export function piLine(line: string): JsonObject | undefined {
  const value = parseJson(line)
  return isObject(value) ? value : undefined
}

export function piAssistant(event: JsonObject): JsonObject | undefined {
  const message = piObject(event.message)
  return event.type === 'message_end' && message.role === 'assistant' ? message : undefined
}

export function piErrorText(message: JsonObject): string | undefined {
  if (message.stopReason !== 'error') return undefined
  return piText(message.errorMessage) || 'Pi stopped with an error it didn’t describe'
}

interface ToolView {
  title: string
  detail?: string
  diffs?: ChatDiff[]
}

function describe(name: string, args: JsonObject, cwd: string): ToolView {
  const file = shortPath(piText(args.path), cwd)
  switch (name) {
    case 'bash':
      return { title: label(piText(args.command)) || 'Ran a command' }
    case 'read':
      return { title: file || 'Read a file' }
    case 'write':
      return { title: file, diffs: [diffTexts(file, '', piText(args.content))] }
    case 'edit':
      return {
        title: file,
        diffs: piList(args.edits).map((edit) => {
          const change = piObject(edit)
          return diffTexts(file, piText(change.oldText), piText(change.newText))
        }),
      }
    case 'grep':
    case 'find':
      return { title: label(piText(args.pattern)), ...(file !== '' && { detail: file }) }
    case 'ls':
      return { title: file || '.' }
    default:
      return { title: label(file || JSON.stringify(args)) || 'Called a tool' }
  }
}

function resultText(result: Json | undefined): string {
  const content = piObject(result).content
  if (isString(content)) return content
  return piList(content)
    .map((part) => piText(piObject(part).text))
    .filter((text) => text !== '')
    .join('\n')
}

export function piChatFrom(cwd: string): AgentChat {
  const chat = chatList()
  let message = ''
  const open = new Set<string>()

  const finish = () => {
    for (const key of open) {
      const entry = chat.get(key)
      if (entry?.kind === 'agent') chat.put({ ...entry, done: true })
      if (entry?.kind === 'tool' && entry.status === 'running' && entry.thinking === true)
        chat.put({ ...entry, status: 'done' })
    }
    open.clear()
  }

  const putText = (key: string, text: string, done: boolean, at: string | undefined) => {
    if (text.trim() === '' && !chat.get(key)) return
    chat.put({ kind: 'agent', key, text, done, ...(at !== undefined && { at }) })
    if (done) open.delete(key)
    else open.add(key)
  }

  const putThinking = (key: string, text: string, done: boolean, at: string | undefined) => {
    if (text.trim() === '' && !chat.get(key)) return
    chat.put({
      kind: 'tool',
      key,
      tool: 'Thinking',
      title: label(text) || 'Thinking',
      status: done ? 'done' : 'running',
      thinking: true,
      ...(text !== '' && { output: clip(text) }),
      ...(at !== undefined && { at }),
    })
    if (done) open.delete(key)
    else open.add(key)
  }

  const putTool = (id: string, name: string, args: JsonObject, at: string | undefined) => {
    const key = `tool:${id}`
    const before = chat.get(key)
    const known = before?.kind === 'tool' ? before : undefined
    const when = known?.at ?? at
    const view = Object.keys(args).length > 0 || !known ? describe(name, args, cwd) : known
    chat.put({
      kind: 'tool',
      key,
      tool: name || known?.tool || 'Tool',
      status: known?.status ?? 'running',
      title: view.title,
      ...(view.detail !== undefined && { detail: view.detail }),
      ...(view.diffs !== undefined && { diffs: view.diffs }),
      ...(known?.output !== undefined && { output: known.output }),
      ...(known?.endedAt !== undefined && { endedAt: known.endedAt }),
      ...(when !== undefined && { at: when }),
    })
  }

  const textOf = (key: string): string => {
    const entry = chat.get(key)
    if (entry?.kind === 'agent') return entry.text
    if (entry?.kind === 'tool') return entry.output ?? ''
    return ''
  }

  return {
    entries: chat.entries,
    userFrom: chat.userFrom,
    add(entry: ConversationEntry) {
      chat.reading(entry.offset)
      const event = piLine(entry.line)
      if (!event) return
      const at = entry.at
      if (event.ted_pi === 'started') {
        finish()
        chat.put({
          kind: 'user',
          key: `user:${entry.offset}`,
          text: piText(event.text),
          ...(at !== undefined && { at }),
        })
        return
      }
      if (event.ted_pi === 'idle') return finish()
      if (event.ted_pi === 'error') {
        putText(`error:${entry.offset}`, `Pi: ${piText(event.message)}`, true, at)
        return
      }
      if (event.type === 'message_start' && piObject(event.message).role === 'assistant') {
        message = String(entry.offset)
        return
      }
      if (event.type === 'message_update') {
        const update = piObject(event.assistantMessageEvent)
        const index = piNumber(update.contentIndex)
        const textKey = `agent:${message}:${index}`
        const thinkingKey = `thinking:${message}:${index}`
        switch (update.type) {
          case 'text_delta':
            return putText(textKey, textOf(textKey) + piText(update.delta), false, at)
          case 'text_end':
            return putText(textKey, piText(update.content), true, at)
          case 'thinking_delta':
            return putThinking(thinkingKey, textOf(thinkingKey) + piText(update.delta), false, at)
          case 'thinking_end':
            return putThinking(thinkingKey, piText(update.content), true, at)
          case 'toolcall_start':
            return putTool(piText(update.id), piText(update.toolName), {}, at)
          case 'toolcall_end': {
            const call = piObject(update.toolCall)
            return putTool(piText(call.id), piText(call.name), piObject(call.arguments), at)
          }
          default:
            return
        }
      }
      const assistant = piAssistant(event)
      if (assistant) {
        piList(assistant.content).forEach((part, index) => {
          const block = piObject(part)
          if (block.type === 'text')
            putText(`agent:${message}:${index}`, piText(block.text), true, at)
          if (block.type === 'thinking')
            putThinking(`thinking:${message}:${index}`, piText(block.thinking), true, at)
          if (block.type === 'toolCall')
            putTool(piText(block.id), piText(block.name), piObject(block.arguments), at)
        })
        const error = piErrorText(assistant)
        if (error !== undefined) putText(`error:${entry.offset}`, `Pi: ${error}`, true, at)
        return
      }
      if (event.type === 'tool_execution_start') {
        putTool(piText(event.toolCallId), piText(event.toolName), piObject(event.args), at)
        return
      }
      if (event.type === 'tool_execution_end') {
        const key = `tool:${piText(event.toolCallId)}`
        const tool = chat.get(key)
        if (tool?.kind !== 'tool') return
        const output = resultText(event.result)
        chat.put({
          ...tool,
          status: event.isError === true ? 'failed' : 'done',
          ...(output !== '' && { output: clip(output) }),
          ...(at !== undefined && { endedAt: at }),
        })
        return
      }
      if (event.type === 'agent_settled' && event.aborted === true) {
        for (const item of chat.entries()) {
          if (item.kind === 'tool' && item.status === 'running') {
            chat.put({ ...item, status: 'stopped' })
          }
        }
      }
    },
  }
}

export function piChat(entries: readonly ConversationEntry[], cwd: string): AgentChatEntry[] {
  const chat = piChatFrom(cwd)
  for (const entry of entries) chat.add(entry)
  return [...chat.entries()]
}
