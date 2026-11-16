import type { Factory, FactoryGroup } from '@ted/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePendingAction } from '../pending-action.ts'
import { usePopover } from '../views/TaskList.tsx'
import { ActionButton } from './ActionButton.tsx'
import styles from './FactoryMenu.module.css'

const folderLabel = navigator.userAgent.includes('Mac') ? 'Show in Finder' : 'Show in file manager'

export interface FactoryMenuActions {
  onNewTask: () => void
  onPlan: () => void
  onRename: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onMoveToGroup: (groupId: string | undefined) => unknown
  onNewGroup: () => void
  onSettings: () => void
  onShowFolder: () => void
  onOpenOnGitHub: () => void
  onRemove: () => void
}

export interface MenuItem {
  label: string
  act: () => unknown
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  divider?: boolean
  keepOpen?: boolean
}

export function PopoverMenu({
  label,
  at,
  items,
  pendingKey,
  onClose,
}: {
  label: string
  at: { x: number; y: number }
  items: readonly MenuItem[]
  pendingKey: string
  onClose: () => void
}) {
  const activity = usePendingAction(pendingKey)
  const close = useCallback(() => onClose(), [onClose])
  const ref = usePopover(true, close)
  const menu = useRef<HTMLDivElement | null>(null)
  const page = items.map((item) => item.label).join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the first item of each page
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [page])
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 30 * items.length - 40))
  return (
    <div ref={ref}>
      <div
        ref={menu}
        className={styles.menu}
        role="menu"
        aria-label={label}
        style={{ left: at.x, top }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const buttons = [
            ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
          ]
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const step = event.key === 'ArrowDown' ? 1 : -1
          buttons[(index + step + buttons.length) % buttons.length]?.focus()
        }}
      >
        {items.map((item) => (
          <div key={item.label} className={styles.entry}>
            {item.divider && <hr className={styles.separator} />}
            <ActionButton
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              className={`${styles.item} ${item.danger ? styles.danger : ''}`}
              disabled={item.disabled === true || activity.pending}
              onClick={() => {
                if (item.keepOpen) return item.act()
                const result = activity.run(item.act)
                if (result) return result.then(onClose)
                onClose()
              }}
            >
              <span className={styles.itemLabel}>{item.label}</span>
              {item.checked && <span className={styles.check}>✓</span>}
            </ActionButton>
          </div>
        ))}
      </div>
    </div>
  )
}

export function FactoryMenu({
  factory,
  at,
  first,
  last,
  groups,
  groupId,
  actions,
  onClose,
}: {
  factory: Factory
  at: { x: number; y: number }
  first: boolean
  last: boolean
  groups: readonly FactoryGroup[]
  groupId: string | undefined
  actions: FactoryMenuActions
  onClose: () => void
}) {
  const [page, setPage] = useState<'main' | 'groups'>('main')
  const current = groups.find((g) => g.id === groupId)
  const groupItems: MenuItem[] = [
    { label: '‹ Back', act: () => setPage('main'), keepOpen: true },
    ...groups.map((group, index) => ({
      label: group.name,
      checked: group.id === groupId,
      divider: index === 0,
      act: () => (group.id === groupId ? undefined : actions.onMoveToGroup(group.id)),
    })),
    { label: 'New Factory group…', act: actions.onNewGroup, divider: true },
    ...(current
      ? [{ label: `Remove from ${current.name}`, act: () => actions.onMoveToGroup(undefined) }]
      : []),
  ]
  const mainItems: MenuItem[] = [
    { label: 'New Task…', act: actions.onNewTask },
    { label: 'Plan…', act: actions.onPlan, disabled: !factory.cloned },
    { label: 'Rename…', act: actions.onRename },
    { label: 'Move up', act: actions.onMoveUp, disabled: first },
    { label: 'Move down', act: actions.onMoveDown, disabled: last },
    { label: 'Move to Factory group…', act: () => setPage('groups'), keepOpen: true },
    { label: 'Factory settings', act: actions.onSettings, divider: true },
    ...(factory.localFolder?.found === true
      ? [{ label: folderLabel, act: actions.onShowFolder }]
      : []),
    { label: 'Open on GitHub', act: actions.onOpenOnGitHub },
    {
      label: 'Remove Factory…',
      danger: true,
      divider: true,
      act: () => {
        onClose()
        return actions.onRemove()
      },
    },
  ]
  return (
    <PopoverMenu
      label={page === 'main' ? 'Factory actions' : 'Move to Factory group'}
      at={at}
      items={page === 'main' ? mainItems : groupItems}
      pendingKey={`factory-actions:${factory.id}`}
      onClose={onClose}
    />
  )
}
