import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { withDaemon } from '@ted/daemon/launch'
import {
  type AgentKind,
  type Automation,
  type AutomationInput,
  type AutomationNow,
  type AutomationRun,
  type AutomationTemplateId,
  agentKinds,
  automationTemplateIds,
  type CreateAutomationRequest,
  type Effort,
  efforts,
  scheduleFromExpression,
} from '@ted/protocol'

export class AutomationUsageError extends Error {}

export interface AutomationOptions {
  factory?: string
  name?: string
  schedule?: string
  tz?: string
  'prompt-file'?: string
  template?: string
  agent?: string
  model?: string
  effort?: string
  off?: boolean
}

export const automationUsage = `  ted automation list                        List the Factory’s Automations
  ted automation show <id>                   Show an Automation: schedule, next firings, prompt
  ted automation history <id>                Show an Automation’s Runs, newest first
  ted automation create --name <name> --schedule "<cron|RRULE>" --prompt-file <file>
                [--tz <zone>] [--template linear|sentry|github] [--agent claude|codex]
                [--model <name>] [--effort <level>] [--off]
                                             Create an Automation (a template fills in what you
                                             leave out)
  ted automation edit <id> [same flags as create]
                                             Change an Automation
  ted automation enable <id> / disable <id>  Turn an Automation on or off
  ted automation run <id>                    Run an Automation now
  ted automation delete <id>                 Delete an Automation and its history
                Every automation command takes --factory <key>. Inside a Run only list, show
                and history work; from a terminal, create, edit, enable, run and delete are
                refused, because only the TED app may schedule agent Runs.`

const appOnly = 'only the TED app can do this'

export async function automationCommand(
  home: string,
  command: string | undefined,
  rest: string[],
  options: AutomationOptions,
): Promise<void> {
  try {
    await automationAction(home, command, rest, options)
  } catch (error) {
    if (error instanceof Error && error.message === appOnly) {
      throw new Error(
        'Create, change, run or delete Automations in the TED app. From a terminal, ted automation can list, show, history and disable.',
      )
    }
    throw error
  }
}

async function automationAction(
  home: string,
  command: string | undefined,
  rest: string[],
  options: AutomationOptions,
): Promise<void> {
  const factory = options.factory
  const one = () => {
    if (rest.length !== 1 || rest[0] === undefined) {
      throw new AutomationUsageError(`name the Automation: ted automation ${command} <id>`)
    }
    return rest[0]
  }
  if (command === 'list' && rest.length === 0) {
    const list = await withDaemon(home, (client) => client.listAutomations(factory))
    console.log(list.length === 0 ? 'No Automations yet.' : list.map(listLine).join('\n'))
  } else if (command === 'show') {
    const ref = one()
    const { automation, history } = await withDaemon(home, (client) =>
      client.getAutomation(ref, factory),
    )
    console.log(showText(automation, history))
  } else if (command === 'history') {
    const ref = one()
    const { history } = await withDaemon(home, (client) => client.getAutomation(ref, factory))
    console.log(history.length === 0 ? 'No Runs yet.' : history.map(historyLine).join('\n'))
  } else if (command === 'create' && rest.length === 0) {
    const input = await createInput(home, options)
    const automation = await withDaemon(home, (client) => client.createAutomation(input))
    console.log(`Created Automation ${shortId(automation)}  ${printable(automation.name)}`)
    console.log(`  ${printable(automation.scheduleText)}${nextLine(automation)}`)
  } else if (command === 'edit') {
    const ref = one()
    const input = await editInput(options)
    const automation = await withDaemon(home, (client) =>
      client.editAutomation(ref, input, factory),
    )
    console.log(`Changed Automation ${shortId(automation)}  ${printable(automation.name)}`)
  } else if (command === 'enable' || command === 'disable') {
    const ref = one()
    const automation = await withDaemon(home, (client) =>
      client.setAutomationOn(ref, command === 'enable', factory),
    )
    console.log(
      `${printable(automation.name)} is ${automation.on ? `on${nextLine(automation)}` : 'off'}`,
    )
  } else if (command === 'run') {
    const ref = one()
    const run = await withDaemon(home, async (client) => {
      const started = await client.runAutomation(ref, factory)
      const { automation } = await client.getAutomation(ref, factory)
      return { started, automation }
    })
    console.log(`Running ${printable(run.automation.name)} now (Run ${run.started.id})`)
  } else if (command === 'delete') {
    const ref = one()
    await withDaemon(home, (client) => client.deleteAutomation(ref, factory))
    console.log('Deleted the Automation and its history. Tasks it created stay.')
  } else {
    throw new AutomationUsageError('')
  }
}

