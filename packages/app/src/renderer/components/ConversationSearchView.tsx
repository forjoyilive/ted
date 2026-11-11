import type { ConversationHit, RunChat } from '@ted/protocol'
import { useEventValue } from '../data.ts'
import { ted } from '../ted.ts'
import { Button } from './Button.tsx'
import { ChatSection } from './RunChat.tsx'
import styles from './SearchPalette.module.css'

export function ConversationSearchView({
  hit,
  onBack,
}: {
  hit: ConversationHit
  onBack: () => void
}) {
  const { value: chat, error } = useEventValue<RunChat | undefined>({
    initial: undefined,
    key: hit.runId,
    load: () => ted.getRunChat(hit.runId),
    event: (event) =>
      (event.type === 'run-output' && event.runId === hit.runId) ||
      (event.type === 'run-updated' && event.run.id === hit.runId)
        ? 'reload'
        : undefined,
  })
  const missing = chat !== undefined && !chat.items.some((item) => item.id === hit.itemId)
  return (
    <>
      <div className={styles.viewerHeader}>
        <Button size="small" onClick={onBack}>
          ← Results
        </Button>
        <span className={styles.main}>
          <strong className={styles.title}>
            {hit.ref} · {hit.title}
          </strong>
          <span className={styles.byline}>{hit.runName} · Read-only Conversation</span>
        </span>
      </div>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {missing && (
        <p className={styles.none}>
          The matching item is no longer available. The remaining Conversation is shown below.
        </p>
      )}
      {error === undefined && (
        <ChatSection chat={chat} options={{ inspect: true, matchItemId: hit.itemId }} />
      )}
    </>
  )
}
