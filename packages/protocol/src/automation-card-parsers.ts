import type { AutomationInput, EditAutomationRequest } from './automation.ts'
import {
  type AutomationCardAnswer,
  type AutomationDraftRequest,
  automationCardKinds,
  automationDraftLimits,
} from './automation-card.ts'
import { parseCreateAutomationRequest, parseEditAutomationRequest } from './automation-parsers.ts'
import { type JsonObject, reader, type Untyped } from './parse.ts'
import { RequestValidationError as HttpError } from './validation.ts'

function fail(message: string): never {
  throw new HttpError(400, message)
}
const read = reader(fail)

const startTasksRefusal =
  'a draft can’t turn on Start the Tasks it creates; the user can tick it on the card'

function capped(name: keyof typeof automationDraftLimits, value: string | null | undefined): void {
  const limit = automationDraftLimits[name]
  if (value !== undefined && value !== null && value.length > limit)
    fail(`${name} is limited to ${limit} characters`)
}

function capFields(fields: Partial<AutomationInput> | EditAutomationRequest): void {
  capped('name', fields.name)
  capped('prompt', fields.prompt)
  capped('model', fields.model)
  if (fields.check?.startTasks === true) fail(startTasksRefusal)
}

function draftFields(body: JsonObject): JsonObject {
  return read.object(
    body.fields,
    'fields',
    'fields must be an object with the Automation’s settings',
  )
}

function createFields(body: JsonObject): AutomationInput {
  const { factory, runNow, ...input } = parseCreateAutomationRequest(draftFields(body))
  if (factory !== undefined) fail('a draft is always for this chat’s Factory')
  if (runNow !== undefined) fail('a draft can’t run the Automation; the user can run it later')
  capFields(input)
  if (input.check) return { ...input, check: { ...input.check, startTasks: false } }
  return input
}

function editFields(body: JsonObject): EditAutomationRequest {
  const input = parseEditAutomationRequest(draftFields(body))
  if (Object.keys(input).length === 0) fail('fields must change at least one setting')
  capFields(input)
  return input
}

export function parseAutomationDraftRequest(value: Untyped): AutomationDraftRequest {
  const body = read.object(value, 'body', 'body must be a JSON object')
  const operation = read.string(
    body,
    'operation',
    'operation must be a unique ID of up to 100 characters',
  )
  if (!/^[\w-]{1,100}$/.test(operation))
    fail('operation must be a unique ID of up to 100 characters')
  const kind = read.oneOf(body, 'kind', automationCardKinds, 'kind must be create, edit or delete')
  if (kind === 'create') {
    if (body.automation !== undefined) fail('a create draft names no Automation')
    return { operation, kind, create: createFields(body) }
  }
  const automation = read.string(body, 'automation', 'automation must name an Automation by ID')
  if (automation.trim() === '' || automation.length > 200)
    fail('automation must name an Automation by ID')
  if (kind === 'delete') {
    if (body.fields !== undefined) fail('a delete draft has no fields')
    return { operation, kind, automation: automation.trim() }
  }
  return { operation, kind, automation: automation.trim(), edit: editFields(body) }
}

export function parseAutomationCardAnswer(value: Untyped): AutomationCardAnswer {
  const body = read.object(value, 'body', 'body must be a JSON object')
  const decision = read.oneOf(
    body,
    'decision',
    ['confirm', 'cancel'] as const,
    'decision must be confirm or cancel',
  )
  const startTasks = read.optional(body, 'startTasks', (object, field) =>
    read.boolean(object, field, 'startTasks must be true or false'),
  )
  if (startTasks !== undefined && decision === 'cancel') fail('startTasks goes only with confirm')
  return { decision, ...(startTasks !== undefined && { startTasks }) }
}
