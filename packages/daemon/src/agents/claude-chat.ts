import type { ChatDiff, ConversationEntry } from '@ted/protocol'
import type { AgentChatEntry } from './agent.ts'
import { chatList, clip, label, list, parseObject, record, shortPath, str } from './chat-entries.ts'
import { diffTexts } from './diff.ts'

interface ToolView {
  title: string
  detail?: string
  diffs?: ChatDiff[]
}

function describe(name: string, input: Record<string, unknown>, cwd: string): ToolView {
  const file = shortPath(str(input.file_path) || str(input.notebook_path) || str(input.path), cwd)
  switch (name) {
    case 'Bash':
      return {
        title: label(str(input.command)),
        ...(str(input.description) !== '' && { detail: str(input.description) }),
      }
    case 'Read':
      return { title: file }
    case 'Edit':
      return {
        title: file,
        diffs: [diffTexts(file, str(input.old_string), str(input.new_string))],
      }
    case 'MultiEdit':
      return {
        title: file,
        diffs: list(input.edits).map((edit) =>
          diffTexts(file, str(record(edit).old_string), str(record(edit).new_string)),
        ),
      }
    case 'Write':
      return { title: file, diffs: [diffTexts(file, '', str(input.content))] }
    case 'Grep':
    case 'Glob':
      return { title: label(str(input.pattern)), ...(file !== '' && { detail: file }) }
    case 'Task':
    case 'Agent':
      return { title: label(str(input.description) || str(input.prompt)) }
    case 'WebFetch':
      return { title: str(input.url) }
    case 'WebSearch':
      return { title: label(str(input.query)) }
    case 'TodoWrite':
      return { title: 'Updated the plan' }
    default:
      return { title: label(file || JSON.stringify(input)) }
  }
}

const interruptNote = '[Request interrupted by user'

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return list(content)
    .map((part) => str(record(part).text))
    .filter((text) => text !== '')
    .join('\n')
}

export function claudeChat(entries: readonly ConversationEntry[], cwd: string): AgentChatEntry[] {
  const chat = chatList()
  for (const { offset, line, at } of entries) {
    const message = parseObject(line)
    if (!message) continue
    const parent = message.parent_tool_use_id
    if (parent !== undefined && parent !== null) continue
    const when = at !== undefined ? { at } : {}
    if (message.type === 'assistant') {
      list(record(message.message).content).forEach((block, index) => {
        const part = record(block)
        if (part.type === 'text' && str(part.text).trim() !== '') {
          chat.put({
            kind: 'agent',
            key: `${offset}:${index}`,
            text: str(part.text),
            done: true,
            ...when,
          })
        } else if (part.type === 'tool_use') {
          const name = str(part.name) || 'Tool'
          chat.put({
            kind: 'tool',
            key: str(part.id) || `${offset}:${index}`,
            tool: name,
            status: 'running',
            ...describe(name, record(part.input), cwd),
            ...when,
          })
        }
      })
    } else if (message.type === 'user') {
      const content = record(message.message).content
      if (typeof content === 'string') {
        chat.put({ kind: 'user', key: String(offset), text: content, ...when })
        continue
      }
      const texts: string[] = []
      for (const block of list(content)) {
        const part = record(block)
        if (part.type === 'text' && !str(part.text).startsWith(interruptNote)) {
          texts.push(str(part.text))
        }
        if (part.type !== 'tool_result') continue
        const tool = chat.get(str(part.tool_use_id))
        if (tool?.kind !== 'tool') continue
        const output = resultText(part.content)
        chat.put({
          ...tool,
          status: part.is_error === true ? 'failed' : 'done',
          ...(output !== '' && { output: clip(output) }),
          ...(at !== undefined && { endedAt: at }),
        })
      }
      if (texts.length > 0) {
        chat.put({ kind: 'user', key: String(offset), text: texts.join('\n'), ...when })
      }
    }
  }
  return chat.entries()
}
