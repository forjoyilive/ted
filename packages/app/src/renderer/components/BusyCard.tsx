import type { BusyHold } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { busyMeters, busyReason, checkedAgo, percent, waitedFor } from '../slots.ts'
import styles from './BusyCard.module.css'

export function BusyCard({
  id,
  busy,
  at,
}: {
  id: string
  busy: BusyHold
  at: { left: number; bottom: number }
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div id={id} role="tooltip" className={styles.card} style={at}>
      <h3 className={styles.title}>New work waits</h3>
      <p className={styles.lede}>{busyReason(busy)} Running work keeps going.</p>
      {busyMeters(busy).map((meter) => (
        <div key={meter.name} className={styles.meter} data-meter={meter.name}>
          <div className={styles.top}>
            <span className={styles.name}>{meter.name}</span>
            <span className={`${styles.value} ${meter.zone === 'fine' ? '' : styles[meter.zone]}`}>
              {meter.inUse === undefined ? 'Unknown' : `${percent(meter.inUse)} in use`}
            </span>
          </div>
          <div className={styles.bar}>
            <div
              className={`${styles.fill} ${styles[`${meter.zone}Fill`]}`}
              style={{ width: `${Math.min(100, Math.round((meter.inUse ?? 0) * 100))}%` }}
            />
            <div className={styles.hold} style={{ left: `${meter.holdAbove * 100}%` }} />
            <div className={styles.resume} style={{ left: `${meter.resumeBelow * 100}%` }} />
          </div>
          <div className={styles.rule}>{meter.rule}</div>
        </div>
      ))}
      <div className={styles.footer}>
        <span>Waiting {waitedFor(busy.since, now)}</span>
        <span>Checked {checkedAgo(busy.checkedAt, now)}</span>
      </div>
    </div>
  )
}
