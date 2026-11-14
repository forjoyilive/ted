import {
  Fragment,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { usePendingAction } from '../pending-action.ts'
import { readableError } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './ContextMenu.module.css'

export interface MenuPosition {
  x: number
  y: number
  trigger: HTMLElement
}

const menuOpened = 'ted:context-menu-opened'
const submenuOpened = 'ted:context-submenu-opened'

export function contextMenu(open: (at: MenuPosition) => void): HTMLAttributes<HTMLElement> {
  return {
    'data-context-menu': true,
    onContextMenu: (event) => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest(
          'textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"])',
        )
      )
        return
      event.preventDefault()
      event.stopPropagation()
      const element = event.currentTarget
      const focused = document.activeElement
      const trigger = element.matches('button, [tabindex]')
        ? element
        : focused instanceof HTMLElement && element.contains(focused)
          ? focused
          : (element.querySelector<HTMLElement>('button') ?? element)
      open({ x: event.clientX, y: event.clientY, trigger })
    },
  } as HTMLAttributes<HTMLElement>
}

export function buttonPosition(trigger: HTMLElement): MenuPosition {
  const box = trigger.getBoundingClientRect()
  return { x: box.left, y: box.bottom + 6, trigger }
}

function enabled(menu: HTMLElement): HTMLButtonElement[] {
  return [
    ...menu.querySelectorAll<HTMLButtonElement>(
      'button:not(:disabled):not([aria-disabled="true"])',
    ),
  ].filter((item) => item.closest('[role="menu"]') === menu)
}

