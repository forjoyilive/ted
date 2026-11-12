import type { SelectHTMLAttributes } from 'react'
import { ChevronIcon } from './icons.tsx'
import styles from './Select.module.css'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlClassName?: string | undefined
  fullWidth?: boolean | undefined
}

export function Select({ className, controlClassName, fullWidth, ...props }: SelectProps) {
  return (
    <span
      className={[styles.wrap, fullWidth && styles.fullWidth, className].filter(Boolean).join(' ')}
    >
      <select
        className={[styles.control, controlClassName ?? styles.select].filter(Boolean).join(' ')}
        {...props}
      />
      <ChevronIcon open className={styles.chevron} />
    </span>
  )
}
