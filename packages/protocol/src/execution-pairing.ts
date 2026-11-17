import { type Edition, edition } from './edition.ts'
import type { MachineOperations, WorkerOperations } from './execution-commands.ts'
import { isObject, parseJson } from './parse.ts'
import { RequestValidationError } from './validation.ts'

export const executionProtocol = 1
export const executionCapabilities = ['readiness', 'revoke', 'commands'] as const
export const enrollmentLifetimeMs = 5 * 60_000

export interface ExecutionEndpoint {
  address: string
  port: number
}
export interface ExecutionScope {
  factoryId: string
  repo: string
}
export interface ExecutionHello {
  protocol: number
  edition: Edition
  capabilities: string[]
}
export interface ExecutionReadiness {
  observedAt: string
  platform: string
  arch: string
  version: string
  agents: {
    name: string
    detected: boolean
    version: string | null
    versionReason: string
    modelAccess: 'unknown'
    reason: string
  }[]
  sandbox: { available: boolean; reason: string }
  freeBytes: number
  loadPerCore: number
  capacity: number
}
export interface ExecutionOffer extends ExecutionHello, ExecutionEndpoint {
  pairingPort: number
  controllerPin: string
  controllerCertificate: string
  secret: string
  expiresAt: string
}
export interface ExecutionEnrollment extends ExecutionHello {
  secret: string
  csr: string
  name: string
  readiness: ExecutionReadiness
}
export interface ApproveExecution {
  id: string
  scopes: ExecutionScope[]
}
export interface ExecutionIdRequest {
  id: string
}
export interface ExecutionGrant {
  id: string
  name: string
  publicKey: string
  certificateId: string
  scopes: ExecutionScope[]
  approvedAt: string
  revokedAt?: string
}
export interface ExecutionPending {
  id: string
  name: string
  publicKey: string
  expiresAt: string
  readiness: ExecutionReadiness
}
export interface ExecutionMachines {
  disabled?: true
  endpoint?: ExecutionEndpoint
  controllerPin?: string
  addresses: { name: string; address: string }[]
  pending: ExecutionPending[]
  machines: (ExecutionGrant & {
    connected: boolean
    readiness?: ExecutionReadiness
    operations?: MachineOperations
  })[]
  repos: (ExecutionScope & { factoryName: string })[]
  problem?: string
}
export interface ExecutionCertificate {
  grantId: string
  certificate: string
  ca: string
  scopes: ExecutionScope[]
}
export interface ExecutionHeartbeat extends ExecutionHello {
  grantId: string
  readiness: ExecutionReadiness
}
export interface WorkerPairRequest {
  details: string
  capacity: number
}
export interface WorkerStatus {
  state:
    | 'stopped'
    | 'unpaired'
    | 'connecting'
    | 'pending'
    | 'connected'
    | 'disconnected'
    | 'refused'
  message: string
  publicKey?: string
  controllerPin?: string
  grantId?: string
  readiness?: ExecutionReadiness
  scopes: ExecutionScope[]
  operations?: WorkerOperations
}

