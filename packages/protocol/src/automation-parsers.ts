import type {
  AutomationCommentRequest,
  AutomationNoteTaskRequest,
  AutomationReportRequest,
  SchedulePreviewRequest,
} from './automation.ts'
import {
  type AnswerAutomationRequest,
  type AutomationCheckInput,
  type AutomationInput,
  type AutomationTemplateId,
  automationTemplateIds,
  type CheckAgentStep,
  type CreateAutomationRequest,
  checkAgentSteps,
  type DraftAutomationPromptRequest,
  type EditAutomationRequest,
} from './automation.ts'
import { type AutomationSchedule, type Weekday, weekdays } from './schedule.ts'
import {
  agentChoice,
  bodyObject,
  RequestValidationError as HttpError,
  optionalText,
} from './validation.ts'

const maxPromptBytes = 100_000
function optionalStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new HttpError(400, `${name} must be a list of text`)
  }
  return (value as string[]).map((v) => v.trim())
}

const clock = /^([01]\d|2[0-3]):[0-5]\d$/

export function parseAutomationSchedule(value: unknown): AutomationSchedule {
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

const maxCommandLength = 2000
const timeoutPattern = /^[1-9]\d{0,4}[smh]$/
const maxTimeoutMs = 24 * 60 * 60 * 1000

function timeoutMs(text: string): number {
  const amount = Number.parseInt(text, 10)
  const unit = text.at(-1)
  return amount * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000)
}

export function parseAutomationCheck(value: unknown): AutomationCheckInput {
  const given = bodyObject(value, 'check')
  const command = typeof given.command === 'string' ? given.command.trim() : ''
  if (command === '') throw new HttpError(400, 'check.command is required')
  if (command.length > maxCommandLength) throw new HttpError(400, 'check.command is too long')
  if (command.includes('\0')) throw new HttpError(400, 'check.command can’t hold a NUL byte')
  const check: AutomationCheckInput = { command }
  if (given.timeout !== undefined) {
    if (
      typeof given.timeout !== 'string' ||
      !timeoutPattern.test(given.timeout) ||
      timeoutMs(given.timeout) > maxTimeoutMs
    ) {
      throw new HttpError(400, 'check.timeout must be like 90m or 2h, at most 24h')
    }
    check.timeout = given.timeout
  }
  if (given.runBy === null) check.runBy = null
  else if (given.runBy !== undefined) {
    if (typeof given.runBy !== 'string' || !clock.test(given.runBy)) {
      throw new HttpError(400, 'check.runBy must be a time as HH:MM')
    }
    check.runBy = given.runBy
  }
  if (given.agentStep !== undefined) {
    if (!checkAgentSteps.includes(given.agentStep as CheckAgentStep)) {
      throw new HttpError(400, `check.agentStep must be one of ${checkAgentSteps.join(', ')}`)
    }
    check.agentStep = given.agentStep as CheckAgentStep
  }
  if (given.startTasks !== undefined) {
    if (typeof given.startTasks !== 'boolean') {
      throw new HttpError(400, 'check.startTasks must be true or false')
    }
    check.startTasks = given.startTasks
  }
  return check
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
  if (body.schedule !== undefined) out.schedule = parseAutomationSchedule(body.schedule)
  Object.assign(out, agentChoice(body))
  if (body.on !== undefined) {
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false')
    out.on = body.on
  }
  if (body.checkout !== undefined) {
    if (typeof body.checkout !== 'boolean') {
      throw new HttpError(400, 'checkout must be true or false')
    }
    out.checkout = body.checkout
  }
  if (body.check !== undefined) out.check = parseAutomationCheck(body.check)
  return out
}

export function parseCreateAutomationRequest(value: unknown): CreateAutomationRequest {
  const body = bodyObject(value)
  const { name, prompt, schedule, ...rest } = fields(body)
  if (name === undefined) throw new HttpError(400, 'name is required')
  if (prompt === undefined && rest.check === undefined) {
    throw new HttpError(400, 'prompt is required')
  }
  if (schedule === undefined) throw new HttpError(400, 'schedule is required')
  if (rest.check?.runBy === null) throw new HttpError(400, 'check.runBy must be a time as HH:MM')
  const input: CreateAutomationRequest = { name, prompt: prompt ?? '', schedule, ...rest }
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

export function parseEditAutomationRequest(value: unknown): EditAutomationRequest {
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

export function parseDraftAutomationPromptRequest(value: unknown): DraftAutomationPromptRequest {
  const body = bodyObject(value)
  if (typeof body.factory !== 'string' || typeof body.request !== 'string') {
    throw new HttpError(400, 'factory and request are required text')
  }
  const input: DraftAutomationPromptRequest = {
    factory: body.factory,
    request: body.request,
    ...agentChoice(body),
  }
  const name = optionalText(body.name, 'name')
  const prompt = optionalText(body.prompt, 'prompt')
  if (name !== undefined) input.name = name
  if (prompt !== undefined) input.prompt = prompt
  return input
}

export function parseSchedulePreviewRequest(value: unknown): SchedulePreviewRequest {
  const body = bodyObject(value)
  return { schedule: parseAutomationSchedule(body.schedule) }
}

export function parseAutomationCommentRequest(value: unknown): AutomationCommentRequest {
  const body = bodyObject(value)
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (text === '') throw new HttpError(400, 'body is required')
  const choices = optionalStrings(body.choices, 'choices')
  return { body: text, ...(choices && { choices }) }
}

export function parseAnswerAutomationRequest(value: unknown): AnswerAutomationRequest {
  const body = bodyObject(value)
  const answer: AnswerAutomationRequest = {}
  const choice = optionalText(body.choice, 'choice')
  const text = optionalText(body.text, 'text')
  if (choice !== undefined) answer.choice = choice
  if (text !== undefined) answer.text = text
  return answer
}

export const maxAutomationNoteLength = 20_000
export const maxAutomationReportLength = 4_000

export function parseAutomationNoteTaskRequest(value: unknown): AutomationNoteTaskRequest {
  const body = bodyObject(value)
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (text === '') throw new HttpError(400, 'body is required')
  if (text.length > maxAutomationNoteLength) {
    throw new HttpError(413, `a note is at most ${maxAutomationNoteLength} characters`)
  }
  return { body: text }
}

export function parseAutomationReportRequest(value: unknown): AutomationReportRequest {
  const body = bodyObject(value)
  const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
  if (summary === '') throw new HttpError(400, 'summary is required')
  if (summary.length > maxAutomationReportLength) {
    throw new HttpError(413, `a report is at most ${maxAutomationReportLength} characters`)
  }
  return { summary }
}
