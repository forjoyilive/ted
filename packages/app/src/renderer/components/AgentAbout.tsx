import type { AgentSummary, LayerKind } from '@ted/protocol'
import {
  type AgentCommand,
  type AgentPower,
  agentPowerNames,
  type BuiltInAgentId,
  builtInAgentIds,
} from '@ted/protocol/agent-files'
import styles from './AgentAbout.module.css'

const about = {
  coordinator:
    'Compares this Factory’s Tasks and recommends what to do next. When you ask, it starts, moves, tells or answers Tasks; deletes and risky archives wait for your confirmation. It can also draft Agents for you to create.',
  planner:
    'Reads the repos, talks a large piece of work through with you in rounds, then proposes Tasks. Nothing is created until you approve the proposal.',
} satisfies Record<BuiltInAgentId, string>

export const builtInCoordinator: AgentSummary = {
  id: 'coordinator',
  name: 'Coordinator',
  source: 'ted',
  powers: ['ask', 'manage_tasks', 'manage_agents'],
}

export const builtInPlanner: AgentSummary = {
  id: 'planner',
  name: 'Planner',
  source: 'ted',
  powers: ['ask', 'propose_tasks', 'read_code'],
}

export const agentSources: Readonly<Record<LayerKind, string>> = {
  ted: 'Built in',
  library: 'Library',
  factory: 'This repo',
}

export const removedAgentNote =
  'Removed from this Factory’s Agent files. You can read, archive or delete this chat.'

export function powerNames(powers: readonly AgentPower[]): string[] {
  return powers.map((power) => agentPowerNames[power])
}

export function AgentAbout({
  agent,
  provider,
  removed = false,
}: {
  agent: Pick<AgentSummary, 'id' | 'name' | 'source'>
  provider?: string | undefined
  removed?: boolean
}) {
  const builtIn = builtInAgentIds.find((id) => id === agent.id)
  const text = agent.source === 'ted' && builtIn !== undefined ? about[builtIn] : undefined
  return (
    <div className={styles.about}>
      <p className={styles.name}>{agent.name}</p>
      {text !== undefined && <p>{text}</p>}
      {provider !== undefined && provider !== '' && <p className={styles.provider}>{provider}</p>}
      {removed && <p className={styles.removed}>{removedAgentNote}</p>}
    </div>
  )
}

export function AgentPowers({ powers }: { powers: readonly AgentPower[] }) {
  if (powers.length === 0) return <p className={styles.none}>None</p>
  return (
    <ul className={styles.powers}>
      {powerNames(powers).map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  )
}

export function AgentSource({ source }: { source: LayerKind }) {
  return <p className={styles.source}>{agentSources[source]}</p>
}

export function shownCommands(
  agent: Pick<AgentSummary, 'powers' | 'commands'>,
): readonly AgentCommand[] {
  return agent.powers.includes('run_commands') ? (agent.commands ?? []) : []
}

export function AgentCommands({ commands }: { commands: readonly AgentCommand[] }) {
  return (
    <ul className={styles.commands}>
      {commands.map((command) => (
        <li key={command.name}>
          <span className={styles.commandName}>{command.name}</span>
          <code className={styles.command}>{command.command}</code>
        </li>
      ))}
    </ul>
  )
}
