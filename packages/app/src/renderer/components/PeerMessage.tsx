import type { Comment } from '@ted/protocol'
import { useId, useState } from 'react'
import { ago } from '../requests.ts'
import { ChevronIcon } from './icons.tsx'
import { Markdown } from './Markdown.tsx'
import styles from './PeerMessage.module.css'

function preview(text: string): string {
  return text
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function PeerMessage({
  peer,
  at,
  now,
}: {
  peer: NonNullable<Comment['peer']>
  at: string
  now: number
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const label = peer.sender ? `Peer · ${peer.sender}` : 'Peer message'
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.head}
        aria-label={label}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <ChevronIcon open={open} className={styles.chevron} />
        <span className={styles.sender}>{label}</span>
        <span className={styles.preview}>{preview(peer.text)}</span>
        <time className={styles.time} dateTime={at}>
          {ago(at, now)}
        </time>
      </button>
      <div id={bodyId} hidden={!open}>
        {open && (
          <div className={styles.body}>
            <Markdown text={peer.text} />
            <p className={styles.context}>Agent context; decisions still require the user.</p>
          </div>
        )}
      </div>
    </div>
  )
}
