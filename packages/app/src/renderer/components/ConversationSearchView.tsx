import type { ConversationHit, RunChat } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { useConnection } from '../data.ts'
import { readableError, ted } from '../ted.ts'
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
  const { epoch } = useConnection()
  const [chat, setChat] = useState<RunChat>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    void epoch
    let current = true
    let revision = 0
    const load = async () => {
      const request = ++revision
      try {
        const found = await ted.getRunChat(hit.runId)
        if (current && request === revision) {
          setChat(found)
          setError(undefined)
        }
      } catch (failure) {
        if (current && request === revision) setError(readableError(failure))
      }
    }
    void load()
    const unsubscribe = ted.onEvent((event) => {
      if (
        (event.type === 'run-output' && event.runId === hit.runId) ||
        (event.type === 'run-updated' && event.run.id === hit.runId)
      )
        void load()
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [hit.runId, epoch])
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
