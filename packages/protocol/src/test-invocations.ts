import { bodyObject, RequestValidationError } from './validation.ts'

export const testReportingVersion = 1
export const testInvocationLimit = 256
export const testReportLimit = 64
export const testReporterPrefix = 'test-report:'

export interface RegisterTestInvocation {
  id: string
  supported: boolean
  label?: string
  checkRunId?: string
  position?: number
}

export interface TestInvocationReport {
  sequence: number
  kind: 'wait-start' | 'wait-end' | 'finished' | 'canceled' | 'interrupted'
  at: number
}

export interface TestInvocation extends RegisterTestInvocation {
  taskId: string
  runId?: string
  registeredAt: number
  ownerEnded?: boolean
  reports: TestInvocationReport[]
}

export function testReporterSubject(invocation: Pick<TestInvocation, 'id' | 'taskId'>): string {
  return `${testReporterPrefix}${invocation.id}:${invocation.taskId}`
}

export interface TestInvocationRegistration {
  invocation: TestInvocation
  token: string
}

export interface TestInvocationMeasurement extends TestInvocation {
  coverage: 'unsupported' | 'unreported' | 'reported' | 'incomplete'
  confirmedWaitMs: number
  openWaitStartedAt?: number
  outcome?: 'finished' | 'canceled' | 'interrupted'
}

export interface TestInvocationSummary {
  version: 1
  invocations: TestInvocationMeasurement[]
  checksWithoutReports: { checkRunId: string; position: number; coverage: 'unreported' }[]
  directCommands: 'Only registered invocations are measured; other direct commands are outside coverage.'
  checksWithoutReportsOmitted: number
  limitReached: boolean
}

function invalid(message: string): never {
  throw new RequestValidationError(400, message)
}

export function testInvocationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    invalid('invocation ID must be a lowercase UUID')
  return value
}

function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid('unknown reporting field')
}

export function parseRegisterTestInvocation(value: unknown): RegisterTestInvocation {
  const body = bodyObject(value)
  fields(body, ['id', 'supported', 'label', 'checkRunId', 'position'])
  const id = testInvocationId(body.id)
  if (typeof body.supported !== 'boolean') invalid('supported must be boolean')
  if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 120))
    invalid('label must be at most 120 characters')
  if ((body.checkRunId === undefined) !== (body.position === undefined))
    invalid('checkRunId and position must be supplied together')
  if (body.checkRunId !== undefined) testInvocationId(body.checkRunId)
  if (
    body.position !== undefined &&
    (!Number.isSafeInteger(body.position) ||
      Number(body.position) < 0 ||
      Number(body.position) > 255)
  )
    invalid('position must be an integer from 0 to 255')
  return {
    id,
    supported: body.supported,
    ...(typeof body.label === 'string' && { label: body.label }),
    ...(typeof body.checkRunId === 'string' && {
      checkRunId: body.checkRunId,
      position: Number(body.position),
    }),
  }
}

export function parseTestInvocationReport(value: unknown): TestInvocationReport {
  const body = bodyObject(value)
  fields(body, ['sequence', 'kind', 'at'])
  if (
    !Number.isSafeInteger(body.sequence) ||
    Number(body.sequence) < 0 ||
    Number(body.sequence) >= testReportLimit
  )
    invalid('sequence is outside the reporting limit')
  if (
    typeof body.kind !== 'string' ||
    !['wait-start', 'wait-end', 'finished', 'canceled', 'interrupted'].includes(body.kind)
  )
    invalid('unknown test report kind')
  if (
    !Number.isSafeInteger(body.at) ||
    Number(body.at) < 0 ||
    Number(body.at) > 8_640_000_000_000_000
  )
    invalid('at must be a valid timestamp in integer milliseconds')
  return {
    sequence: Number(body.sequence),
    kind: body.kind as TestInvocationReport['kind'],
    at: Number(body.at),
  }
}
