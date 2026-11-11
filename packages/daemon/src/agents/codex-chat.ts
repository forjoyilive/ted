// Ported from agent-orchestrator (Apache-2.0): chatdriver/codexappserver/normalize.go and
// commanddetail/command.go. TED changed: TypeScript, reads TED’s stored Conversation lines,
// keeps userMessage items and builds diff lines.
import type { ChatDiff, ConversationEntry } from '@ted/protocol'
import type { AgentChat, AgentChatEntry } from './agent.ts'
import { chatList, clip, label, list, parseObject, record, shortPath, str } from './chat-entries.ts'
import { diffPatch } from './diff.ts'

const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])

export function unwrapShell(command: string): string {
  for (const flag of [' -lc ', ' -c ']) {
    const index = command.indexOf(flag)
    if (index > 0 && shells.has(command.slice(0, index).split('/').at(-1) ?? '')) {
      const inner = command.slice(index + flag.length).trim()
      const quote = inner[0]
      if (inner.length >= 2 && (quote === "'" || quote === '"') && inner.at(-1) === quote) {
        return inner.slice(1, -1)
      }
      return inner
    }
  }
  return command
}

function patchStatus(kind: unknown): 'added' | 'deleted' | 'modified' {
  const type = str(record(kind).type) || str(kind)
  if (type === 'add') return 'added'
  if (type === 'delete') return 'deleted'
  return 'modified'
}

function fileChanges(changes: unknown, cwd: string): { diffs: ChatDiff[]; title: string } {
  const diffs: ChatDiff[] = []
  const verbs: string[] = []
  for (const change of list(changes)) {
    const { path: file, kind, diff } = record(change)
    const status = patchStatus(kind)
    const moved = str(record(kind).move_path) || str(record(kind).movePath)
    const shown = shortPath(moved || str(file), cwd)
    diffs.push(diffPatch(shown, str(diff), status))
    verbs.push(
      moved !== ''
        ? 'Renamed'
        : status === 'added'
          ? 'Created'
          : status === 'deleted'
            ? 'Deleted'
            : 'Edited',
    )
  }
  const title =
    diffs.length === 0
      ? 'Edited files'
      : diffs.length === 1
        ? `${verbs[0]} ${diffs[0]?.path ?? ''}`
        : `Edited ${diffs.length} files`
  return { diffs, title }
}

function mcpToolSummary(item: Record<string, unknown>): string {
  const tool = str(item.tool).trim()
  const server = str(item.server).trim()
  if (tool !== '' && server !== '') return `Called ${server}/${tool}`
  if (tool !== '') return `Called ${tool}`
  if (server !== '') return `Called a tool on ${server}`
  return 'Called a tool'
}

function failed(item: Record<string, unknown>): boolean {
  if (typeof item.exitCode === 'number' && item.exitCode !== 0) return true
  if (item.type === 'error') return true
  if (str(record(item.error).message) !== '') return true
  return item.success === false || item.status === 'failed' || item.status === 'declined'
}

function tool(
  item: Record<string, unknown>,
  cwd: string,
): Omit<Extract<AgentChatEntry, { kind: 'tool' }>, 'kind' | 'key' | 'status'> | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const command = unwrapShell(str(item.command).trim())
      const output = str(item.aggregatedOutput)
      return {
        tool: 'Shell',
        title: command === '' ? 'Ran a command' : label(command),
        ...(output !== '' && { output: clip(output) }),
      }
    }
    case 'fileChange': {
      const { diffs, title } = fileChanges(item.changes, cwd)
      return { tool: 'Edit', title, diffs }
    }
    case 'mcpToolCall': {
      const output =
        str(record(item.error).message) ||
        list(record(item.result).content)
          .map((part) => str(record(part).text))
          .filter((text) => text !== '')
          .join('\n')
      return {
        tool: 'Tool',
        title: mcpToolSummary(item),
        ...(output !== '' && { output: clip(output) }),
      }
    }
    case 'webSearch': {
      const query = str(item.query).trim()
      return { tool: 'Search', title: query === '' ? 'Searched the web' : label(query) }
    }
    case 'error':
      return { tool: 'Error', title: label(str(item.message) || 'Provider error') }
    default:
      return undefined
  }
}

function userText(item: Record<string, unknown>): string {
  return list(item.content)
    .map((part) => (record(part).type === 'text' ? str(record(part).text) : ''))
    .filter((text) => text !== '')
    .join('\n')
}

export function codexChatFrom(cwd: string): AgentChat {
  const chat = chatList()
  const add = ({ offset, line, at }: ConversationEntry): void => {
    const message = parseObject(line)
    if (!message) return
    chat.reading(offset)
    const method = message.method
    const params = record(message.params)
    const when = at !== undefined ? { at } : {}
    if (method === 'item/agentMessage/delta') {
      const key = str(params.itemId)
      if (key === '') return
      const current = chat.get(key)
      if (current?.kind === 'agent' && current.done) return
      chat.put({
        kind: 'agent',
        key,
        text: `${current?.kind === 'agent' ? current.text : ''}${str(params.delta)}`,
        done: false,
        ...(current?.at !== undefined ? { at: current.at } : when),
      })
      return
    }
    if (method !== 'item/started' && method !== 'item/completed') return
    const item = record(params.item)
    const key = str(item.id)
    if (key === '') return
    const completed = method === 'item/completed'
    const current = chat.get(key)
    const started = current?.at !== undefined ? { at: current.at } : when
    if (item.type === 'userMessage') {
      if (!current) chat.put({ kind: 'user', key, text: userText(item), ...when })
    } else if (item.type === 'agentMessage') {
      if (completed) chat.put({ kind: 'agent', key, text: str(item.text), done: true, ...started })
    } else {
      const view = tool(item, cwd)
      if (!view) return
      chat.put({
        kind: 'tool',
        key,
        ...view,
        status: !completed ? 'running' : failed(item) ? 'failed' : 'done',
        ...started,
        ...(completed && at !== undefined && { endedAt: at }),
      })
    }
  }
  return { add, entries: chat.entries, userFrom: chat.userFrom }
}

export function codexChat(entries: readonly ConversationEntry[], cwd: string): AgentChatEntry[] {
  const chat = codexChatFrom(cwd)
  for (const entry of entries) chat.add(entry)
  return [...chat.entries()]
}
