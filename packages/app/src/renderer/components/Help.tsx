import { type ReactNode, useId, useState } from 'react'
import styles from './Help.module.css'

export function Tooltip({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span className={styles.tooltip} role="tooltip" id={id}>
      {children}
    </span>
  )
}

export function Help({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <span className={styles.anchor}>
      <button
        type="button"
        className={styles.help}
        aria-label="Help"
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
      >
        ?
      </button>
      {open && <Tooltip id={id}>{children}</Tooltip>}
    </span>
  )
}
