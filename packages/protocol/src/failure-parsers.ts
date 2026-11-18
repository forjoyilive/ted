import {
  type AddFailureEvidenceRequest,
  type AssessFailureRequest,
  type FailureSource,
  failureChoiceKeys,
  type RecordFailureRequest,
  type RepairSelection,
  type ResolveFailureRequest,
  type VerifyFailureRequest,
} from './failures.ts'
import { type Json, type JsonObject, reader, type Untyped } from './parse.ts'
import { RequestValidationError as HttpError } from './validation.ts'

function fail(message: string): never {
  throw new HttpError(400, message)
}
const read = reader(fail)

function failureObject(value: Untyped): JsonObject {
  return read.object(value, 'failure request', 'failure request must be an object')
}
function failureString(body: JsonObject, name: string): string {
  const problem = `${name} must be nonempty text up to 16000 characters`
  const value = read.string(body, name, problem)
  if (!value.trim() || value.length > 16_000) fail(problem)
  return value.trim()
}
function failureContextId(body: JsonObject): string | undefined {
  return read.optional(body, 'contextId', failureString)
}
function failureSource(value: Json | undefined): FailureSource {
  const body = failureObject(value)
  const kind = body.kind
  if (kind === 'factory-check' || kind === 'post-rebase-check') {
    const problem = 'position must be a nonnegative integer'
    const position = read.integer(body, 'position', problem)
    if (position < 0) fail(problem)
    return {
      kind,
      checkRunId: failureString(body, 'checkRunId'),
      position,
    }
  }
  if (kind === 'finding') {
    const category = read.optional(body, 'category', (object, field) =>
      read.oneOf(
        object,
        field,
        ['test', 'review', 'visual'],
        'category must be test, review or visual',
      ),
    )
    return {
      kind,
      runId: failureString(body, 'runId'),
      finding: failureString(body, 'finding'),
      ...(category !== undefined && { category }),
    }
  }
  if (kind === 'github-ci') {
    const problem = 'number must be a positive PR number'
    const number = read.integer(body, 'number', problem)
    if (number < 1) fail(problem)
    const head = failureString(body, 'head')
    if (!/^[a-f0-9]{40,64}$/.test(head)) fail('head must be a commit ID')
    return {
      kind,
      repo: failureString(body, 'repo'),
      number,
      head,
      attempt: failureString(body, 'attempt'),
    }
  }
  return fail('unknown failure source')
}

export function parseRecordFailureRequest(value: Untyped): RecordFailureRequest {
  const body = failureObject(value)
  const contextId = failureContextId(body)
  return {
    source: failureSource(body.source),
    evidence: failureString(body, 'evidence'),
    ...(contextId && { contextId }),
  }
}
export function parseAddFailureEvidenceRequest(value: Untyped): AddFailureEvidenceRequest {
  const body = failureObject(value)
  const contextId = failureContextId(body)
  return {
    evidence: failureString(body, 'evidence'),
    ...(contextId !== undefined && { contextId }),
  }
}
export function parseAssessFailureRequest(value: Untyped): AssessFailureRequest {
  const body = failureObject(value)
  const assessment = read.oneOf(
    body,
    'assessment',
    ['regression', 'unrelated', 'uncertain'],
    'unknown failure assessment',
  )
  const choice = read.oneOf(
    body,
    'choice',
    failureChoiceKeys,
    `choice must be the recommended decision: ${failureChoiceKeys.join(', ')}`,
  )
  const input: AssessFailureRequest = {
    assessment,
    recommendation: failureString(body, 'recommendation'),
    choice,
  }
  return input
}
export function parseResolveFailureRequest(value: Untyped): ResolveFailureRequest {
  const body = failureObject(value)
  const resolution = read.oneOf(
    body,
    'resolution',
    ['accepted', 'fixed', 'no-longer-applicable', 'retry', 'fix', 'repair'],
    'unknown failure resolution',
  )
  let repair: RepairSelection | undefined
  if (resolution === 'repair') {
    const selected = failureObject(body.repair)
    if (selected.kind === 'existing') {
      repair = { kind: 'existing', taskId: failureString(selected, 'taskId') }
    } else if (selected.kind === 'new') {
      const start = read.boolean(selected, 'start', 'start must be a boolean')
      repair = {
        kind: 'new',
        title: failureString(selected, 'title'),
        description: failureString(selected, 'description'),
        start,
      }
    } else fail('choose an existing or new repair Task')
  } else if (body.repair !== undefined) fail('repair selection needs repair resolution')
  const input: ResolveFailureRequest = {
    requestId: failureString(body, 'requestId'),
    resolution,
    ...(repair && { repair }),
    ...(body.reason !== undefined && { reason: failureString(body, 'reason') }),
  }
  return input
}

export function parseVerifyFailureRequest(value: Untyped): VerifyFailureRequest {
  const body = failureObject(value)
  const fixedBy = read.optional(body, 'fixedBy', failureString)
  const input: VerifyFailureRequest = {
    evidence: failureString(body, 'evidence'),
    ...(fixedBy !== undefined && { fixedBy }),
  }
  return input
}
