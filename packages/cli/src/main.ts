#!/usr/bin/env node
import path from 'node:path'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { withDaemon } from '@ted/daemon/launch'
import { checkWorkflowPath, NothingToCheckError } from '@ted/daemon/workflow'
import {
  type AgentKind,
  agentKinds,
  type RunWithConversation,
  tedHome,
  tedPaths,
} from '@ted/protocol'

const usage = `Usage:
  ted help                                   Show this list of commands
  ted comment [--task <id>] "<text>"         Post a note on the Task (reads stdin if no text)
  ted outcome advance [--task <id>]          End the current Stage and move the Task on
  ted task create [--factory <key>] "<title>"  Create a Task
  ted task list                              List Tasks with their Stages
  ted task start <id>                        Start a Task from Backlog
  ted workflow check [<path>]                Check workflow.yaml and Stage files (default: .ted)
  ted dev factory add <owner/repo | git URL> --key <key> [--local-folder <dir>]
                                             Add a one-repo Factory (development only)
  ted dev factory local-folder <key> <dir>   Set the folder new worktrees copy files from
  ted dev run start [--agent claude|codex] [--cwd <dir>] "<prompt>"
                                             Start a Run (development only)
  ted dev run show <run-id>                  Show a Run's state and Conversation

Inside a Run, commands act on the Run's own Task (TED_TASK).`

class UsageError extends Error {}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        agent: { type: 'string' },
        cwd: { type: 'string' },
        factory: { type: 'string' },
        key: { type: 'string' },
        'local-folder': { type: 'string' },
        task: { type: 'string' },
      },
    })
  } catch {
    return undefined
  }
}

const parsed = parse()
const [group, command, ...rest] = parsed?.positionals ?? []
const options = parsed?.values ?? {}
const home = tedHome()

function taskRef(): string {
  const ref = options.task ?? process.env.TED_TASK
  if (!ref) throw new UsageError('outside a Run, name the Task with --task <id>')
  return ref
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

try {
  if (!parsed) {
    throw new UsageError('')
  } else if (group === 'help' && command === undefined) {
    console.log(usage)
  } else if (group === 'comment') {
    const ref = taskRef()
    const body = [command, ...rest].filter((s) => s !== undefined).join(' ') || (await readStdin())
    if (body.trim() === '') throw new UsageError('give the Comment as text or on stdin')
    await withDaemon(home, (client) => client.postComment(ref, body))
    console.log('Posted')
  } else if (group === 'outcome' && command === 'advance' && rest.length === 0) {
    const ref = taskRef()
    const task = await withDaemon(home, (client) => client.reportOutcome(ref, 'advance'))
    console.log(`${task.displayId} moved to ${stageName(task.stage)}`)
  } else if (group === 'task' && command === 'create' && rest.length > 0) {
    const title = rest.join(' ')
    const factory = options.factory
    const task = await withDaemon(home, (client) =>
      client.createTask({ title, ...(factory !== undefined && { factory }) }),
    )
    console.log(`Created ${task.displayId}  ${task.title}`)
  } else if (group === 'task' && command === 'list' && rest.length === 0) {
    const tasks = await withDaemon(home, (client) => client.listTasks())
    console.log(
      tasks.length === 0
        ? 'No Tasks yet.'
        : tasks.map((t) => `${t.displayId}  ${stageName(t.stage)}  ${t.title}`).join('\n'),
    )
  } else if (group === 'task' && command === 'start' && rest.length === 1) {
    const ref = rest[0] ?? ''
    const task = await withDaemon(home, (client) => client.startTask(ref))
    console.log(`Started ${task.displayId} on branch ${task.branch}`)
  } else if (group === 'workflow' && command === 'check' && rest.length <= 1) {
    await workflowCheck(rest[0] ?? '.ted')
  } else if (group === 'dev' && command === 'factory' && rest[0] === 'add' && rest.length === 2) {
    const repo = rest[1] ?? ''
    const key = options.key
    if (key === undefined) throw new UsageError('give the Factory key with --key')
    const folder = options['local-folder']
    const localFolder = folder === undefined ? undefined : path.resolve(folder)
    const factory = await withDaemon(home, (client) =>
      client.addFactory({ repo, key, ...(localFolder !== undefined && { localFolder }) }),
    )
    console.log(`Added Factory ${factory.key}  ${factory.repo}`)
  } else if (
    group === 'dev' &&
    command === 'factory' &&
    rest[0] === 'local-folder' &&
    rest.length === 3
  ) {
    const key = rest[1] ?? ''
    const folder = path.resolve(rest[2] ?? '')
    const factory = await withDaemon(home, (client) => client.setLocalFolder(key, folder))
    console.log(`${factory.key} copies files from ${factory.localFolder?.path ?? folder}`)
  } else if (group === 'dev' && command === 'run' && rest[0] === 'start' && rest.length > 1) {
    const cwd = path.resolve(options.cwd ?? process.cwd())
    const prompt = rest.slice(1).join(' ')
    const agent = options.agent
    if (agent !== undefined && !agentKinds.includes(agent as AgentKind)) {
      throw new UsageError('--agent must be claude or codex')
    }
    const run = await withDaemon(home, (client) =>
      client.startDevRun({
        prompt,
        cwd,
        ...(agent !== undefined && { agent: agent as AgentKind }),
      }),
    )
    console.log(`Started Run ${run.id}`)
  } else if (group === 'dev' && command === 'run' && rest[0] === 'show' && rest.length === 2) {
    const id = rest[1] ?? ''
    console.log(formatRun(await withDaemon(home, (client) => client.getRun(id))))
  } else {
    throw new UsageError('')
  }
} catch (error) {
  if (error instanceof NothingToCheckError) {
    console.error(`ted: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof UsageError) {
    console.error(error.message === '' ? usage : `ted: ${error.message}`)
    process.exitCode = 2
  } else {
    console.error(`ted: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

async function workflowCheck(target: string): Promise<void> {
  const problems = await checkWorkflowPath(path.resolve(target), {
    libraryDir: tedPaths(home).library,
  })
  for (const p of problems) {
    const file = path.relative(process.cwd(), p.path)
    console.log(`${file}:${p.line}:${p.column}: ${p.severity}: ${printable(p.message)}`)
  }
  const count = (severity: string) => problems.filter((p) => p.severity === severity).length
  const errors = count('error')
  const warnings = count('warning')
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (problems.length === 0)
    console.log(`No problems in ${path.relative(process.cwd(), path.resolve(target)) || '.'}`)
  else {
    console.log(
      [errors > 0 && plural(errors, 'error'), warnings > 0 && plural(warnings, 'warning')]
        .filter(Boolean)
        .join(', '),
    )
  }
  if (errors > 0) process.exitCode = 1
}

function formatRun({ run, conversation }: RunWithConversation): string {
  return [
    `Run ${run.id}  ${run.agent}  ${run.state}`,
    `Session ${run.sessionId ?? 'not known yet'}`,
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
    type?: string
    subtype?: string
    hook_name?: string
    message?: { content?: string | ContentBlock[] }
    id?: unknown
    method?: string
    params?: { item?: { type?: string; text?: string } }
  }
  if (message.method === undefined && message.id !== undefined) {
    return printable(`response ${String(message.id)}`)
  }
  if (message.method !== undefined) {
    const item = message.params?.item
    const detail = item?.text !== undefined ? `: ${item.text}` : item?.type ? ` ${item.type}` : ''
    return printable(`${message.method}${detail}`)
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