function invalid(message: string): never {
  throw new RequestValidationError(400, message)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 256): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    invalid('Invalid execution text')
  return value
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid('Invalid execution number')
  return value
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    invalid('Invalid readiness reading')
  return value
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('Expected a boolean')
  return value
}
function timestamp(value: unknown): string {
  const s = text(value, 40)
  if (!Number.isFinite(Date.parse(s))) invalid('Invalid execution time')
  return s
}
function pin(value: unknown): string {
  const s = text(value, 64)
  if (!/^[a-f0-9]{64}$/.test(s)) invalid('Invalid execution identity')
  return s
}
function pem(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('-----BEGIN '))
    invalid('Invalid execution certificate')
  return value
}
export function executionCapacity(value: unknown): number {
  return integer(value, 1, 64)
}
export function parseExecutionEndpoint(value: unknown): ExecutionEndpoint {
  const v = object(value),
    address = text(v.address, 64)
  const parts = address.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.map(String).join('.') !== address ||
    !parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ||
    !address.match(/^\d+\.\d+\.\d+\.\d+$/) ||
    !(
      parts[0] === 10 ||
      (parts[0] === 172 && (parts[1] ?? -1) >= 16 && (parts[1] ?? -1) <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && (parts[1] ?? -1) >= 64 && (parts[1] ?? -1) <= 127) ||
      address === '127.0.0.1'
    )
  )
    invalid('Choose an explicit private local IPv4 address')
  return { address, port: integer(v.port, 1, 65535) }
}
export function parseExecutionHello(value: unknown): ExecutionHello {
  const v = object(value)
  if (v.edition !== 'dev' && v.edition !== 'release') invalid('Invalid Ted edition')
  if (!Array.isArray(v.capabilities) || v.capabilities.length > 16)
    invalid('Invalid execution capabilities')
  return {
    protocol: integer(v.protocol, 1, 65535),
    edition: v.edition,
    capabilities: v.capabilities.map((c) => text(c, 64)),
  }
}
export function requireExecutionCompatibility(value: ExecutionHello): void {
  if (
    value.protocol !== executionProtocol ||
    value.edition !== edition ||
    !executionCapabilities.every((c) => value.capabilities.includes(c))
  )
    invalid(
      'Incompatible execution protocol, capabilities or Ted edition. Update both Macs to the same Ted release.',
    )
}
export function executionHello(): ExecutionHello {
  return { protocol: executionProtocol, edition, capabilities: [...executionCapabilities] }
}
export function parseExecutionOffer(value: unknown): ExecutionOffer {
  const v = object(value)
  return {
    ...parseExecutionEndpoint(v),
    ...parseExecutionHello(v),
    pairingPort: integer(v.pairingPort, 1, 65535),
    controllerPin: pin(v.controllerPin),
    controllerCertificate: pem(v.controllerCertificate),
    secret: pin(v.secret),
    expiresAt: timestamp(v.expiresAt),
  }
}
export function parseExecutionReadiness(value: unknown): ExecutionReadiness {
  const v = object(value),
    sandbox = object(v.sandbox)
  if (!Array.isArray(v.agents) || v.agents.length > 2) invalid('Invalid agent readiness')
  return {
    observedAt: timestamp(v.observedAt),
    platform: text(v.platform, 32),
    arch: text(v.arch, 32),
    version: text(v.version, 64),
    agents: v.agents.map((a) => {
      const agent = object(a)
      if (agent.modelAccess !== 'unknown') invalid('Model access must be reported as unverified')
      return {
        name: text(agent.name, 32),
        detected: bool(agent.detected),
        version: agent.version === null ? null : text(agent.version, 128),
        versionReason: text(agent.versionReason, 256),
        modelAccess: 'unknown',
        reason: text(agent.reason, 256),
      }
    }),
    sandbox: { available: bool(sandbox.available), reason: text(sandbox.reason, 256) },
    freeBytes: finite(v.freeBytes),
    loadPerCore: finite(v.loadPerCore),
    capacity: executionCapacity(v.capacity),
  }
}
export function parseExecutionEnrollment(value: unknown): ExecutionEnrollment {
  const v = object(value)
  return {
    ...parseExecutionHello(v),
    secret: pin(v.secret),
    csr: pem(v.csr),
    name: text(v.name, 80),
    readiness: parseExecutionReadiness(v.readiness),
  }
}
export function parseExecutionHeartbeat(value: unknown): ExecutionHeartbeat {
  const v = object(value)
  return {
    ...parseExecutionHello(v),
    grantId: text(v.grantId, 80),
    readiness: parseExecutionReadiness(v.readiness),
  }
}
export function parseApproveExecution(value: unknown): ApproveExecution {
  const v = object(value)
  if (!Array.isArray(v.scopes) || v.scopes.length < 1 || v.scopes.length > 128)
    invalid('Select at least one repo')
  return {
    id: text(v.id, 80),
    scopes: v.scopes.map((s) => {
      const scope = object(s),
        repo = text(scope.repo, 200).toLowerCase()
      if (
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) ||
        repo.split('/').some((p) => p === '.' || p === '..')
      )
        invalid('Invalid repo')
      return { factoryId: text(scope.factoryId, 80), repo }
    }),
  }
}
export function parseExecutionIdRequest(value: unknown): ExecutionIdRequest {
  return { id: text(object(value).id, 80) }
}
export function parseWorkerPairRequest(value: unknown): WorkerPairRequest {
  const v = object(value),
    details = text(v.details, 8192)
  const parsed = parseJson(details)
  if (
    isObject(parsed) &&
    parsed.controllerPin !== undefined &&
    !('controllerCertificate' in parsed)
  )
    invalid('These pairing details are from an older TED. Create new details on the main Mac.')
  try {
    parseExecutionOffer(parsed)
  } catch {
    invalid('Pairing details are invalid. Create fresh details on the main Mac.')
  }
  return { details, capacity: executionCapacity(v.capacity) }
}
export function parseExecutionCertificate(value: unknown): ExecutionCertificate {
  const v = object(value),
    scopes = parseApproveExecution({ id: v.grantId, scopes: v.scopes })
  return {
    grantId: scopes.id,
    scopes: scopes.scopes,
    certificate: pem(v.certificate),
    ca: pem(v.ca),
  }
}
