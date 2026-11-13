import type { Task } from '@ted/protocol'
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { focusedTaskRef } from './key-targets.ts'
import { toggled } from './list-view.ts'

interface ActiveSelection {
  toggle: (ref: string) => boolean
  clear: () => boolean
}

let active: ActiveSelection | undefined
let target: string | undefined
let held = false
let pointer: { x: number; y: number } | undefined

export function selectionTarget(ref: string) {
  return {
    onPointerMove: (event: PointerEvent) => {
      // Chromium sends a pointer move with unchanged coordinates when a row scrolls under a still pointer.
      const still = held && pointer?.x === event.clientX && pointer.y === event.clientY
      pointer = { x: event.clientX, y: event.clientY }
      if (still) return
      held = false
      target = ref
    },
    onPointerLeave: () => {
      if (!held && target === ref) target = undefined
    },
    onFocus: () => {
      target = ref
      held = true
    },
  }
}

export function toggleTargetSelection(): boolean {
  const ref = target ?? focusedTaskRef()
  return ref !== undefined && (active?.toggle(ref) ?? false)
}

export function clearSelection(): boolean {
  return active?.clear() ?? false
}

export function useSelection(visible: readonly Task[], scope: string) {
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string>()
  const latest = useRef({ visible, count: 0 })
  latest.current = { visible, count: selected.length }

  useEffect(() => {
    void scope
    setSelected([])
    setAnchor(undefined)
  }, [scope])

  const toggle = useCallback((id: string) => {
    setSelected((current) => toggled(current, id))
    setAnchor(id)
  }, [])
  const clear = useCallback(() => setSelected([]), [])

  useEffect(() => {
    const mine: ActiveSelection = {
      toggle: (ref) => {
        const task = latest.current.visible.find((t) => t.displayId === ref)
        if (!task) return false
        toggle(task.id)
        return true
      },
      clear: () => {
        if (latest.current.count === 0) return false
        clear()
        return true
      },
    }
    active = mine
    return () => {
      if (active !== mine) return
      active = undefined
      target = undefined
      held = false
    }
  }, [toggle, clear])

  return { selected, setSelected, anchor, setAnchor, toggle, clear }
}
