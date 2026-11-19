import { type AgentKind, piSandboxQuestion } from '@ted/protocol'
import type { Agents } from './agents/index.ts'
import { RequestError } from './errors.ts'
import { factoryPermissions } from './permissions.ts'
import type { TedStore } from './store/index.ts'

export class AgentDisabledError extends RequestError {
  constructor(agent: AgentKind) {
    super(409, `${agent} is off. Enable it in Settings → Providers to start new Runs.`)
  }
}

export const piModelHold = 'Choose a model for Pi in Settings before Pi work starts.'

export interface StartScope {
  factoryId: string | undefined
  model: string | undefined
  agents: Pick<Agents, 'savedModel'>
  alwaysAuto?: boolean
}

export function piSandboxHold(store: TedStore): string | undefined {
  const problem = store.piSandboxProblem()
  return problem === undefined || store.settings().piUnsandboxedAllowed
    ? undefined
    : piSandboxQuestion(problem)
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
  const bypass =
    scope.alwaysAuto !== true &&
    scope.factoryId !== undefined &&
    factoryPermissions(store, scope.factoryId) === 'bypass'
  const held = bypass ? undefined : piSandboxHold(store)
  if (held !== undefined) return held
  if (!live && scope.model === undefined && scope.agents.savedModel('pi') === undefined)
    return piModelHold
  return undefined
}
