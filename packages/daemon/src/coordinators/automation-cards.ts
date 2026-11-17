import { createHash, randomUUID } from 'node:crypto'
import {
  type Automation,
  type AutomationCard,
  type AutomationCardAnswer,
  type AutomationCardResult,
  type AutomationCardRow,
  type AutomationCheckInput,
  type AutomationDraftRequest,
  type AutomationInput,
  agentDisplayNames,
  type EditAutomationRequest,
} from '@ted/protocol'
import type { Automations } from '../automations/automations.ts'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'

export type CardAutomations = Pick<
  Automations,
  'list' | 'detail' | 'create' | 'edit' | 'delete' | 'preview' | 'templates'
>

const app = { kind: 'app' } as const

export function automationFingerprint(a: Automation): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        a.name,
        a.prompt,
        a.schedule,
        a.agent,
        a.model ?? null,
        a.effort ?? null,
        a.on,
        a.checkout === true,
        a.template ?? null,
        a.check ?? null,
      ]),
    )
    .digest('hex')
}

export function draftFingerprint(input: AutomationDraftRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([input.kind, input.automation, input.create, input.edit]))
    .digest('hex')
}

function redactCheck<T extends AutomationCheckInput | undefined>(check: T): T {
  return check === undefined ? check : { ...check, command: redactSecrets(check.command) }
}

function redactCreate(input: AutomationInput): AutomationInput {
  return {
    ...input,
    name: redactSecrets(input.name),
    prompt: redactSecrets(input.prompt),
    ...(input.check && { check: redactCheck(input.check) }),
  }
}

function redactEdit(input: EditAutomationRequest): EditAutomationRequest {
  return {
    ...input,
    ...(input.name !== undefined && { name: redactSecrets(input.name) }),
    ...(input.prompt !== undefined && { prompt: redactSecrets(input.prompt) }),
    ...(input.check && { check: redactCheck(input.check) }),
  }
}

const yesNo = (value: boolean) => (value ? 'On' : 'Off')

function providerText(
  agent: Automation['agent'] | undefined,
  model?: string | null,
  effort?: string | null,
): string {
  if (agent === undefined) return 'The Factory’s default'
  return [
    agentDisplayNames[agent],
    model ?? 'default model',
    effort ? `${effort} effort` : 'default effort',
  ].join(' · ')
}

function scheduleText(automations: CardAutomations, schedule: Automation['schedule']) {
  const preview = automations.preview(schedule)
  if (preview.error !== undefined) throw new RequestError(400, `schedule: ${preview.error}`)
  return preview
}

function checkRows(
  check: AutomationCheckInput | Automation['check'] | undefined,
): AutomationCardRow[] {
  if (!check) return []
  return [
    { label: 'Check command', value: check.command, long: true },
    ...(check.timeout !== undefined ? [{ label: 'Timeout', value: check.timeout }] : []),
    ...(check.runBy ? [{ label: 'Run by', value: check.runBy }] : []),
    ...(check.agentStep !== undefined
      ? [{ label: 'Agent step', value: agentStepText[check.agentStep] }]
      : []),
  ]
}

const agentStepText = {
  'on-failure': 'When the check fails',
  always: 'After every run',
  never: 'Never',
} as const

function createCard(
  automations: CardAutomations,
  input: AutomationInput,
): Pick<AutomationCard, 'name' | 'rows' | 'nextFirings' | 'offersStartTasks' | 'create'> {
  const create = redactCreate(input)
  const preview = scheduleText(automations, create.schedule)
  const template =
    create.template && automations.templates().find((t) => t.id === create.template)?.name
  const rows: AutomationCardRow[] = [
    { label: 'Schedule', value: preview.text },
    ...(template ? [{ label: 'Template', value: template }] : []),
    ...(create.prompt.trim() !== ''
      ? [{ label: 'Prompt', value: create.prompt, long: true as const }]
      : []),
    ...checkRows(create.check),
    { label: 'Provider', value: providerText(create.agent, create.model, create.effort) },
    ...(create.check ? [] : [{ label: 'Checkout', value: yesNo(create.checkout === true) }]),
    {
      label: 'On',
      value:
        create.on === false
          ? 'Off: it won’t run until you turn it on'
          : 'On: it runs on its schedule once created',
    },
  ]
  return {
    name: create.name,
    rows,
    nextFirings: preview.nextFirings,
    offersStartTasks: create.check !== undefined && create.check.agentStep !== 'never',
    create,
  }
}

