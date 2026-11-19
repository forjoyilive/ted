import type { AgentKind } from '@ted/protocol'
import type { Agents } from './agents/index.ts'
import { RequestError } from './errors.ts'
import { factoryPermissions } from './permissions.ts'
import type { TedStore } from './store/index.ts'

export class AgentDisabledError extends RequestError {
  constructor(agent: AgentKind) {
    super(409, `${agent} is off. Enable it in Settings → Providers to start new Runs.`)
  }
}

export const piAutoHold = 'Pi can’t run in an Auto Factory yet.'

export const piModelHold = 'Choose a model for Pi in Settings before Pi work starts.'

export interface StartScope {
  factoryId: string | undefined
  model: string | undefined
  agents: Pick<Agents, 'savedModel'>
}

export function agentStartHold(
  store: TedStore,
  agent: AgentKind,
  runId: string | undefined,
  scope: StartScope,
): string | undefined {
  const live = runId !== undefined && store.getRun(runId) !== undefined
  if (!store.settings().enabledAgents.includes(agent) && !live)
    return `${agent} is off. Enable it in Settings → Providers.`
  if (agent !== 'pi') return undefined
  if (scope.factoryId === undefined || factoryPermissions(store, scope.factoryId) !== 'bypass')
    return piAutoHold
  if (!live && scope.model === undefined && scope.agents.savedModel('pi') === undefined)
    return piModelHold
  return undefined
}
