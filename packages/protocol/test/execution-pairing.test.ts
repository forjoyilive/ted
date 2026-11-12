import { expect, test } from 'vitest'
import {
  executionHello,
  parseApproveExecution,
  parseExecutionCertificate,
  parseExecutionEndpoint,
  parseExecutionEnrollment,
  parseExecutionHeartbeat,
  parseExecutionIdRequest,
  parseExecutionOffer,
  parseExecutionReadiness,
  parseWorkerPairRequest,
  requireExecutionCompatibility,
} from '../src/execution-pairing.ts'

const readiness = {
  observedAt: '2026-11-11T00:00:00.000Z',
  platform: 'darwin',
  arch: 'arm64',
  version: '1.0',
  agents: [
    {
      name: 'codex',
      detected: true,
      modelAccess: 'unknown' as const,
      reason: 'Unverified on this Mac',
    },
  ],
  sandbox: { available: true, reason: 'Probe passed' },
  freeBytes: 5e9,
  loadPerCore: 0.2,
  capacity: 2,
}
const offer = {
  ...executionHello(),
  address: '192.168.1.2',
  port: 47443,
  controllerPin: 'a'.repeat(64),
  secret: 'b'.repeat(64),
  expiresAt: '2026-11-11T00:05:00.000Z',
}

test('execution request parsers preserve every defined field and omit unrelated data', () => {
  expect(parseExecutionEndpoint({ ...offer, extra: 'discard' })).toEqual({
    address: offer.address,
    port: offer.port,
  })
  expect(parseExecutionOffer({ ...offer, extra: 'discard' })).toEqual(offer)
  expect(parseExecutionReadiness({ ...readiness, extra: 'discard' })).toEqual(readiness)
  const enrollment = {
    ...executionHello(),
    secret: offer.secret,
    csr: '-----BEGIN CERTIFICATE REQUEST-----\nfixture',
    name: 'Mini',
    readiness,
  }
  expect(parseExecutionEnrollment({ ...enrollment, extra: 'discard' })).toEqual(enrollment)
  const heartbeat = { ...executionHello(), grantId: 'grant-1', readiness }
  expect(parseExecutionHeartbeat({ ...heartbeat, extra: 'discard' })).toEqual(heartbeat)
  const approval = { id: 'pending-1', scopes: [{ factoryId: 'factory-1', repo: 'owner/repo' }] }
  expect(parseApproveExecution({ ...approval, extra: 'discard' })).toEqual(approval)
  expect(parseExecutionIdRequest({ id: 'machine-1', extra: 'discard' })).toEqual({
    id: 'machine-1',
  })
  const pair = { details: JSON.stringify(offer), capacity: 4 }
  expect(parseWorkerPairRequest({ ...pair, extra: 'discard' })).toEqual(pair)
  const cert = {
    grantId: 'grant-1',
    certificate: '-----BEGIN CERTIFICATE-----\nfixture',
    ca: '-----BEGIN CERTIFICATE-----\nissuer',
    scopes: approval.scopes,
  }
  expect(parseExecutionCertificate({ ...cert, extra: 'discard' })).toEqual(cert)
})

test('execution parsers refuse invalid addresses, scope, readiness and incompatible peers', () => {
  for (const address of ['0.0.0.0', '8.8.8.8', 'localhost', '192.168.1.999', '192.168.1.2/24'])
    expect(() => parseExecutionEndpoint({ address, port: 47443 })).toThrow()
  for (const port of [0, 65536, 1.5, '47443'])
    expect(() => parseExecutionEndpoint({ address: '192.168.1.2', port })).toThrow()
  for (const capacity of [0, 65, NaN, Infinity])
    expect(() => parseExecutionReadiness({ ...readiness, capacity })).toThrow()
  for (const loadPerCore of [-1, NaN, Infinity])
    expect(() => parseExecutionReadiness({ ...readiness, loadPerCore })).toThrow()
  expect(() =>
    parseExecutionReadiness({
      ...readiness,
      agents: [{ ...readiness.agents[0], modelAccess: 'ready' }],
    }),
  ).toThrow()
  expect(() => parseApproveExecution({ id: 'x', scopes: [] })).toThrow()
  expect(() =>
    parseApproveExecution({ id: 'x', scopes: [{ factoryId: 'x', repo: '../repo' }] }),
  ).toThrow()
  expect(() =>
    parseExecutionEnrollment({
      ...executionHello(),
      secret: offer.secret,
      csr: 'bad',
      name: 'name\n',
      readiness,
    }),
  ).toThrow()
  expect(() => requireExecutionCompatibility({ ...executionHello(), protocol: 999 })).toThrow(
    'Incompatible',
  )
  expect(() => requireExecutionCompatibility({ ...executionHello(), edition: 'release' })).toThrow(
    'Incompatible',
  )
  expect(() =>
    requireExecutionCompatibility({ ...executionHello(), capabilities: ['readiness'] }),
  ).toThrow('Incompatible')
})
