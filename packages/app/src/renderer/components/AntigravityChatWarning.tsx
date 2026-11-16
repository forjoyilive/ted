import type { AgentKind } from '@ted/protocol'
import { chatToolPolicy } from '@ted/protocol/run'
import styles from './AntigravityChatWarning.module.css'
import { Help } from './Help.tsx'

export function AntigravityChatWarning({ agent }: { agent: AgentKind }) {
  if (chatToolPolicy(agent) !== 'isolated') return null
  return (
    <div className={styles.notice}>
      <span>Antigravity can use tools in this chat.</span>
      <Help align="end">
        Its built-in tools may run without asking. Ted uses an isolated workspace and keeps file,
        command, web and MCP permissions denied. Choose Claude Code or Codex if you need a tool-free
        chat.
      </Help>
    </div>
  )
}
