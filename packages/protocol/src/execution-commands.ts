import {
  type ExecutionOperationId,
  type ExecutionRef,
  executionHandle,
  executionIds,
} from './execution.ts'
import {
  type ExecutionHello,
  type ExecutionScope,
  parseApproveExecution,
  parseExecutionHello,
} from './execution-pairing.ts'
import { RequestValidationError } from './validation.ts'

const KiB = 1024
const bytes = (value: string) => new TextEncoder().encode(value).length

export const executionLimits = {
  commandBytes: 64 * KiB,
  resultBytes: 256 * KiB,
  diagnosticBytes: 16 * KiB,
  unconfirmed: 256,
  journalBytes: 64 * KiB * KiB,
  minFreeBytes: KiB ** 3,
  syncRequestBytes: 2 * KiB * KiB,
  syncResponseBytes: KiB * KiB,
} as const

export type ExecutionLimits = { [K in keyof typeof executionLimits]: number }

export interface ProbeInput {
  wait?: boolean
  evidence?: boolean
}

export interface ExecutionCommand {
  operationId: ExecutionOperationId
  ref: ExecutionRef
  scope: ExecutionScope
  order: number
  kind: 'probe'
  input: ProbeInput
}

export interface ExecutionStop {
  operationId: ExecutionOperationId
  ref: ExecutionRef
  order: number
}

export type ExecutionOperationState =
  | 'accepted'
  | 'running'
  | 'finished'
  | 'stopped'
  | 'uncertain'
  | 'refused'

export const executionRefusals = ['stale', 'scope', 'limit', 'disk'] as const
export type ExecutionRefusal = (typeof executionRefusals)[number]

export interface ExecutionResult {
  ok: boolean
  value?: number
  diagnostic?: string
}

export interface ExecutionReport {
  operationId: ExecutionOperationId
  ref: ExecutionRef
  state: ExecutionOperationState
  refusal?: ExecutionRefusal
  result?: ExecutionResult
}

export interface ExecutionInventoryEntry {
  operationId: ExecutionOperationId
  ref: ExecutionRef
  state: ExecutionOperationState
}

export interface ExecutionSyncRequest extends ExecutionHello {
  grantId: string
  session: string
  inventory?: ExecutionInventoryEntry[]
  reports: ExecutionReport[]
  accepting: true | ExecutionRefusal
}

export interface ExecutionSyncResponse {
  needInventory: boolean
  reconciled: boolean
  confirmed: ExecutionOperationId[]
  commands: ExecutionCommand[]
  stops: ExecutionStop[]
}

export interface WorkerOperations {
  running: number
  queued: number
  waiting: number
  uncertain: number
  reconciling: boolean
  refusing?: ExecutionRefusal
}

export interface MachineOperations {
  running: number
  unconfirmed: number
  stopsUnconfirmed: number
  uncertain: number
  unknown: number
  reconciling: boolean
  refusing?: ExecutionRefusal
  text?: string
}

export const terminalExecutionStates: readonly ExecutionOperationState[] = [
  'finished',
  'stopped',
  'refused',
]

function invalid(message: string): never {
  throw new RequestValidationError(400, message)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object')
  return value as Record<string, unknown>
}
function only(value: Record<string, unknown>, names: string[]): void {
  for (const name of Object.keys(value))
    if (!names.includes(name)) invalid('Unknown execution message field')
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid('Invalid execution list')
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max) invalid('Invalid execution text')
  return value
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('Expected a boolean')
  return value
}
function count(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    invalid('Invalid execution number')
  return value
}
function operationId(value: unknown): ExecutionOperationId {
  try {
    return executionIds.operation(value as string)
  } catch {
    return invalid('Invalid execution operation ID')
  }
}
function ref(value: unknown): ExecutionRef {
  const v = object(value)
  only(v, ['taskId', 'machineId', 'assignmentId', 'generation', 'reservationId'])
  try {
    const { id: _, ...parsed } = executionHandle({
      taskId: text(v.taskId, 128),
      machineId: v.machineId as ExecutionRef['machineId'],
      assignmentId: v.assignmentId as ExecutionRef['assignmentId'],
      generation: v.generation as number,
      reservationId: v.reservationId as ExecutionRef['reservationId'],
      id: executionIds.handle('ref'),
    })
    return parsed
  } catch {
    return invalid('Invalid execution assignment reference')
  }
}
function scope(value: unknown): ExecutionScope {
  const parsed = parseApproveExecution({ id: 'scope', scopes: [value] }).scopes[0]
  return parsed ?? invalid('Invalid execution scope')
}
function state(value: unknown): ExecutionOperationState {
  const states = ['accepted', 'running', 'finished', 'stopped', 'uncertain', 'refused']
  if (typeof value !== 'string' || !states.includes(value)) invalid('Invalid operation state')
  return value as ExecutionOperationState
}
function refusal(value: unknown): ExecutionRefusal {
  if (!executionRefusals.includes(value as ExecutionRefusal)) invalid('Invalid refusal reason')
  return value as ExecutionRefusal
}
function bounded<T>(value: T, limit: number, what: string): T {
  if (bytes(JSON.stringify(value)) > limit) invalid(`${what} exceeds its size limit`)
  return value
}

