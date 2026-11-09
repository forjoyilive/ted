#!/usr/bin/env node
import path from 'node:path'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { withDaemon } from '@ted/daemon/launch'
import { type RunWithConversation, tedHome } from '@ted/protocol'

const usage = `Usage:
  ted task create "<title>"                 Create a Task
  ted task list                             List Tasks
  ted dev run start [--cwd <dir>] "<prompt>"  Start a Claude Code Run (development only)
  ted dev run show <run-id>                 Show a Run's state and Conversation`

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      strict: true,
      options: { cwd: { type: 'string' } },
    })
  } catch {
    return undefined
  }
}

const parsed = parse()
const [group, command, ...rest] = parsed?.positionals ?? []
const home = tedHome()

try {
  if (group === 'task' && command === 'create' && rest.length > 0) {
    const task = await withDaemon(home, (client) => client.createTask({ title: rest.join(' ') }))
    console.log(`Created ${task.displayId}  ${task.title}`)
  } else if (group === 'task' && command === 'list' && rest.length === 0) {
    const tasks = await withDaemon(home, (client) => client.listTasks())
    console.log(
      tasks.length === 0
        ? 'No Tasks yet.'
        : tasks.map((t) => `${t.displayId}  ${t.title}`).join('\n'),
    )
  } else if (group === 'dev' && command === 'run' && rest[0] === 'start' && rest.length > 1) {
    const cwd = path.resolve(parsed?.values.cwd ?? process.cwd())
    const prompt = rest.slice(1).join(' ')
    const run = await withDaemon(home, (client) => client.startDevRun({ prompt, cwd }))
    console.log(`Started Run ${run.id}`)
  } else if (group === 'dev' && command === 'run' && rest[0] === 'show' && rest.length === 2) {
    const id = rest[1] ?? ''
    console.log(formatRun(await withDaemon(home, (client) => client.getRun(id))))
  } else {
    console.error(usage)
    process.exitCode = 2
  }
} catch (error) {
  console.error(`ted: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

function formatRun({ run, conversation }: RunWithConversation): string {
  return [
    `Run ${run.id}  ${run.state}`,
    `Session ${run.sessionId}`,
    ...conversation.map((entry) => summarize(entry.line)),
  ].join('\n')
}

interface ContentBlock {
  type: string
  text?: string
  name?: string
}

function summarize(line: string): string {
  const message = JSON.parse(line) as {
    type: string
    subtype?: string
    hook_name?: string
    message?: { content?: string | ContentBlock[] }
  }
  const content = message.message?.content
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
  const parts = blocks.map((b) =>
    b.type === 'text' ? b.text : b.name ? `${b.type} ${b.name}` : b.type,
  )
  const kind = [message.type, message.subtype, message.hook_name].filter(Boolean).join(' ')
  return printable(parts.length > 0 ? `${kind}: ${parts.join(' | ')}` : kind)
}

function printable(text: string): string {
  return [...stripVTControlCharacters(text)].filter((c) => !isControl(c)).join('')
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code < 0x20 && char !== '\t' && char !== '\n') || (code >= 0x7f && code <= 0x9f)
}
