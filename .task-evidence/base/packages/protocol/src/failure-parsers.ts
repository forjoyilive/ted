import type {
  AddFailureEvidenceRequest,
  AssessFailureRequest,
  FailureSource,
  RecordFailureRequest,
  RepairSelection,
  ResolveFailureRequest,
  VerifyFailureRequest,
} from './failures.ts'
import { RequestValidationError as HttpError } from './validation.ts'

function failureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'failure request must be an object')
  return value as Record<string, unknown>
}
function failureString(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || !value.trim() || value.length > 16_000)
    throw new HttpError(400, `${name} must be nonempty text up to 16000 characters`)
  return value.trim()
}
function failureContextId(body: Record<string, unknown>): string | undefined {
  return body.contextId === undefined ? undefined : failureString(body, 'contextId')
}
function failureSource(value: unknown): FailureSource {
  const body = failureObject(value)
  const kind = body.kind
  if (kind === 'factory-check' || kind === 'post-rebase-check') {
    if (!Number.isSafeInteger(body.position) || (body.position as number) < 0)
      throw new HttpError(400, 'position must be a nonnegative integer')
    return {
      kind,
      checkRunId: failureString(body, 'checkRunId'),
      position: body.position as number,
    }
  }
  if (kind === 'finding') {
    const category = body.category
    if (
      category !== undefined &&
      category !== 'test' &&
      category !== 'review' &&
      category !== 'visual'
    )
      throw new HttpError(400, 'category must be test, review or visual')
    return {
      kind,
      runId: failureString(body, 'runId'),
      finding: failureString(body, 'finding'),
      ...(category !== undefined && { category }),
    }
  }
  if (kind === 'github-ci') {
    if (!Number.isSafeInteger(body.number) || (body.number as number) < 1)
      throw new HttpError(400, 'number must be a positive PR number')
    const head = failureString(body, 'head')
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new HttpError(400, 'head must be a commit ID')
    return {
      kind,
      repo: failureString(body, 'repo'),
      number: body.number as number,
      head,
      attempt: failureString(body, 'attempt'),
    }
  }
  throw new HttpError(400, 'unknown failure source')
}

export function parseRecordFailureRequest(value: unknown): RecordFailureRequest {
  const body = failureObject(value)
  const contextId = failureContextId(body)
  return {
    source: failureSource(body.source),
    evidence: failureString(body, 'evidence'),
    ...(contextId && { contextId }),
  }
}
export function parseAddFailureEvidenceRequest(value: unknown): AddFailureEvidenceRequest {
  const body = failureObject(value)
  const contextId = failureContextId(body)
  return {
    evidence: failureString(body, 'evidence'),
    ...(contextId !== undefined && { contextId }),
  }
}
export function parseAssessFailureRequest(value: unknown): AssessFailureRequest {
  const body = failureObject(value)
  const assessment = body.assessment
  if (assessment !== 'regression' && assessment !== 'unrelated' && assessment !== 'uncertain')
    throw new HttpError(400, 'unknown failure assessment')
  const input: AssessFailureRequest = {
    assessment,
    recommendation: failureString(body, 'recommendation'),
  }
  return input
}
export function parseResolveFailureRequest(value: unknown): ResolveFailureRequest {
  const body = failureObject(value)
  const resolution = body.resolution
  if (
    resolution !== 'accepted' &&
    resolution !== 'fixed' &&
    resolution !== 'no-longer-applicable' &&
    resolution !== 'retry' &&
    resolution !== 'fix' &&
    resolution !== 'repair'
  )
    throw new HttpError(400, 'unknown failure resolution')
  let repair: RepairSelection | undefined
  if (resolution === 'repair') {
    const selected = failureObject(body.repair)
    if (selected.kind === 'existing') {
      repair = { kind: 'existing', taskId: failureString(selected, 'taskId') }
    } else if (selected.kind === 'new') {
      if (typeof selected.start !== 'boolean') throw new HttpError(400, 'start must be a boolean')
      repair = {
        kind: 'new',
        title: failureString(selected, 'title'),
        description: failureString(selected, 'description'),
        start: selected.start,
      }
    } else throw new HttpError(400, 'choose an existing or new repair Task')
  } else if (body.repair !== undefined)
    throw new HttpError(400, 'repair selection needs repair resolution')
  const input: ResolveFailureRequest = {
    requestId: failureString(body, 'requestId'),
    resolution,
    ...(repair && { repair }),
    ...(body.reason !== undefined && { reason: failureString(body, 'reason') }),
  }
  return input
}

export function parseVerifyFailureRequest(value: unknown): VerifyFailureRequest {
  return { evidence: failureString(failureObject(value), 'evidence') }
}
