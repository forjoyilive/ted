import type { Banner } from '@ted/protocol'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { foldBanners } from '../banners.ts'
import styles from './BannerStack.module.css'
import { DotIcon } from './icons.tsx'

export interface BannerMenuItem {
  label: string
  onSelect: () => Promise<void> | void
}

interface BannerStackProps {
  label: string
  banners: Banner[]
  onAction: (banner: Banner) => Promise<void> | void
  onDismiss: (banner: Banner) => void
  menu?: (banner: Banner) => BannerMenuItem[] | undefined
}

export function BannerStack({ label, banners, onAction, onDismiss, menu }: BannerStackProps) {
  const [expanded, setExpanded] = useState(false)
  if (banners.length === 0) return null
  const { shown, fold } = foldBanners(banners, expanded)

  return (
    <section className={styles.stack} aria-label={label}>
      {shown.map((banner) => (
        <BannerRow
          key={banner.id}
          banner={banner}
          onAction={onAction}
          onDismiss={onDismiss}
          items={menu?.(banner)}
        />
      ))}
      {fold && (
        <button
          type="button"
          className={styles.fold}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span className={styles.foldLabel}>{fold.label}</span>
          {fold.detail !== undefined && <span className={styles.foldDetail}>· {fold.detail}</span>}
          <span className={styles.foldToggle}>{expanded ? 'Show fewer ▴' : 'Show all ▾'}</span>
        </button>
      )}
    </section>
  )
}

function BannerRow({
  banner,
  onAction,
  onDismiss,
  items,
}: { banner: Banner; items: BannerMenuItem[] | undefined } & Pick<
  BannerStackProps,
  'onAction' | 'onDismiss'
>) {
  const [busy, setBusy] = useState(false)
  const stopsWork = banner.severity === 'stops-work'

  async function act() {
    setBusy(true)
    try {
      await onAction(banner)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`${styles.banner} ${stopsWork ? styles.stopsWork : styles.warning}`}
      role={stopsWork ? 'alert' : 'status'}
    >
      <DotIcon className={styles.dot} />
      <span className={styles.text}>{banner.text}</span>
      {banner.action && items && <MenuButton label={banner.action.label} items={items} />}
      {banner.action && !items && (
        <button type="button" className={styles.action} disabled={busy} onClick={act}>
          {banner.action.label}
        </button>
      )}
      {!stopsWork && (
        <button
          type="button"
          className={styles.dismiss}
          aria-label="Dismiss for 24 hours"
          title="Hide for 24 hours"
          onClick={() => onDismiss(banner)}
        >
          ×
        </button>
      )}
    </div>
  )
}

function MenuButton({ label, items }: { label: string; items: BannerMenuItem[] }) {
  const [position, setPosition] = useState<CSSProperties>()
  const [busy, setBusy] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!position) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      const target = event.target as Node
      if (
        event.type === 'mousedown' &&
        (menu.current?.contains(target) || button.current?.contains(target))
      )
        return
      setPosition(undefined)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    menu.current?.querySelector('button')?.focus()
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [position])

  function toggle() {
    const rect = button.current?.getBoundingClientRect()
    if (position || !rect) return setPosition(undefined)
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
  }

  async function select(item: BannerMenuItem) {
    setPosition(undefined)
    setBusy(true)
    try {
      await item.onSelect()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.action}
        aria-haspopup="menu"
        aria-expanded={position !== undefined}
        disabled={busy}
        onClick={toggle}
      >
        {label}
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>
      {position && (
        <div ref={menu} role="menu" className={styles.menu} style={position}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => void select(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
