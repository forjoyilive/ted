import type { AgentKind } from '@ted/protocol'
import { RequestError } from './errors.ts'
import type { TedStore } from './store/index.ts'

export class AgentDisabledError extends RequestError {
  constructor(agent: AgentKind) {
    super(409, `${agent} is off. Enable it in Settings → Providers to start new Runs.`)
  }
}

export function agentStartHold(
  store: TedStore,
  agent: AgentKind,
  runId?: string,
): string | undefined {
  if (store.settings().enabledAgents.includes(agent) || (runId && store.getRun(runId)))
    return undefined
  return `${agent} is off. Enable it in Settings → Providers.`
}