export function parseProbeInput(value: unknown): ProbeInput {
  const v = object(value)
  only(v, ['wait', 'evidence'])
  return {
    ...(v.wait !== undefined && { wait: flag(v.wait) }),
    ...(v.evidence !== undefined && { evidence: flag(v.evidence) }),
  }
}

export function parseExecutionCommand(value: unknown): ExecutionCommand {
  const v = object(value)
  only(v, ['operationId', 'ref', 'scope', 'order', 'kind', 'input'])
  if (v.kind !== 'probe') invalid('Unknown execution operation kind')
  return bounded(
    {
      operationId: operationId(v.operationId),
      ref: ref(v.ref),
      scope: scope(v.scope),
      order: count(v.order, 1),
      kind: 'probe',
      input: parseProbeInput(v.input),
    },
    executionLimits.commandBytes,
    'Execution command',
  )
}

export function parseExecutionStop(value: unknown): ExecutionStop {
  const v = object(value)
  only(v, ['operationId', 'ref', 'order'])
  return { operationId: operationId(v.operationId), ref: ref(v.ref), order: count(v.order, 1) }
}

export function parseExecutionResult(value: unknown): ExecutionResult {
  const v = object(value)
  only(v, ['ok', 'value', 'diagnostic'])
  const diagnostic = v.diagnostic === undefined ? undefined : text(v.diagnostic, 65536)
  if (diagnostic && bytes(diagnostic) > executionLimits.diagnosticBytes)
    invalid('Execution diagnostic exceeds its size limit')
  return bounded(
    {
      ok: flag(v.ok),
      ...(v.value !== undefined && { value: count(v.value) }),
      ...(diagnostic !== undefined && { diagnostic }),
    },
    executionLimits.resultBytes,
    'Execution result',
  )
}

export function parseExecutionReport(value: unknown): ExecutionReport {
  const v = object(value)
  only(v, ['operationId', 'ref', 'state', 'refusal', 'result'])
  const parsed = state(v.state)
  if ((parsed === 'refused') !== (v.refusal !== undefined))
    invalid('A refused operation needs one refusal reason')
  if (v.result !== undefined && parsed !== 'finished')
    invalid('Only a finished operation has a result')
  if (parsed === 'finished' && v.result === undefined) invalid('A finished operation has a result')
  return {
    operationId: operationId(v.operationId),
    ref: ref(v.ref),
    state: parsed,
    ...(v.refusal !== undefined && { refusal: refusal(v.refusal) }),
    ...(v.result !== undefined && { result: parseExecutionResult(v.result) }),
  }
}

function inventoryEntry(value: unknown): ExecutionInventoryEntry {
  const v = object(value)
  only(v, ['operationId', 'ref', 'state'])
  return { operationId: operationId(v.operationId), ref: ref(v.ref), state: state(v.state) }
}

export function parseExecutionSyncRequest(value: unknown): ExecutionSyncRequest {
  const v = object(value)
  only(v, [
    'protocol',
    'edition',
    'capabilities',
    'grantId',
    'session',
    'inventory',
    'reports',
    'accepting',
  ])
  const session = text(v.session, 64)
  if (!/^[a-f0-9-]{36}$/.test(session)) invalid('Invalid execution session')
  return {
    ...parseExecutionHello(v),
    grantId: text(v.grantId, 80),
    session,
    ...(v.inventory !== undefined && {
      inventory: list(v.inventory, executionLimits.unconfirmed).map(inventoryEntry),
    }),
    reports: list(v.reports, executionLimits.unconfirmed).map(parseExecutionReport),
    accepting: v.accepting === true ? true : refusal(v.accepting),
  }
}

export function parseExecutionSyncResponse(value: unknown): ExecutionSyncResponse {
  const v = object(value)
  only(v, ['needInventory', 'reconciled', 'confirmed', 'commands', 'stops'])
  return {
    needInventory: flag(v.needInventory),
    reconciled: flag(v.reconciled),
    confirmed: list(v.confirmed, executionLimits.unconfirmed).map(operationId),
    commands: list(v.commands, executionLimits.unconfirmed).map(parseExecutionCommand),
    stops: list(v.stops, executionLimits.unconfirmed).map(parseExecutionStop),
  }
}

export function sameExecutionRef(a: ExecutionRef, b: ExecutionRef): boolean {
  return (
    a.taskId === b.taskId &&
    a.machineId === b.machineId &&
    a.assignmentId === b.assignmentId &&
    a.generation === b.generation &&
    a.reservationId === b.reservationId
  )
}
