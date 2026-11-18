import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import styles from './Collapsible.module.css'

export function Collapsible({
  className,
  children,
}: {
  className: string | undefined
  children: ReactNode
}) {
  const content = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const element = content.current
    if (!element || expanded) return
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded])
  return (
    <div className={styles.collapsible}>
      <div
        ref={content}
        className={className === undefined ? styles.content : `${styles.content} ${className}`}
        data-collapsed={!expanded || undefined}
        data-overflows={overflows || undefined}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((shown) => !shown)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
