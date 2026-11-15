import { type ReactNode, type Ref, useId, useLayoutEffect, useRef, useState } from 'react'
import { besideAnchor } from '../menu-tooltip.ts'
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
  const button = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const anchor = button.current
    const bubble = tip.current
    if (!open || !anchor || !bubble) return
    if (typeof bubble.showPopover === 'function') {
      bubble.popover = 'manual'
      bubble.showPopover()
    }
    const place = () => {
      const { left, top } = besideAnchor(
        anchor.getBoundingClientRect(),
        bubble.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        align ?? 'start',
      )
      bubble.style.left = `${left}px`
      bubble.style.top = `${top}px`
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, align])

  return (
    <span className={styles.anchor}>
      <button
        ref={button}
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
        <Tooltip ref={tip} id={id} className={styles.floating}>
          {children}
        </Tooltip>
      )}
    </span>
  )
}
