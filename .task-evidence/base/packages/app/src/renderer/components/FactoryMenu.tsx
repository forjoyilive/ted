import type { Factory } from '@ted/protocol'
import { useCallback, useEffect, useRef } from 'react'
import { usePopover } from '../views/TaskList.tsx'
import styles from './FactoryMenu.module.css'

const folderLabel = navigator.userAgent.includes('Mac') ? 'Show in Finder' : 'Show in file manager'

export interface FactoryMenuActions {
  onNewTask: () => void
  onPlan: () => void
  onRename: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onSettings: () => void
  onShowFolder: () => void
  onOpenOnGitHub: () => void
  onRemove: () => void
}

export function FactoryMenu({
  factory,
  at,
  first,
  last,
  actions,
  onClose,
}: {
  factory: Factory
  at: { x: number; y: number }
  first: boolean
  last: boolean
  actions: FactoryMenuActions
  onClose: () => void
}) {
  const close = useCallback(() => onClose(), [onClose])
  const ref = usePopover(true, close)
  const menu = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [])
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 330))
  const item = (label: string, act: () => void, options: { disabled?: boolean } = {}) => (
    <button
      type="button"
      role="menuitem"
      className={styles.item}
      disabled={options.disabled === true}
      onClick={() => {
        onClose()
        act()
      }}
    >
      {label}
    </button>
  )
  return (
    <div ref={ref}>
      <div
        ref={menu}
        className={styles.menu}
        role="menu"
        aria-label="Factory actions"
        style={{ left: at.x, top }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const items = [
            ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
          ]
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          const step = event.key === 'ArrowDown' ? 1 : -1
          items[(index + step + items.length) % items.length]?.focus()
        }}
      >
        {item('New Task', actions.onNewTask)}
        {item('Plan', actions.onPlan, { disabled: !factory.cloned })}
        {item('Rename…', actions.onRename)}
        {item('Move up', actions.onMoveUp, { disabled: first })}
        {item('Move down', actions.onMoveDown, { disabled: last })}
        <hr className={styles.separator} />
        {item('Factory settings', actions.onSettings)}
        {factory.localFolder?.found === true && item(folderLabel, actions.onShowFolder)}
        {item('Open on GitHub', actions.onOpenOnGitHub)}
        <hr className={styles.separator} />
        <button
          type="button"
          role="menuitem"
          className={`${styles.item} ${styles.danger}`}
          onClick={() => {
            onClose()
            actions.onRemove()
          }}
        >
          Remove Factory…
        </button>
      </div>
    </div>
  )
}
