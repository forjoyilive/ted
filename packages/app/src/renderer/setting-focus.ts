import { type RefObject, useEffect } from 'react'
import type { NavigationAction } from './navigation.ts'
import { parentSetting, type SettingHit, type SettingId } from './settings-search.ts'

const giveUpMs = 4000

let wanted: { id: SettingId; at: number } | undefined
const lookers = new Set<() => void>()

export function openSetting(hit: SettingHit, dispatch: (action: NavigationAction) => void): void {
  wanted = { id: hit.id, at: Date.now() }
  if (hit.target.kind === 'app') dispatch({ type: 'open-settings', section: hit.target.section })
  else {
    dispatch({
      type: 'open',
      screen: {
        kind: 'factory',
        factoryId: hit.target.factoryId,
        view: 'settings',
        section: hit.target.section,
      },
    })
  }
  for (const look of lookers) look()
}

function mark(root: HTMLElement, element: HTMLElement) {
  for (const old of root.querySelectorAll('[data-found]')) old.removeAttribute('data-found')
  element.scrollIntoView({ block: 'center' })
  void element.offsetWidth
  const padded = Number.parseFloat(getComputedStyle(element).paddingLeft) >= 8
  element.setAttribute('data-found', padded ? 'inside' : 'around')
}

export function useShownSetting(scope: RefObject<HTMLElement | null>, kind: 'app' | 'factory') {
  useEffect(() => {
    let observer: MutationObserver | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      observer?.disconnect()
      observer = undefined
      clearTimeout(timer)
    }
    const look = () => {
      stop()
      const root = scope.current
      if (!root || !wanted?.id.startsWith(`${kind}.`)) return
      const { id, at } = wanted
      const left = at + giveUpMs - Date.now()
      if (left <= 0) return
      const find = (setting: string | undefined) =>
        setting === undefined
          ? null
          : root.querySelector<HTMLElement>(`[data-setting="${setting}"]`)
      const show = (element: HTMLElement | null) => {
        if (!element) return false
        stop()
        if (wanted?.id === id) wanted = undefined
        mark(root, element)
        return true
      }
      if (show(find(id))) return
      observer = new MutationObserver(() => show(find(id)))
      observer.observe(root, { childList: true, subtree: true })
      timer = setTimeout(() => {
        if (!show(find(id) ?? find(parentSetting(id)))) stop()
      }, left)
    }
    lookers.add(look)
    look()
    return () => {
      lookers.delete(look)
      stop()
    }
  }, [scope, kind])
}
