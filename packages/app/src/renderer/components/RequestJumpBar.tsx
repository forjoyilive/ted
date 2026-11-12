import styles from './RequestJumpBar.module.css'

export interface RequestJump {
  id: string
  label: string
  title: string
}

export function RequestJumpBar({
  requests,
  onJump,
}: {
  requests: readonly RequestJump[]
  onJump: (id: string) => void
}) {
  if (requests.length === 0) return null
  return (
    <nav className={styles.bar} aria-label="Requests waiting for you">
      <span className={styles.count}>{`${requests.length} waiting for you`}</span>
      {requests.map((request) => (
        <button
          key={request.id}
          type="button"
          className={styles.jump}
          aria-label={`Jump to ${request.label}: ${request.title}`}
          title={request.title}
          data-nav-item
          onClick={() => onJump(request.id)}
        >
          {request.label} ↗
        </button>
      ))}
    </nav>
  )
}
