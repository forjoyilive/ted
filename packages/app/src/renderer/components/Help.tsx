import { type ReactNode, type Ref, useId, useState } from 'react'
import styles from './Help.module.css'

export function Tooltip({
  ref,
  id,
  className,
  children,
}: {
  ref?: Ref<HTMLSpanElement>
  id?: string
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <span ref={ref} className={`${styles.tooltip} ${className ?? ''}`} role="tooltip" id={id}>
      {children}
    </span>
  )
}

export function Help({ children, align }: { children: ReactNode; align?: 'end' }) {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <span className={styles.anchor}>
      <button
        type="button"
        className={styles.help}
        aria-label="Help"
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen(true)}
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
      {open && (
        <Tooltip id={id} className={align === 'end' ? styles.end : undefined}>
          {children}
        </Tooltip>
      )}
    </span>
  )
}
