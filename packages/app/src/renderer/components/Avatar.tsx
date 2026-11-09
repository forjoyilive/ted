import type { AgentKind } from '@ted/protocol'
import styles from './Avatar.module.css'
import { AgentMark, agentNames } from './RunIcon.tsx'

export function AgentAvatar({ agent }: { agent: AgentKind | 'codex' }) {
  return (
    <span className={styles.agent} role="img" aria-label={agentNames[agent]}>
      <AgentMark agent={agent} size={12} />
    </span>
  )
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0] ?? ''
  const last = words.length > 1 ? (words.at(-1) ?? '') : ''
  return (first.charAt(0) + last.charAt(0)).toUpperCase()
}

export function PersonAvatar({
  name,
  photo,
  size = 22,
}: {
  name: string
  photo?: string | undefined
  size?: number
}) {
  const box = { width: size, height: size, borderRadius: size / 2 }
  if (photo !== undefined) {
    return (
      <img className={styles.photo} src={photo} alt={name} width={size} height={size} style={box} />
    )
  }
  return (
    <span
      className={styles.initials}
      role="img"
      aria-label={name}
      style={{ ...box, fontSize: Math.round(size * 0.4) }}
    >
      {initialsOf(name)}
    </span>
  )
}