export function ContextMenu({
  at,
  label,
  children,
  onClose,
  submenu = false,
  pending = false,
}: {
  at: MenuPosition
  label: string
  children: ReactNode
  onClose: () => void
  submenu?: boolean
  pending?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const restore = useRef(true)
  useLayoutEffect(() => {
    if (pending) ref.current?.focus()
  }, [pending])
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    restore.current = true
    const box = menu.getBoundingClientRect()
    const left =
      submenu && at.x + box.width > window.innerWidth - 8
        ? at.trigger.getBoundingClientRect().left - box.width
        : at.x
    menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - box.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - box.height - 8))}px`
    ;(enabled(menu)[0] ?? menu).focus()
    return () => {
      if (restore.current && at.trigger.isConnected && menu.contains(document.activeElement))
        at.trigger.focus()
    }
  }, [at, submenu])
  useEffect(() => {
    void at
    if (submenu) return
    const other = () => {
      restore.current = false
      close.current()
    }
    window.dispatchEvent(new Event(menuOpened))
    const outside = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-context-popup]')) return
      other()
    }
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(at.trigger)) outside(event)
    }
    window.addEventListener(menuOpened, other)
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', other)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      window.removeEventListener(menuOpened, other)
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', other)
      window.removeEventListener('scroll', scrolled, true)
    }
  }, [at, submenu])
  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      data-context-popup
      className={styles.menu}
      style={{ left: at.x, top: at.y }}
      onPointerOver={(event) => {
        const target = event.target
        if (
          !submenu &&
          target instanceof Element &&
          target.closest('[role="menu"]') === ref.current &&
          target.closest('button')?.getAttribute('aria-haspopup') !== 'menu'
        )
          window.dispatchEvent(new CustomEvent(submenuOpened, { detail: undefined }))
      }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        const menu = ref.current
        if (!menu) return
        const items = enabled(menu)
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const key = event.key
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
          event.preventDefault()
          if (!submenu) window.dispatchEvent(new CustomEvent(submenuOpened, { detail: undefined }))
          const next =
            key === 'Home'
              ? 0
              : key === 'End'
                ? items.length - 1
                : (index + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
        } else if (key === 'Escape' || (submenu && key === 'ArrowLeft')) {
          event.preventDefault()
          onClose()
        } else if (key === 'Tab') {
          if (submenu) window.dispatchEvent(new Event(menuOpened))
          restore.current = false
          onClose()
        }
      }}
    >
      <div className={styles.heading}>{label}</div>
      <fieldset disabled={pending} className={styles.controls}>
        {children}
      </fieldset>
    </div>,
    document.body,
  )
}

export function MenuSubmenu({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  const [at, setAt] = useState<MenuPosition>()
  const id = useId()
  useEffect(() => {
    const other = (event: Event) => {
      if (event instanceof CustomEvent && event.detail !== id) setAt(undefined)
    }
    window.addEventListener(submenuOpened, other)
    return () => window.removeEventListener(submenuOpened, other)
  }, [id])
  const trigger = useRef<HTMLButtonElement>(null)
  const open = () => {
    const button = trigger.current
    if (!button) return
    window.dispatchEvent(new CustomEvent(submenuOpened, { detail: id }))
    const box = button.getBoundingClientRect()
    setAt({ x: box.right, y: box.top, trigger: button })
  }
  return (
    <>
      <ActionButton
        ref={trigger}
        type="button"
        role="menuitem"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={at !== undefined}
        className={styles.item}
        onClick={open}
        onPointerEnter={open}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            event.stopPropagation()
            open()
          }
        }}
      >
        {label}
        <span className={styles.hint}>{hint} ›</span>
      </ActionButton>
      {at && (
        <ContextMenu at={at} label={label} submenu onClose={() => setAt(undefined)}>
          {children}
        </ContextMenu>
      )}
    </>
  )
}

export interface MenuAction {
  label: string
  hint?: string
  action?: (() => unknown | Promise<unknown>) | undefined
  disabled?: boolean
  danger?: boolean
  divider?: boolean
  items?: MenuAction[]
}

export function MenuItems({
  items,
  choose,
  pendingLabel,
}: {
  pendingLabel?: string | undefined
  items: MenuAction[]
  choose: (item: MenuAction) => unknown
}) {
  return items.map((item) => (
    <Fragment key={item.label}>
      {item.divider && <hr className={styles.separator} />}
      {menuItem(item, choose, pendingLabel)}
    </Fragment>
  ))
}

function menuItem(
  item: MenuAction,
  choose: (item: MenuAction) => unknown,
  pendingLabel: string | undefined,
) {
  return item.items ? (
    <MenuSubmenu key={item.label} label={item.label}>
      <MenuItems items={item.items} choose={choose} pendingLabel={pendingLabel} />
    </MenuSubmenu>
  ) : (
    <ActionButton
      key={item.label}
      type="button"
      role="menuitem"
      disabled={item.disabled || (pendingLabel !== undefined && pendingLabel !== item.label)}
      pending={pendingLabel === item.label}
      className={`${styles.item} ${item.danger ? styles.danger : ''}`}
      onClick={() => choose(item)}
    >
      {item.label}
      {item.hint !== undefined && <span className={styles.hint}>{item.hint}</span>}
    </ActionButton>
  )
}

export function useActionMenu(scope?: string) {
  const [opened, setMenu] = useState<{
    at: MenuPosition
    label: string
    items: MenuAction[]
    operationKey?: string | undefined
    scope: string | undefined
  }>()
  const menu = opened?.scope === scope ? opened : undefined
  if (opened && !menu) setMenu(undefined)
  const [error, setError] = useState<string>()
  const activity = usePendingAction(
    menu?.operationKey ?? (scope === undefined ? undefined : `menu:${scope}`),
  )
  const close = () => setMenu(undefined)
  return {
    isOpen: menu !== undefined,
    open: (at: MenuPosition, label: string, items: MenuAction[], operationKey?: string) => {
      setError(undefined)
      setMenu({ at, label, items, operationKey, scope })
    },
    close,
    menu: (
      <>
        {menu && (
          <ContextMenu at={menu.at} label={menu.label} onClose={close} pending={activity.pending}>
            <MenuItems
              items={menu.items}
              pendingLabel={activity.pending ? activity.label : undefined}
              choose={(item) => {
                setError(undefined)
                const result = activity.run(() => item.action?.(), item.label)
                if (result) {
                  return result.then(
                    () =>
                      setMenu((current) =>
                        (
                          menu.operationKey !== undefined
                            ? current?.operationKey === menu.operationKey
                            : current?.label === menu.label
                        )
                          ? undefined
                          : current,
                      ),
                    (failure: unknown) => setError(`${menu.label}: ${readableError(failure)}`),
                  )
                }
                close()
              }}
            />
          </ContextMenu>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
            <ActionButton type="button" onClick={() => setError(undefined)}>
              Dismiss
            </ActionButton>
          </p>
        )}
      </>
    ),
  }
}