async function createInput(
  home: string,
  options: AutomationOptions,
): Promise<CreateAutomationRequest> {
  const template =
    options.template === undefined
      ? undefined
      : await withDaemon(home, async (client) => {
          const id = options.template as AutomationTemplateId
          if (!automationTemplateIds.includes(id)) {
            throw new AutomationUsageError(
              `--template must be one of ${automationTemplateIds.join(', ')}`,
            )
          }
          return (await client.automationTemplates()).find((t) => t.id === id)
        })
  const fields = await editInput(options)
  const name = fields.name ?? template?.name
  const prompt = fields.prompt ?? template?.prompt
  const schedule = fields.schedule ?? template?.schedule
  if (name === undefined) throw new AutomationUsageError('give the Automation a --name')
  if (schedule === undefined) {
    throw new AutomationUsageError('give a --schedule: a 5-field cron or an RRULE')
  }
  if (prompt === undefined) throw new AutomationUsageError('give the prompt with --prompt-file')
  return {
    ...fields,
    name,
    prompt,
    schedule,
    timeZone: fields.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(template && { template: template.id }),
    ...(options.factory !== undefined && { factory: options.factory }),
  }
}

async function editInput(
  options: AutomationOptions,
): Promise<Partial<Omit<AutomationInput, 'template'>>> {
  const input: Partial<Omit<AutomationInput, 'template'>> = {}
  if (options.name !== undefined) input.name = options.name
  if (options.schedule !== undefined) input.schedule = scheduleFromExpression(options.schedule)
  if (options.tz !== undefined) input.timeZone = options.tz
  if (options['prompt-file'] !== undefined) {
    input.prompt = await readFile(path.resolve(options['prompt-file']), 'utf8')
  }
  if (options.agent !== undefined) {
    if (!agentKinds.includes(options.agent as AgentKind)) {
      throw new AutomationUsageError('--agent must be claude or codex')
    }
    input.agent = options.agent as AgentKind
  }
  if (options.model !== undefined) input.model = options.model
  if (options.effort !== undefined) {
    if (!efforts.includes(options.effort as Effort)) {
      throw new AutomationUsageError(`--effort must be one of ${efforts.join(', ')}`)
    }
    input.effort = options.effort as Effort
  }
  if (options.off === true) input.on = false
  return input
}

const shortId = (automation: { id: string }) => automation.id.slice(0, 8)

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function nextLine(automation: Automation): string {
  const next = automation.nextFirings[0]
  return next === undefined ? '' : ` · next ${when(next)}`
}

function nowText(now: AutomationNow | undefined): string | undefined {
  if (!now) return undefined
  if (now.kind === 'working') return 'Working'
  if (now.kind === 'waiting') return 'Waiting on you'
  if (now.kind === 'queued') return now.place > 0 ? `Queued · ${ordinal(now.place)}` : 'Queued'
  return `Paused · ${now.reason}`
}

function listLine(automation: Automation): string {
  const state = automation.on ? (nowText(automation.now) ?? 'On') : 'Off'
  return [
    shortId(automation),
    automation.factoryKey,
    printable(automation.name),
    printable(automation.scheduleText) + (automation.on ? nextLine(automation) : ''),
    state,
  ].join('  ')
}

export function resultText(run: AutomationRun): string {
  const result = run.result
  switch (result.kind) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'created':
      return `Created ${result.tasks.map((t) => t.displayId).join(', ')}`
    case 'no-new-tasks':
      return 'No new Tasks'
    case 'failed':
      return `Failed: ${printable(result.error)}`
    case 'skipped':
      return 'Skipped: previous Run still working'
    case 'stopped':
      return 'Stopped by you'
    case 'dropped':
      return 'Dropped: the Automation was turned off'
  }
}

function triggerText(run: AutomationRun): string {
  if (run.trigger === 'scheduled') return 'Scheduled'
  if (run.trigger === 'made-up') return `Made up${run.slotAt ? ` for ${when(run.slotAt)}` : ''}`
  if (run.trigger === 'run-now') return 'Run now'
  return 'Retry'
}

function historyLine(run: AutomationRun): string {
  const retried = run.retriedAt === undefined ? '' : ` · Retried at ${when(run.retriedAt)}`
  const message = run.message === undefined ? '' : `\n    ${printable(run.message)}`
  return `${when(run.startedAt ?? run.at)}  ${triggerText(run)}  ${resultText(run)}${retried}  (Run ${run.id})${message}`
}

function showText(automation: Automation, history: AutomationRun[]): string {
  const model = [automation.agent, automation.model, automation.effort].filter(Boolean).join(' · ')
  return [
    `${printable(automation.name)}  (${automation.id})`,
    `Factory ${automation.factoryKey} · ${automation.on ? 'On' : 'Off'} · ${model}`,
    `Schedule: ${printable(automation.scheduleText)}`,
    ...(automation.nextFirings.length > 0
      ? [`Next firings: ${automation.nextFirings.map(when).join(', ')}`]
      : []),
    ...(nowText(automation.now) ? [`Now: ${nowText(automation.now)}`] : []),
    ...(history[0] ? [`Last: ${historyLine(history[0])}`] : []),
    `Runs: ${automation.totals.runs} · Tasks created: ${automation.totals.tasksCreated}`,
    '',
    printable(automation.prompt.trim()),
  ].join('\n')
}

function printable(text: string): string {
  return [...stripVTControlCharacters(text)]
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0
      return !((code < 0x20 && c !== '\t' && c !== '\n') || (code >= 0x7f && code <= 0x9f))
    })
    .join('')
}

function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')
  return `${n}${suffix}`
}
