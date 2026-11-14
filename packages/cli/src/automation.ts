import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { withDaemon as connectDaemon } from '@ted/daemon/launch'
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
import { shortReference } from '@ted/protocol/reference'

export class AutomationUsageError extends Error {}

export interface AutomationOptions {
  factory?: string
  name?: string
  schedule?: string
  'prompt-file'?: string
  template?: string
  agent?: string
  model?: string
  effort?: string
  off?: boolean
}

const appOnly = 'only the TED app can do this'

import type { commands } from './commands.ts'

export type AutomationCommand = Extract<
  (typeof commands)[number],
  { name: `automation ${string}` }
>['handler'] extends infer H
  ? H extends `automation${infer Name}`
    ? Uncapitalize<Name>
    : never
  : never

export async function automationCommand(
  home: string,
  command: AutomationCommand,
  rest: string[],
  options: AutomationOptions,
  runtime: { connect: typeof connectDaemon; log: (text: string) => void; runId?: string },
): Promise<void> {
  const withDaemon = runtime.connect
  const console = { log: runtime.log }
  const factory = options.factory
  const one = () => rest[0] ?? ''
  const actions = {
    list: async () => {
      const list = await withDaemon(home, (client) => client.listAutomations(factory))
      console.log(list.length === 0 ? 'No Automations yet.' : list.map(listLine).join('\n'))
    },
    show: async () => {
      const ref = one()
      const { automation, history } = await withDaemon(home, (client) =>
        client.getAutomation(ref, factory),
      )
      console.log(showText(automation, history))
    },
    history: async () => {
      const ref = one()
      const { history } = await withDaemon(home, (client) => client.getAutomation(ref, factory))
      console.log(history.length === 0 ? 'No Runs yet.' : history.map(historyLine).join('\n'))
    },
    create: async () => {
      const input = await createInput(home, options)
      const automation = await withDaemon(home, (client) => client.createAutomation(input))
      console.log(`Created Automation ${shortId(automation)}  ${printable(automation.name)}`)
      console.log(`  ${printable(automation.scheduleText)}${nextLine(automation)}`)
    },
    edit: async () => {
      const ref = one()
      const input = await editInput(options)
      const automation = await withDaemon(home, (client) =>
        client.editAutomation(ref, input, factory),
      )
      console.log(`Changed Automation ${shortId(automation)}  ${printable(automation.name)}`)
    },
    enable: async () => {
      const ref = one()
      const automation = await withDaemon(home, (client) =>
        client.setAutomationOn(ref, true, factory),
      )
      console.log(
        `${printable(automation.name)} is ${automation.on ? `on${nextLine(automation)}` : 'off'}`,
      )
    },
    disable: async () => {
      const ref = one()
      const automation = await withDaemon(home, (client) =>
        client.setAutomationOn(ref, false, factory),
      )
      console.log(
        `${printable(automation.name)} is ${automation.on ? `on${nextLine(automation)}` : 'off'}`,
      )
    },
    run: async () => {
      const ref = one()
      const run = await withDaemon(home, async (client) => {
        const started = await client.runAutomation(ref, factory)
        const { automation } = await client.getAutomation(ref, factory)
        return { started, automation }
      })
      console.log(`Running ${printable(run.automation.name)} now (Run ${run.started.id})`)
    },
    delete: async () => {
      const ref = one()
      await withDaemon(home, (client) => client.deleteAutomation(ref, factory))
      console.log('Deleted the Automation and its history. Tasks it created stay.')
    },
    output: async () => {
      const runId = rest[0] ?? runtime.runId
      if (runId === undefined)
        throw new AutomationUsageError('name the Run: ted automation output <run-id>')
      const output = await withDaemon(home, (client) => client.automationRunOutput(runId))
      console.log(output.text === '' ? 'No output.' : printable(output.text))
    },
    note: async () => {
      const [task = '', ...words] = rest
      const text = words.join(' ').trim()
      if (text === '') throw new AutomationUsageError('give the note as text')
      const noted = await withDaemon(home, (client) => client.noteAutomationTask(task, text))
      console.log(`Added a note to ${noted.displayId}`)
    },
    start: async () => {
      const started = await withDaemon(home, (client) => client.startAutomationTask(one()))
      console.log(`Started ${started.displayId}. It waits in the queue for a free slot.`)
    },
    report: async () => {
      const summary = rest.join(' ').trim()
      if (summary === '') throw new AutomationUsageError('give a summary as text')
      await withDaemon(home, (client) => client.reportAutomationRun(summary))
      console.log('Reported. TED makes no Tasks of its own for this firing.')
    },
  }
  try {
    await actions[command]()
  } catch (error) {
    if (error instanceof Error && error.message === appOnly) {
      throw new Error(
        'Create, change, run or delete Automations in the TED app. From a terminal, ted automation can list, show, history and disable.',
      )
    }
    throw error
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
    if (options['prompt-file'] !== undefined) {
      input.prompt = await readFile(path.resolve(options['prompt-file']), 'utf8')
    }
    if (options.agent !== undefined) {
      if (!agentKinds.includes(options.agent as AgentKind)) {
        throw new AutomationUsageError('--agent must be claude, codex or antigravity')
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
    case 'passed':
      return 'Passed'
    case 'check-failed':
      return `Failed${result.tasks.length > 0 ? ` · created ${result.tasks.map((t) => t.displayId).join(', ')}` : ''}${run.check?.updated?.length ? ` · updated ${run.check.updated.map((t) => t.displayId).join(', ')}` : ''}`
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
  return `${when(run.startedAt ?? run.at)}  ${triggerText(run)}  ${resultText(run)}${retried}  (Run ${shortReference(run.id)})${message}`
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
