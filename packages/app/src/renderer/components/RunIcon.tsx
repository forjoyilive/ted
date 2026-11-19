import type { AgentKind } from '@ted/protocol'
import { ClaudeCodeMark, CodexMark } from './icons.tsx'
import styles from './RunIcon.module.css'

export type RunIconState = 'working' | 'waiting' | 'idle' | 'paused' | 'failed'

const stateLabels: Record<RunIconState, string> = {
  working: 'working',
  waiting: 'waiting on you',
  idle: 'idle',
  paused: 'paused',
  failed: 'failed',
}

export const agentNames: Record<AgentKind | 'codex', string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  pi: 'Pi',
}

export function AgentMark({ agent, size }: { agent: AgentKind | 'codex'; size: number }) {
  if (agent === 'antigravity')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <path d="M8 1 15 15h-3L8 6l-4 9H1Z" fill="currentColor" />
      </svg>
    )
  return agent === 'codex' ? <CodexMark size={size} /> : <ClaudeCodeMark size={size} />
}

export function RunIcon({ agent, state }: { agent: AgentKind | 'codex'; state: RunIconState }) {
  return (
    <span
      className={`${styles.ring} ${styles[state]}`}
      role="img"
      aria-label={`${agentNames[agent]}, ${stateLabels[state]}`}
    >
      <AgentMark agent={agent} size={10} />
    </span>
  )
}
