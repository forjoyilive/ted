import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { sidebarResizeKey } from '../keymap.ts'
import {
  clampSidebar,
  fitSidebars,
  readSidebarWidths,
  type SidebarSide,
  type SidebarSpace,
  type SidebarWidths,
  saveSidebarWidths,
  sidebarDefaults,
  sidebarLimit,
  sidebarMaximums,
  sidebarMinimums,
} from '../sidebar-widths.ts'
import styles from './ResizableSidebar.module.css'

interface WidthContext {
  widths: SidebarWidths
  space: SidebarSpace
  change: (side: SidebarSide, width: number, save?: boolean) => void
  save: () => void
}

const labels = {
  navigation: 'Navigation sidebar width',
  list: 'List width',
  details: 'Details sidebar width',
} satisfies { [side in SidebarSide]: string }

const Widths = createContext<WidthContext | undefined>(undefined)
const keyTargets = new WeakMap<Element, (key: number | 'min' | 'max') => void>()

export function resizeSidebarFromKey(event: KeyboardEvent): boolean {
  const action = sidebarResizeKey(event)
  const target = event.target instanceof Element ? keyTargets.get(event.target) : undefined
  if (action === undefined || !target) return false
  event.preventDefault()
  target(action)
  return true
}

export function SidebarLayout({
  children,
  className,
}: {
  children: ReactNode
  className?: string | undefined
}) {
  const root = useRef<HTMLDivElement>(null)
  const [preferred, setPreferred] = useState(readSidebarWidths)
  const latest = useRef(preferred)
  const [space, setSpace] = useState<SidebarSpace>({
    width: 0,
    navigation: false,
    list: false,
    details: false,
  })
  const measure = useCallback(() => {
    const element = root.current
    if (!element) return
    const next = {
      width: element.getBoundingClientRect().width,
      navigation: element.querySelector('[data-sidebar="navigation"]') !== null,
      list: element.querySelector('[data-sidebar="list"]') !== null,
      details: element.querySelector('[data-sidebar="details"]') !== null,
    }
    setSpace((old) =>
      old.width === next.width &&
      old.navigation === next.navigation &&
      old.list === next.list &&
      old.details === next.details
        ? old
        : next,
    )
  }, [])
  useLayoutEffect(measure)
  useEffect(() => {
    const element = root.current
    if (!element) return
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    resize?.observe(element)
    const mutations = new MutationObserver(measure)
    mutations.observe(element, { childList: true, subtree: true })
    return () => {
      resize?.disconnect()
      mutations.disconnect()
    }
  }, [measure])
  const widths = space.width > 0 ? fitSidebars(preferred, space) : preferred
  const change = (side: SidebarSide, width: number, save = true) => {
    const next = { ...latest.current, [side]: clampSidebar(side, width) }
    latest.current = next
    setPreferred(next)
    if (save) saveSidebarWidths(next)
  }
  return (
    <Widths value={{ widths, space, change, save: () => saveSidebarWidths(latest.current) }}>
      <div ref={root} className={className}>
        {children}
      </div>
    </Widths>
  )
}

export function ResizableSidebar({ side, children }: { side: SidebarSide; children: ReactNode }) {
  const shared = useContext(Widths)
  const [localWidth, setLocalWidth] = useState(sidebarDefaults[side])
  const width = shared?.widths[side] ?? localWidth
  const max =
    shared && shared.space.width > 0
      ? sidebarLimit(side, shared.widths, shared.space)
      : sidebarMaximums[side]
  const direction = side === 'details' ? -1 : 1
  const ref = useRef<HTMLHRElement>(null)
  const drag = useRef<{ x: number; width: number; pointer: number; restore: () => void }>(null)
  const [dragging, setDragging] = useState(false)
  const change = (next: number, save = true) => {
    const fitted = Math.max(sidebarMinimums[side], Math.min(max, next))
    if (shared) shared.change(side, fitted, save)
    else setLocalWidth(fitted)
  }
  const finish = () => {
    const current = drag.current
    if (!current) return
    drag.current = null
    current.restore()
    if (ref.current?.hasPointerCapture(current.pointer)) {
      ref.current.releasePointerCapture(current.pointer)
    }
    shared?.save()
    setDragging(false)
  }
  useEffect(() => () => drag.current?.restore(), [])
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    keyTargets.set(element, (key) => {
      if (key === 'min') change(sidebarMinimums[side])
      else if (key === 'max') change(max)
      else change(width + key * direction)
    })
    return () => {
      keyTargets.delete(element)
    }
  })
  return (
    <div className={styles.sidebar} data-sidebar={side} style={{ width }}>
      {children}
      <hr
        ref={ref}
        className={`${styles.handle} ${styles[side]} ${dragging ? styles.dragging : ''}`}
        tabIndex={0}
        aria-label={labels[side]}
        aria-orientation="vertical"
        aria-valuemin={sidebarMinimums[side]}
        aria-valuemax={max}
        aria-valuenow={width}
        title="Drag to resize. Double-click to reset."
        onDoubleClick={() => {
          if (shared) shared.change(side, sidebarDefaults[side])
          else setLocalWidth(sidebarDefaults[side])
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          const { style } = document.body
          const cursor = style.cursor
          const userSelect = style.userSelect
          style.cursor = 'col-resize'
          style.userSelect = 'none'
          drag.current = {
            x: event.clientX,
            width,
            pointer: event.pointerId,
            restore: () => {
              style.cursor = cursor
              style.userSelect = userSelect
            },
          }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start || start.pointer !== event.pointerId) return
          change(start.width + (event.clientX - start.x) * direction, false)
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
    </div>
  )
}

export function DetailsPane({ hidden, ...props }: ComponentProps<'aside'>) {
  if (hidden) return null
  return (
    <ResizableSidebar side="details">
      <aside {...props} />
    </ResizableSidebar>
  )
}

export function ListPane(props: ComponentProps<'section'>) {
  return (
    <ResizableSidebar side="list">
      <section {...props} />
    </ResizableSidebar>
  )
}
