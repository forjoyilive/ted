import { expect, test } from 'vitest'
import {
  executionHello,
  executionLimits,
  parseExecutionCommand,
  parseExecutionReport,
  parseExecutionResult,
  parseExecutionStop,
  parseExecutionSyncRequest,
  parseExecutionSyncResponse,
  parseProbeInput,
  sameExecutionRef,
} from '../src/index.ts'

const ref = {
  taskId: 'task-1',
  machineId: 'grant-1',
  assignmentId: 'assignment-1',
  generation: 1,
  reservationId: 'reservation-1',
}
const command = {
  operationId: 'operation-1',
  ref,
  scope: { factoryId: 'factory-1', repo: 'Owner/Repo' },
  order: 1,
  kind: 'probe',
  input: { wait: true, evidence: false },
}

test('a command keeps every field, lowercases its repo and refuses anything else', () => {
  expect(parseExecutionCommand(command)).toEqual({
    ...command,
    scope: { factoryId: 'factory-1', repo: 'owner/repo' },
  })
  expect(parseProbeInput({})).toEqual({})
  for (const changed of [
    { operationId: '../escape' },
    { ref: { ...ref, generation: 0 } },
    { ref: { ...ref, machineId: 'a/b' } },
    { ref: { ...ref, extra: 1 } },
    { scope: { factoryId: 'factory-1', repo: '../repo' } },
    { order: 0 },
    { kind: 'shell' },
    { input: { wait: 'yes' } },
    { input: { command: 'rm' } },
    { extra: true },
  ])
    expect(() => parseExecutionCommand({ ...command, ...changed })).toThrow()
  expect(() =>
    parseExecutionCommand({
      ...command,
      ref: { ...ref, taskId: 'x'.repeat(executionLimits.commandBytes) },
    }),
  ).toThrow()
})

test('a stop names the operation, its assignment and its order', () => {
  expect(parseExecutionStop({ operationId: 'operation-1', ref, order: 3 })).toEqual({
    operationId: 'operation-1',
    ref,
    order: 3,
  })
  expect(() => parseExecutionStop({ operationId: 'operation-1', ref })).toThrow()
})

test('a result is bounded and a report carries one only when finished', () => {
  expect(parseExecutionResult({ ok: true, value: 1, diagnostic: 'done' })).toEqual({
    ok: true,
    value: 1,
    diagnostic: 'done',
  })
  expect(() =>
    parseExecutionResult({
      ok: false,
      diagnostic: 'x'.repeat(executionLimits.diagnosticBytes + 1),
    }),
  ).toThrow()
  expect(() => parseExecutionResult({ ok: true, output: 'unbounded' })).toThrow()
  const report = { operationId: 'operation-1', ref, state: 'finished', result: { ok: true } }
  expect(parseExecutionReport(report)).toEqual(report)
  expect(
    parseExecutionReport({ operationId: 'operation-1', ref, state: 'refused', refusal: 'stale' }),
  ).toMatchObject({ state: 'refused', refusal: 'stale' })
  for (const invalid of [
    { ...report, state: 'running' },
    { operationId: 'operation-1', ref, state: 'finished' },
    { operationId: 'operation-1', ref, state: 'refused' },
    { operationId: 'operation-1', ref, state: 'refused', refusal: 'because' },
    { operationId: 'operation-1', ref, state: 'done' },
  ])
    expect(() => parseExecutionReport(invalid)).toThrow()
})

test('sync messages keep every field and bound their lists', () => {
  const request = {
    ...executionHello(),
    grantId: 'grant-1',
    session: '11111111-1111-4111-8111-111111111111',
    inventory: [{ operationId: 'operation-1', ref, state: 'running' }],
    reports: [{ operationId: 'operation-1', ref, state: 'running' }],
    accepting: 'limit',
  }
  expect(parseExecutionSyncRequest(request)).toEqual(request)
  expect(parseExecutionSyncRequest({ ...request, inventory: undefined, accepting: true })).toEqual({
    ...request,
    inventory: undefined,
    accepting: true,
  })
  for (const changed of [
    { session: 'not-a-session' },
    { accepting: false },
    { reports: Array(executionLimits.unconfirmed + 1).fill(request.reports[0]) },
    { token: 'secret' },
  ])
    expect(() => parseExecutionSyncRequest({ ...request, ...changed })).toThrow()
  const response = {
    needInventory: false,
    reconciled: true,
    confirmed: ['operation-1'],
    commands: [parseExecutionCommand(command)],
    stops: [{ operationId: 'operation-2', ref, order: 2 }],
  }
  expect(parseExecutionSyncResponse(response)).toEqual(response)
  expect(() => parseExecutionSyncResponse({ ...response, reconciled: 'yes' })).toThrow()
  const parsed = parseExecutionCommand(command).ref
  expect(sameExecutionRef(parsed, { ...parsed })).toBe(true)
  expect(sameExecutionRef(parsed, { ...parsed, generation: 2 })).toBe(false)
})

test('the limits are the agreed ones', () => {
  expect(executionLimits).toMatchObject({
    commandBytes: 64 * 1024,
    resultBytes: 256 * 1024,
    diagnosticBytes: 16 * 1024,
    unconfirmed: 256,
    journalBytes: 64 * 1024 * 1024,
    minFreeBytes: 1024 ** 3,
  })
})
