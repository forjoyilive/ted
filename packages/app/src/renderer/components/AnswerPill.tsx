import { useState } from 'react'
import { ActionButton } from './ActionButton.tsx'
import styles from './AnswerPill.module.css'
import { buttonPosition, ContextMenu, type MenuPosition } from './ContextMenu.tsx'
import type { RequestJump } from './RequestJumpBar.tsx'
import { StatusGlyphIcon, statusChipClass } from './StatusChip.tsx'

const pillClass = `${statusChipClass('waiting', true)} ${styles.pill}`

export function AnswerPill({
  requests,
  onJump,
}: {
  requests: readonly RequestJump[]
  onJump: (id: string) => void
}) {
  const [menu, setMenu] = useState<MenuPosition>()
  const [only] = requests
  if (only === undefined) return null
  if (requests.length === 1) {
    return (
      <ActionButton
        type="button"
        className={pillClass}
        aria-label={`Jump to ${only.label}: ${only.title}`}
        title={only.title}
        data-nav-item
        onClick={() => onJump(only.id)}
      >
        <StatusGlyphIcon glyph="waiting" />
        {`Answer ${only.label} ↗`}
      </ActionButton>
    )
  }
  const label = `${requests.length} waiting on you`
  return (
    <>
      <ActionButton
        type="button"
        className={pillClass}
        aria-haspopup="menu"
        aria-expanded={menu !== undefined}
        data-nav-item
        onClick={(event) => {
          event.stopPropagation()
          setMenu(menu ? undefined : buttonPosition(event.currentTarget))
        }}
      >
        <StatusGlyphIcon glyph="waiting" />
        {`${label} ▾`}
      </ActionButton>
      {menu && (
        <ContextMenu at={menu} label={label} onClose={() => setMenu(undefined)}>
          {requests.map((request) => (
            <ActionButton
              key={request.id}
              type="button"
              role="menuitem"
              className={styles.item}
              aria-label={`Jump to ${request.label}: ${request.title}`}
              onClick={(event) => {
                event.currentTarget.blur()
                setMenu(undefined)
                onJump(request.id)
              }}
            >
              <span className={styles.kind}>{request.label}</span>
              <span className={styles.title}>{request.title}</span>
            </ActionButton>
          ))}
        </ContextMenu>
      )}
    </>
  )
}
