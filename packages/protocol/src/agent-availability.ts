import { type AgentKind, agentKinds } from './run.ts'
import { RequestValidationError } from './validation.ts'

export interface AgentAvailability {
  agent: AgentKind
  enabled: boolean
  runs: { id: string; agent: AgentKind; name: string; taskId?: string }[]
  additionalRuns: { id: string; agent: AgentKind; name: string; taskId?: string }[]
}

export interface ChangeAgentAvailabilityRequest {
  agent: AgentKind
  enabled: boolean
  existing?: 'keep' | 'stop'
  confirmedRunIds?: string[]
}

export interface ChangeAgentAvailabilityResult {
  availability: AgentAvailability
  confirmationRequired: boolean
}

export function parseChangeAgentAvailabilityRequest(
  value: unknown,
): ChangeAgentAvailabilityRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RequestValidationError(400, 'Agent availability must be an object')
  const body = value as Record<string, unknown>
  const agent = agentKinds.find((kind) => kind === body.agent)
  if (!agent || typeof body.enabled !== 'boolean')
    throw new RequestValidationError(400, 'Choose an agent and whether it is enabled')
  if (body.existing !== undefined && body.existing !== 'keep' && body.existing !== 'stop')
    throw new RequestValidationError(400, 'existing must be keep or stop')
  if (
    body.confirmedRunIds !== undefined &&
    (!Array.isArray(body.confirmedRunIds) ||
      body.confirmedRunIds.length > 10000 ||
      body.confirmedRunIds.some((id) => typeof id !== 'string' || id.length > 200))
  )
    throw new RequestValidationError(400, 'confirmedRunIds must list Run IDs')
  return {
    agent,
    enabled: body.enabled,
    ...(body.existing !== undefined && { existing: body.existing }),
    ...(body.confirmedRunIds !== undefined && {
      confirmedRunIds: body.confirmedRunIds as string[],
    }),
  }
}
