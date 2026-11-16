import type { AgentName } from '../agent-chats.ts'
import styles from './AgentAbout.module.css'

const about: Record<AgentName, string> = {
  Coordinator:
    'Compares this Factory’s Tasks and recommends what to do next. When you ask, it starts, moves, tells or answers Tasks; deletes and risky archives wait for your confirmation.',
  Planner:
    'Reads the repos, talks a large piece of work through with you in rounds, then proposes Tasks. Nothing is created until you approve the proposal.',
}

export function AgentAbout({ agent, provider }: { agent: AgentName; provider?: string }) {
  return (
    <div className={styles.about}>
      <p className={styles.name}>{agent}</p>
      <p>{about[agent]}</p>
      {provider !== undefined && provider !== '' && <p className={styles.provider}>{provider}</p>}
    </div>
  )
}
