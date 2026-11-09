import type { Banner } from '@ted/protocol'
import { useState } from 'react'
import { foldBanners } from '../banners.ts'
import styles from './BannerStack.module.css'
import { DotIcon } from './icons.tsx'

interface BannerStackProps {
  label: string
  banners: Banner[]
  onAction: (banner: Banner) => Promise<void> | void
  onDismiss: (banner: Banner) => void
}

export function BannerStack({ label, banners, onAction, onDismiss }: BannerStackProps) {
  const [expanded, setExpanded] = useState(false)
  if (banners.length === 0) return null
  const { shown, fold } = foldBanners(banners, expanded)

  return (
    <section className={styles.stack} aria-label={label}>
      {shown.map((banner) => (
        <BannerRow key={banner.id} banner={banner} onAction={onAction} onDismiss={onDismiss} />
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
}: { banner: Banner } & Pick<BannerStackProps, 'onAction' | 'onDismiss'>) {
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
      {banner.action && (
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
