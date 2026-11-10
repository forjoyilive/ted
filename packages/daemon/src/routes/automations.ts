import {
  type AnswerAutomationRequest,
  type AutomationInput,
  type AutomationSchedule,
  type AutomationTemplateId,
  automationTemplateIds,
  type CreateAutomationRequest,
  type EditAutomationRequest,
  type Weekday,
  weekdays,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { agentChoice, bodyObject, optionalText, type Route, readJson } from './route.ts'

const factoryQuery = '(?:\\?factory=([^&]*))?'
const ref = '([^/?]+)'
const maxPromptBytes = 100_000

const path = (pattern: string) => new RegExp(`^${pattern}$`)

export const automationRoutes: Route[] = [
  {
    method: 'GET',
    path: path(`/automations/templates`),
    runToken: true,
    handle: async (_, { automations }) => [200, automations.templates()],
  },
  {
    method: 'GET',
    path: path(`/automations/requests`),
    handle: async (_, { automations }) => [200, automations.requests()],
  },
  {
    method: 'POST',
    path: path(`/automations/schedule-preview`),
    fileToken: true,
    async handle({ req }, { automations }) {
      const body = bodyObject(await readJson(req))
      return [200, automations.preview(scheduleInput(body.schedule))]
    },
  },
  {
    method: 'GET',
    path: path(`/automations${factoryQuery}`),
    runToken: true,
    handle: async ({ caller, params: [factory = ''] }, { automations }) => [
      200,
      await automations.list(caller, factory === '' ? undefined : factory),
    ],
  },
  {
    method: 'POST',
    path: path(`/automations`),
    runToken: true,
    async handle({ req, caller }, { automations }) {
      const input = createInput(await readJson(req))
      return [201, await automations.create(input, caller)]
    },
  },
  {
    method: 'GET',
    path: path(`/automations/${ref}${factoryQuery}`),
    runToken: true,
    handle: async ({ caller, params: [id = '', factory = ''] }, { automations }) => [
      200,
      await automations.detail(id, caller, factory === '' ? undefined : factory),
    ],
  },
  {
    method: 'PATCH',
    path: path(`/automations/${ref}${factoryQuery}`),
    runToken: true,
    async handle({ req, caller, params: [id = '', factory = ''] }, { automations }) {
      const input = editInput(await readJson(req))
      return [200, await automations.edit(id, input, caller, factory || undefined)]
    },
  },
  ...(['enable', 'disable'] as const).map(
    (action): Route => ({
      method: 'POST',
      path: path(`/automations/${ref}/${action}${factoryQuery}`),
      runToken: true,
      ...(action === 'disable' && { fileToken: true as const }),
      handle: async ({ caller, params: [id = '', factory = ''] }, { automations }) => [
        200,
        await automations.setOn(id, action === 'enable', caller, factory || undefined),
      ],
    }),
  ),
  {
    method: 'POST',
    path: path(`/automations/${ref}/run${factoryQuery}`),
    runToken: true,
    handle: async ({ caller, params: [id = '', factory = ''] }, { automations }) => [
      201,
      await automations.runNow(id, caller, factory || undefined),
    ],
  },
  {
    method: 'DELETE',
    path: path(`/automations/${ref}${factoryQuery}`),
    runToken: true,
    async handle({ caller, params: [id = '', factory = ''] }, { automations }) {
      await automations.delete(id, caller, factory || undefined)
      return [200, { deleted: true }]
    },
  },
  {
    method: 'POST',
    path: path(`/automation-runs/${ref}/retry`),
    runToken: true,
    handle: async ({ caller, params: [id = ''] }, { automations }) => [
      201,
      await automations.retry(id, caller),
    ],
  },
  {
    method: 'POST',
    path: path(`/automation-runs/comments`),
    runToken: true,
    async handle({ req, caller }, { automations }) {
      const body = bodyObject(await readJson(req))
      const text = typeof body.body === 'string' ? body.body.trim() : ''
      if (text === '') throw new HttpError(400, 'body is required')
      const choices = optionalStrings(body.choices, 'choices')
      return [201, automations.comment(caller, { body: text, ...(choices && { choices }) })]
    },
  },
  {
    method: 'POST',
    path: path(`/automation-requests/${ref}/answer`),
    async handle({ req, params: [id = ''] }, { automations }) {
      const body = bodyObject(await readJson(req))
      const answer: AnswerAutomationRequest = {}
      const choice = optionalText(body.choice, 'choice')
      const text = optionalText(body.text, 'text')
      if (choice !== undefined) answer.choice = choice
      if (text !== undefined) answer.text = text
      return [200, await automations.answer(id, answer)]
    },
  },
]

function optionalStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new HttpError(400, `${name} must be a list of text`)
  }
  return (value as string[]).map((v) => v.trim())
}

