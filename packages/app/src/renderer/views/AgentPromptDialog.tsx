import { useState } from 'react'
import dialogs from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import grow from '../components/TextGrow.module.css'
import { useMessageDraft } from '../message-drafts.ts'
import { readableError } from '../ted.ts'
import styles from './AgentPromptDialog.module.css'

export function AgentPromptDialog({
  factoryId,
  unsaved,
  onDraft,
  onClose,
}: {
  factoryId: string
  unsaved: boolean
  onDraft: (description: string) => Promise<void>
  onClose: () => void
}) {
  const { text, setText, clear } = useMessageDraft({ kind: 'agent-prompt', id: factoryId })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const ready = text.trim() !== '' && !sending

  async function draft() {
    setSending(true)
    setError(undefined)
    try {
      await onDraft(text)
      clear()
    } catch (failed) {
      setError(readableError(failed))
      setSending(false)
    }
  }

  return (
    <Dialog className={styles.dialog} onClose={() => !sending && onClose()}>
      {(headingId) => (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (ready) void draft()
          }}
        >
          <h2 id={headingId} className={dialogs.heading}>
            Create an Agent from a prompt
          </h2>
          <p className={dialogs.body}>
            Describe what the Agent is for and how it should work. Ted opens a new Coordinator chat,
            and the Coordinator drafts the Agent for you to review before anything is saved.
          </p>
          <textarea
            className={`${styles.prompt} ${grow.text}`}
            aria-label="What the Agent is for"
            placeholder="For example: an Agent that checks for outdated dependencies each week and proposes upgrade Tasks."
            value={text}
            disabled={sending}
            autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) {
                event.preventDefault()
                void draft()
              }
            }}
          />
          {unsaved && (
            <p className={styles.warning}>
              Opening the chat leaves Settings, and your unsaved changes there are discarded.
            </p>
          )}
          {error !== undefined && (
            <p className={dialogs.error} role="alert">
              {error}
            </p>
          )}
          <div className={dialogs.buttons}>
            <Button disabled={sending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!ready} pending={sending}>
              Draft
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
