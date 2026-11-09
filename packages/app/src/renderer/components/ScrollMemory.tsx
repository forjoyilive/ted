import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './Button.tsx'
import styles from './ScrollMemory.module.css'

interface Spot {
  top: number
  atBottom: boolean
}

const spots = new Map<string, Spot>()
const slack = 40

function scrollTo(element: HTMLElement, top: number): number | undefined {
  element.scrollTop = top
  return Math.abs(element.scrollTop - top) < 1 ? undefined : top
}

export function ScrollMemory({
  spot,
  count,
  grows,
  active = true,
  list = false,
  className,
  children,
}: {
  spot: string
  count: number
  grows?: unknown
  active?: boolean
  list?: boolean
  className?: string | undefined
  children: ReactNode
}) {
  const scroller = useRef<HTMLElement>(null)
  const atBottom = useRef(true)
  const restoring = useRef<number | undefined>(undefined)
  const counted = useRef(count)
  counted.current = count
  const seen = useRef(count)
  const [newBelow, setNewBelow] = useState(false)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!active || !element) return
    const saved = spots.get(spot)
    seen.current = counted.current
    setNewBelow(false)
    atBottom.current = saved?.atBottom ?? true
    restoring.current = undefined
    if (atBottom.current) element.scrollTop = element.scrollHeight
    else if (saved) restoring.current = scrollTo(element, saved.top)
  }, [spot, active])

  useLayoutEffect(() => {
    void grows
    const element = scroller.current
    if (!active || !element) return
    const added = count > seen.current
    seen.current = count
    if (restoring.current !== undefined) restoring.current = scrollTo(element, restoring.current)
    else if (atBottom.current) element.scrollTop = element.scrollHeight
    else if (added) setNewBelow(true)
  }, [count, grows, active])

  const onScroll = () => {
    const element = scroller.current
    if (!active || !element || restoring.current !== undefined) return
    if (element.scrollHeight <= element.clientHeight) return
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight
    atBottom.current = gap < slack
    spots.set(spot, { top: element.scrollTop, atBottom: atBottom.current })
    if (atBottom.current) setNewBelow(false)
  }

  const jump = () => {
    const element = scroller.current
    if (!element) return
    restoring.current = undefined
    atBottom.current = true
    element.scrollTop = element.scrollHeight
    setNewBelow(false)
  }

  const userScrolls = () => {
    restoring.current = undefined
  }

  const props = {
    className,
    onScroll,
    onWheel: userScrolls,
    onPointerDown: userScrolls,
    onKeyDown: userScrolls,
    'data-scroller': '',
  }
  const jumpRow = newBelow && (
    <Button size="small" className={styles.jump} onClick={jump}>
      New messages ↓
    </Button>
  )
  return list ? (
    <ol ref={scroller as RefObject<HTMLOListElement>} {...props}>
      {children}
      {jumpRow && <li className={styles.jumpRow}>{jumpRow}</li>}
    </ol>
  ) : (
    <div ref={scroller as RefObject<HTMLDivElement>} {...props}>
      {children}
      {jumpRow && <div className={styles.jumpRow}>{jumpRow}</div>}
    </div>
  )
}
