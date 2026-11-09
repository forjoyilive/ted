#!/usr/bin/env node
import path from 'node:path'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { withDaemon } from '@ted/daemon/launch'
import { checkWorkflowPath, NothingToCheckError } from '@ted/daemon/workflow'
import {
  type AgentKind,
  agentKinds,
  type Banner,
  DaemonClient,
  DaemonUnreachableError,
  type Effort,
  efforts,
  type Factory,
  type IntegrationsHealth,
  isShowing,
  minGhVersion,
  parseLinearUrl,
  type RunWithConversation,
  readDaemonInfo,
  type TaskLead,
  tedHome,
  tedPaths,
} from '@ted/protocol'

const usage = `Usage:
  ted help                                   Show this list of commands
  ted status                                 Show whether TED is running and every active problem
  ted doctor                                 Run health checks and show every active problem
  ted open                                   Bring the open TED app to the front
  ted comment [--task <id>] "<text>"         Post a note on the Task (reads stdin if no text)
  ted outcome advance [--task <id>]          End the current Stage and move the Task on
  ted status [--task <id>] "<text>"          Set the Task's activity line
  ted task create [--factory <key>] [--source <url>] "<title>"
                                             Create a Task; a Linear URL fills it from Linear
  ted task list                              List Tasks with their Stages
  ted task start <id>                        Start a Task from Backlog
  ted backup list                            List backups of TED's data, newest first
  ted backup restore <name> [--yes]          Restore a backup (asks before stopping Runs)
  ted task lead <id> claude|codex [--model <name>] [--effort <level>]
                                             Set the Task Lead's agent, model and effort
  ted task lead <id> --default-model         Run this Task Lead on the CLI's default model
                                             when its model isn't available
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
        'default-model': { type: 'boolean' },
        effort: { type: 'string' },
        model: { type: 'string' },
        factory: { type: 'string' },
        key: { type: 'string' },
        'local-folder': { type: 'string' },
        source: { type: 'string' },
        task: { type: 'string' },
        yes: { type: 'boolean' },
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
  } else if (group === 'status' && command === undefined) {
    await status()
  } else if (group === 'doctor' && command === undefined) {
    await doctor()
  } else if (group === 'open' && command === undefined) {
    await openApp()
  } else if (group === 'comment') {
    const ref = taskRef()
    const body = [command, ...rest].filter((s) => s !== undefined).join(' ') || (await readStdin())
    if (body.trim() === '') throw new UsageError('give the Comment as text or on stdin')
    await withDaemon(home, (client) => client.postComment(ref, body))
    console.log('Posted')
  } else if (group === 'status' && command !== undefined) {
    const ref = taskRef()
    const text = [command, ...rest].join(' ')
    await withDaemon(home, (client) => client.setActivity(ref, text))
    console.log('Activity line set')
  } else if (group === 'outcome' && command === 'advance' && rest.length === 0) {
    const ref = taskRef()
    const task = await withDaemon(home, (client) => client.reportOutcome(ref, 'advance'))
    console.log(`${task.displayId} moved to ${stageName(task.stage)}`)
  } else if (
    group === 'task' &&
    command === 'create' &&
    (rest.length > 0 || options.source !== undefined)
  ) {
    const title = rest.join(' ')
    const { factory, source } = options
    const task = await withDaemon(home, async (client) => {
      if (source !== undefined && parseLinearUrl(source)) {
        const lookup = await client.lookupLinear(source)
        if (lookup.state === 'no-key') {
          console.error(
            'No Linear API key, so the Task was created with the link only. Add one in Settings → Integrations.',
          )
        } else if (lookup.state === 'failed') {
          console.error(printable(lookup.error))
        }
      }
      return client.createTask({
        ...(title !== '' && { title }),
        ...(factory !== undefined && { factory }),
        ...(source !== undefined && { source }),
      })
    })
    console.log(`Created ${task.displayId}  ${printable(task.title)}`)
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
    console.log(
      task.status?.kind === 'queued'
        ? `Queued ${task.displayId} · ${'place' in task.status ? `${ordinal(task.status.place)} in line for a slot` : task.status.hold}`
        : `Started ${task.displayId} on branch ${task.branch}`,
    )
  } else if (group === 'backup' && command === 'list' && rest.length === 0) {
    const { backups } = await withDaemon(home, (client) => client.listBackups())
    console.log(
      backups.length === 0
        ? 'No backups yet.'
        : backups.map((b) => `${b.name}  ${b.kind}  ${formatDate(b.takenAt)}`).join('\n'),
    )
  } else if (group === 'backup' && command === 'restore' && rest.length === 1) {
    await restoreBackup(rest[0] ?? '')
  } else if (
    group === 'task' &&
    command === 'lead' &&
    rest.length === 1 &&
    options['default-model']
  ) {
    const ref = rest[0] ?? ''
    const task = await withDaemon(home, (client) => client.useDefaultModel(ref))
    console.log(`${task.displayId}’s Task Lead now runs on the default model`)
  } else if (group === 'task' && command === 'lead' && rest.length === 2) {
    const [ref = '', agent = ''] = rest
    const { model, effort } = options
    if (!agentKinds.includes(agent as AgentKind))
      throw new UsageError('agent must be claude or codex')
    if (effort !== undefined && !efforts.includes(effort as Effort)) {
      throw new UsageError(`--effort must be one of ${efforts.join(', ')}`)
    }
    const lead: TaskLead = {
      agent: agent as AgentKind,
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort: effort as Effort }),
    }
    const task = await withDaemon(home, (client) => client.setTaskLead(ref, lead))
    console.log(`${task.displayId}’s Task Lead is ${describeLead(task.lead ?? lead)}`)
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

async function restoreBackup(name: string): Promise<void> {
  await withDaemon(home, async (client) => {
    const { backups, activeRuns } = await client.listBackups()
    if (!backups.some((b) => b.name === name)) throw new Error(`no backup ${name}`)
    if (activeRuns > 0 && !options.yes) {
      const runs = activeRuns === 1 ? '1 Run' : `${activeRuns} Runs`
      const them = activeRuns === 1 ? 'it' : 'them'
      process.stdout.write(`Restoring stops ${runs}. Stop ${them} and restore? [y/N] `)
      if (!/^y(es)?$/i.test((await readLine()).trim())) throw new Error('nothing restored')
    }
    const result = await client.restoreBackup({ name, stopRuns: true })
    if (result.stoppedRuns > 0) {
      console.log(`Stopped ${result.stoppedRuns === 1 ? '1 Run' : `${result.stoppedRuns} Runs`}.`)
    }
    console.log(`Restored ${result.restored}.`)
    console.log(`Your data from before the restore is in backup ${result.saved}.`)
  })
}

async function readLine(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    const newline = text.indexOf('\n')
    if (newline >= 0) return text.slice(0, newline)
  }
  return text
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function problems(): Promise<{ pid: number | undefined; banners: string[]; stops: boolean }> {
  const { banners, factories } = await withDaemon(home, async (client) => ({
    banners: await client.listBanners(),
    factories: await client.listFactories(),
  }))
  const pid = (await readDaemonInfo(home))?.pid
  return {
    pid,
    banners: formatBanners(banners, factories),
    stops: banners.some((b) => b.severity === 'stops-work'),
  }
}

async function openApp(): Promise<void> {
  const info = await readDaemonInfo(home)
  const token = process.env.TED_RUN_TOKEN || info?.token
  const result = await (info ? new DaemonClient(info, token).openApp() : undefined)?.catch(
    (error: unknown) => {
      if (error instanceof DaemonUnreachableError) return undefined
      throw error
    },
  )
  if (!result?.opened) {
    console.error('ted: TED isn’t open. Open it from your app launcher.')
    process.exitCode = 1
    return
  }
  console.log('Opened TED')
}

async function status(): Promise<void> {
  const { pid, banners } = await problems()
  console.log(`TED’s background process is running (pid ${pid ?? 'unknown'})`)
  console.log(banners.join('\n'))
}

async function doctor(): Promise<void> {
  const health = await withDaemon(home, (client) => client.checkIntegrations())
  const { pid, banners, stops } = await problems()
  console.log(`✓ TED’s background process is running (pid ${pid ?? 'unknown'})`)
  const lines = integrationLines(health)
  console.log(lines.map((line) => printable(line)).join('\n'))
  console.log(banners.join('\n'))
  if (stops || health.git.state === 'not-installed') process.exitCode = 1
}

function integrationLines({ git, github }: IntegrationsHealth): string[] {
  const identity = [git.name, git.email && `<${git.email}>`].filter(Boolean).join(' ')
  const gitLine =
    git.state === 'not-installed'
      ? `✗ git not found · ${git.fix?.command ?? ''}`
      : git.state === 'no-identity'
        ? `! git ${git.version} has no name or email set · ${(git.copy ?? []).join(' && ')}`
        : `✓ git ${git.version} · ${identity}`
  const { cli } = github
  const ghLine =
    cli.state === 'ready'
      ? `✓ gh ${cli.version} · ${cli.path}`
      : cli.state === 'not-installed'
        ? `✗ gh not found · ${cli.fix?.command ?? ''}`
        : cli.state === 'too-old'
          ? `✗ gh ${cli.version} is older than ${minGhVersion} · ${cli.fix?.command ?? ''}`
          : `✗ gh isn’t working · ${cli.error ?? ''}`
  const hostLines =
    cli.state === 'ready'
      ? github.hosts.map((host) => {
          if (host.state === 'ready') return `✓ ${host.host} · signed in as ${host.login ?? '?'}`
          if (host.state === 'missing-workflow-scope') {
            return `! ${host.host} · can’t push changes to GitHub Actions workflows · ${host.fix?.command ?? ''}`
          }
          if (host.state === 'signed-out') {
            return `✗ ${host.host} · signed out · ${host.fix?.command ?? ''}`
          }
          return `✗ ${host.host} · ${host.error ?? 'couldn’t check'}`
        })
      : []
  return [gitLine, ghLine, ...hostLines]
}

function formatBanners(banners: Banner[], factories: Factory[]): string[] {
  if (banners.length === 0) return ['No problems.']
  const where = (b: Banner) =>
    b.factoryId === undefined
      ? 'TED'
      : (factories.find((f) => f.id === b.factoryId)?.name ?? 'a Factory')
  const rows = banners.map((b) => [
    b.severity === 'stops-work' ? 'Stops work' : 'Warning',
    where(b),
    [
      printable(b.text),
      ...(b.action ? [`[${printable(b.action.label)}]`] : []),
      ...(isShowing(b) ? [] : [`(dismissed until ${b.dismissedUntil})`]),
    ].join('  '),
  ])
  const width = (column: number) => Math.max(...rows.map((row) => row[column]?.length ?? 0))
  return [
    `${banners.length} ${banners.length === 1 ? 'problem' : 'problems'}:`,
    ...rows.map(([kind = '', place = '', rest]) =>
      ['  ', kind.padEnd(width(0)), '  ', place.padEnd(width(1)), '  ', rest].join(''),
    ),
  ]
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

function describeLead({ agent, model, effort }: TaskLead): string {
  return [agent, model ?? 'default model', effort ?? 'default effort'].join(' · ')
}

function formatRun({ run, conversation }: RunWithConversation): string {
  return [
    `Run ${run.id}  ${run.agent}  ${run.state}${run.problem === 'model-unavailable' ? '  model unavailable' : ''}`,
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

function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')
  return `${n}${suffix}`
}