function editCard(
  automations: CardAutomations,
  current: Automation,
  input: EditAutomationRequest,
): Pick<AutomationCard, 'name' | 'rows' | 'nextFirings' | 'offersStartTasks' | 'edit'> {
  const edit = redactEdit(input)
  if (edit.check !== undefined && !current.check)
    throw new RequestError(400, 'an agent Automation can’t become a scheduled check')
  const rows: AutomationCardRow[] = []
  const differs = (label: string, before: string, after: string, long?: true) => {
    if (before !== after) rows.push({ label, before, value: after, ...(long && { long }) })
  }
  let nextFirings: string[] = []
  if (edit.name !== undefined) differs('Name', current.name, edit.name)
  if (edit.schedule !== undefined) {
    const preview = scheduleText(automations, edit.schedule)
    if (JSON.stringify(edit.schedule) !== JSON.stringify(current.schedule)) {
      rows.push({ label: 'Schedule', before: current.scheduleText, value: preview.text })
      nextFirings = preview.nextFirings
    }
  }
  if (edit.prompt !== undefined) differs('Prompt', current.prompt, edit.prompt, true)
  if (edit.check && current.check) {
    differs('Check command', current.check.command, edit.check.command, true)
    if (edit.check.timeout !== undefined)
      differs('Timeout', current.check.timeout, edit.check.timeout)
    if (edit.check.runBy !== undefined)
      differs('Run by', current.check.runBy ?? 'Not set', edit.check.runBy ?? 'Not set')
    if (edit.check.agentStep !== undefined)
      differs(
        'Agent step',
        agentStepText[current.check.agentStep],
        agentStepText[edit.check.agentStep],
      )
    if (edit.check.startTasks === false && current.check.startTasks)
      differs('Start the Tasks it creates', 'On', 'Off')
  }
  if (edit.agent !== undefined || edit.model !== undefined || edit.effort !== undefined) {
    const agent = edit.agent ?? current.agent
    const keep = agent === current.agent
    const model =
      edit.model === null ? undefined : (edit.model ?? (keep ? current.model : undefined))
    const effort =
      edit.effort === null ? undefined : (edit.effort ?? (keep ? current.effort : undefined))
    differs(
      'Provider',
      providerText(current.agent, current.model, current.effort),
      providerText(agent, model, effort),
    )
  }
  if (edit.checkout !== undefined)
    differs('Checkout', yesNo(current.checkout === true), yesNo(edit.checkout))
  if (edit.on !== undefined) differs('On', yesNo(current.on), yesNo(edit.on))
  if (rows.length === 0)
    throw new RequestError(400, 'the draft changes nothing about this Automation')
  const agentStep = edit.check?.agentStep ?? current.check?.agentStep
  const startsTasks = edit.check?.startTasks ?? current.check?.startTasks
  return {
    name: current.name,
    rows,
    nextFirings,
    offersStartTasks: current.check !== undefined && agentStep !== 'never' && startsTasks !== true,
    edit,
  }
}

function deleteCard(
  current: Automation,
): Pick<AutomationCard, 'name' | 'rows' | 'nextFirings' | 'offersStartTasks'> {
  const { runs, tasksCreated } = current.totals
  return {
    name: current.name,
    rows: [
      { label: 'Schedule', value: current.scheduleText },
      { label: 'Provider', value: providerText(current.agent, current.model, current.effort) },
      {
        label: 'So far',
        value: `${runs} ${runs === 1 ? 'run' : 'runs'}, ${tasksCreated} ${tasksCreated === 1 ? 'Task' : 'Tasks'} created`,
      },
    ],
    nextFirings: [],
    offersStartTasks: false,
  }
}

async function factoryAutomation(
  automations: CardAutomations,
  factoryId: string,
  ref: string,
): Promise<Automation | undefined> {
  try {
    return (await automations.detail(ref, app, factoryId)).automation
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return undefined
    throw error
  }
}

export async function buildAutomationCard(
  automations: CardAutomations,
  factoryId: string,
  input: AutomationDraftRequest,
  askedAt: string,
): Promise<Omit<AutomationCard, 'requestHash'>> {
  const model = input.create?.model ?? input.edit?.model
  if (model && redactSecrets(model) !== model)
    throw new RequestError(400, 'model looks like a secret; name a model instead')
  const base = { id: randomUUID(), kind: input.kind, operation: input.operation, askedAt }
  if (input.kind === 'create' && input.create)
    return { ...base, ...createCard(automations, input.create) }
  const current =
    input.automation && (await factoryAutomation(automations, factoryId, input.automation))
  if (!current) throw new RequestError(404, `no Automation “${input.automation}” in this Factory`)
  const target = { automationId: current.id, fingerprint: automationFingerprint(current) }
  if (input.kind === 'edit' && input.edit)
    return { ...base, ...target, ...editCard(automations, current, input.edit) }
  return { ...base, ...target, ...deleteCard(current) }
}

export async function carryOutAutomationCard(
  automations: CardAutomations,
  factoryId: string,
  card: AutomationCard,
  answer: AutomationCardAnswer,
  at: string,
): Promise<AutomationCardResult> {
  if (answer.decision === 'cancel') return { decision: 'cancel', at }
  if (answer.startTasks === true && !card.offersStartTasks)
    throw new RequestError(400, 'this card doesn’t offer Start the Tasks it creates')
  const startTasks = answer.startTasks === true
  const done = (automationId?: string): AutomationCardResult => ({
    decision: 'confirm',
    at,
    ...(automationId !== undefined && { automationId }),
    ...(startTasks && { startTasks: true }),
  })
  const refused = (why: string): AutomationCardResult => ({ decision: 'confirm', at, refused: why })
  const attempt = async (work: () => Promise<AutomationCardResult>) => {
    try {
      return await work()
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) return refused(error.message)
      throw error
    }
  }
  if (card.kind === 'create' && card.create) {
    const input = card.create
    return attempt(async () => {
      const created = await automations.create(
        {
          ...input,
          ...(input.check && { check: { ...input.check, startTasks } }),
          factory: factoryId,
        },
        app,
      )
      return done(created.id)
    })
  }
  const current =
    card.automationId === undefined
      ? undefined
      : await factoryAutomation(automations, factoryId, card.automationId)
  if (!current) return refused(`“${card.name}” was deleted after this card was shown`)
  if (automationFingerprint(current) !== card.fingerprint)
    return refused(`“${card.name}” changed after this card was shown`)
  if (card.kind === 'delete')
    return attempt(async () => {
      await automations.delete(current.id, app, factoryId)
      return done()
    })
  const edit = card.edit ?? {}
  const check =
    startTasks && current.check
      ? { ...(edit.check ?? { command: current.check.command }), startTasks: true }
      : edit.check
  return attempt(async () => {
    await automations.edit(current.id, { ...edit, ...(check && { check }) }, app, factoryId)
    return done(current.id)
  })
}
