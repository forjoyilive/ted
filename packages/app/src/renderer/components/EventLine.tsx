import type { ThreadEventTone } from '@ted/protocol'
import type { ReactNode } from 'react'
import { ago, useNow } from '../requests.ts'
import styles from './EventLine.module.css'

export function EventLine({
  tone,
  text,
  at,
  action,
  children,
}: {
  tone: ThreadEventTone
  text: string
  at: string
  action?: ReactNode
  children?: ReactNode
}) {
  const now = useNow()
  return (
    <li className={styles.line} data-tone={tone}>
      <span className={`${styles.dot} ${styles[tone]}`} aria-hidden />
      <div className={styles.body}>
        <div className={styles.row}>
          <span className={styles.text}>
            {text}
            {action ? <> · {action}</> : null}
          </span>
          <time className={styles.time} dateTime={at}>
            {ago(at, now)}
          </time>
        </div>
        {children}
      </div>
    </li>
  )
}

export function Findings({ text }: { text: string }) {
  return (
    <section className={styles.findings} aria-label="Findings">
      <h3 className={styles.findingsHeading}>Findings</h3>
      <p className={styles.findingsText}>{text}</p>
    </section>
  )
}