const clock = /^([01]\d|2[0-3]):[0-5]\d$/

function scheduleInput(value: unknown): AutomationSchedule {
  const given = bodyObject(value)
  const at = () => {
    if (typeof given.at !== 'string' || !clock.test(given.at)) {
      throw new HttpError(400, 'schedule.at must be a time as HH:MM')
    }
    return given.at
  }
  switch (given.kind) {
    case 'every': {
      const unit = given.unit
      if (unit !== 'minutes' && unit !== 'hours') {
        throw new HttpError(400, 'schedule.unit must be minutes or hours')
      }
      if (typeof given.every !== 'number' || !Number.isInteger(given.every) || given.every < 1) {
        throw new HttpError(400, 'schedule.every must be a whole number')
      }
      return { kind: 'every', every: given.every, unit }
    }
    case 'daily':
      return { kind: 'daily', at: at() }
    case 'weekdays':
      return { kind: 'weekdays', at: at() }
    case 'weekly': {
      const days = given.days
      if (!Array.isArray(days) || days.some((d) => !weekdays.includes(d as Weekday))) {
        throw new HttpError(400, `schedule.days must be days from ${weekdays.join(', ')}`)
      }
      return { kind: 'weekly', days: [...new Set(days as Weekday[])], at: at() }
    }
    case 'custom': {
      const expression = given.expression
      if (typeof expression !== 'string' || expression.trim() === '') {
        throw new HttpError(400, 'schedule.expression must be a cron or RRULE')
      }
      if (expression.length > 1000) throw new HttpError(400, 'schedule.expression is too long')
      return { kind: 'custom', expression: expression.trim() }
    }
    default:
      throw new HttpError(400, 'schedule.kind must be every, daily, weekdays, weekly or custom')
  }
}

function fields(body: Record<string, unknown>): Partial<Omit<AutomationInput, 'template'>> {
  const out: Partial<Omit<AutomationInput, 'template'>> = {}
  const name = optionalText(body.name, 'name')
  const prompt = optionalText(body.prompt, 'prompt')
  if (name !== undefined) out.name = name
  if (prompt !== undefined) {
    if (Buffer.byteLength(prompt) > maxPromptBytes) throw new HttpError(413, 'prompt is too long')
    out.prompt = prompt
  }
  if (body.schedule !== undefined) out.schedule = scheduleInput(body.schedule)
  Object.assign(out, agentChoice(body))
  if (body.on !== undefined) {
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false')
    out.on = body.on
  }
  return out
}

function createInput(value: unknown): CreateAutomationRequest {
  const body = bodyObject(value)
  const { name, prompt, schedule, ...rest } = fields(body)
  if (name === undefined) throw new HttpError(400, 'name is required')
  if (prompt === undefined) throw new HttpError(400, 'prompt is required')
  if (schedule === undefined) throw new HttpError(400, 'schedule is required')
  const input: CreateAutomationRequest = { name, prompt, schedule, ...rest }
  const factory = optionalText(body.factory, 'factory')
  if (factory !== undefined) input.factory = factory
  if (body.template !== undefined) {
    if (!automationTemplateIds.includes(body.template as AutomationTemplateId)) {
      throw new HttpError(400, `template must be one of ${automationTemplateIds.join(', ')}`)
    }
    input.template = body.template as AutomationTemplateId
  }
  if (body.runNow !== undefined) {
    if (typeof body.runNow !== 'boolean') throw new HttpError(400, 'runNow must be true or false')
    input.runNow = body.runNow
  }
  return input
}

function editInput(value: unknown): EditAutomationRequest {
  const body = bodyObject(value)
  if (body.template !== undefined) throw new HttpError(400, 'the template is chosen at creation')
  const { model, effort, ...rest } = body
  const out: EditAutomationRequest = fields({
    ...rest,
    ...(model !== null && { model }),
    ...(effort !== null && { effort }),
  })
  if (model === null) out.model = null
  if (effort === null) out.effort = null
  return out
}
