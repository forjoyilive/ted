import type {
  CheckTryRequest,
  InstructionCheckInput,
  InstructionCheckTryRequest,
} from './factory-settings.ts'
import { isArray, type JsonObject, reader, type Untyped } from './parse.ts'
import { efforts, isModelName } from './task.ts'
import { RequestValidationError as HttpError } from './validation.ts'

function fail(message: string): never {
  throw new HttpError(400, message)
}
const read = reader(fail)

export const checkAgents = ['codex', 'claude', 'antigravity', 'pi', 'same'] as const
const maxInstructionChecks = 200
const maxInstructionLength = 64 * 1024
const maxNameLength = 200

function optionalText(body: JsonObject, field: string, problem: string): string | undefined {
  const value = read.optional(body, field, (object, name) => read.string(object, name, problem))
  const trimmed = value?.trim()
  return trimmed === '' ? undefined : trimmed
}

function name(body: JsonObject, problem: string): string {
  const value = read.string(body, 'name', problem).trim()
  if (value === '' || value.length > maxNameLength || /[\r\n]/.test(value)) fail(problem)
  return value
}

function timeout(body: JsonObject): string | undefined {
  const value = optionalText(body, 'timeout', 'timeout must be text')
  if (value !== undefined && !/^\d+[smh]$/.test(value))
    fail('timeout must be a duration such as 30s, 15m or 1h')
  return value
}

function instructionFields(body: JsonObject): Omit<InstructionCheckInput, 'was'> {
  const instruction = read.string(body, 'instruction', 'instruction must be text').trim()
  if (instruction === '') fail('An instruction check needs an instruction')
  if (instruction.length > maxInstructionLength) fail('the instruction is too long')
  if (body.run !== undefined) fail('A check has a command or an instruction, not both')
  if (body.repo !== undefined) fail('An instruction check takes no repo')
  const fix = read.optional(body, 'fix', (object, field) =>
    read.boolean(object, field, 'fix must be true or false'),
  )
  const agent = read.optional(body, 'agent', (object, field) =>
    read.oneOf(object, field, checkAgents, `agent must be ${checkAgents.join(', ')}`),
  )
  const model = optionalText(body, 'model', 'model must be text')
  if (model !== undefined && !isModelName(model))
    fail('model must be a model name, such as opus or gpt-5.5')
  const effort = read.optional(body, 'effort', (object, field) =>
    read.oneOf(object, field, efforts, `effort must be one of ${efforts.join(', ')}`),
  )
  const limit = timeout(body)
  return {
    name: name(body, 'A check needs a name on one line'),
    instruction,
    ...(fix === true && { fix: true }),
    ...(limit !== undefined && { timeout: limit }),
    ...(agent !== undefined && { agent }),
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
  }
}

export function parseCheckTryRequest(value: Untyped): CheckTryRequest {
  const body = read.object(value, 'check', 'a check must be an object')
  if (body.instruction !== undefined) {
    const taskId = optionalText(body, 'taskId', 'taskId must be text')
    if (taskId === undefined) fail('Choose the Task to run the instruction check on')
    const request: InstructionCheckTryRequest = { ...instructionFields(body), taskId }
    return request
  }
  const problem = 'A check needs a name and a command'
  const run = optionalText(body, 'run', problem)
  if (run === undefined) fail(problem)
  const repo = optionalText(body, 'repo', 'repo must be text')
  const limit = timeout(body)
  return {
    name: name(body, problem),
    run,
    ...(repo !== undefined && { repo }),
    ...(limit !== undefined && { timeout: limit }),
  }
}

export function parseInstructionChecks(value: Untyped): InstructionCheckInput[] {
  if (!isArray(value)) return fail('instructionChecks must be a list')
  if (value.length > maxInstructionChecks) fail('instructionChecks is too long')
  return value.map((item) => {
    const body = read.object(item, 'instruction check')
    const was = read.optional(body, 'was', (object, field) =>
      read.integer(object, field, 'a check’s was must be a list position'),
    )
    if (was !== undefined && was < 0) fail('a check’s was must be a list position')
    return { ...(was !== undefined && { was }), ...instructionFields(body) }
  })
}
