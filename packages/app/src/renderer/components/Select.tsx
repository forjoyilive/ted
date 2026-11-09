import type { SelectHTMLAttributes } from 'react'
import { ChevronIcon } from './icons.tsx'
import styles from './Select.module.css'

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={[styles.wrap, className].filter(Boolean).join(' ')}>
      <select className={styles.select} {...props} />
      <ChevronIcon open className={styles.chevron} />
    </span>
  )
}
