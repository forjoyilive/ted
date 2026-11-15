import type { Factory } from '@ted/protocol'
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { FactoryIcon } from './FactoryIcon.tsx'
import styles from './FactoryPicker.module.css'
import { ChevronIcon } from './icons.tsx'

export function nextFactoryIndex(
  names: readonly string[],
  active: number,
  key: string,
): number | undefined {
  const last = names.length - 1
  if (last < 0) return undefined
  if (key === 'ArrowDown') return Math.min(last, active + 1)
  if (key === 'ArrowUp') return Math.max(0, active - 1)
  if (key === 'Home') return 0
  if (key === 'End') return last
  if (Array.from(key).length !== 1 || key === ' ') return undefined
  const letter = key.toLocaleLowerCase()
  for (let step = 1; step <= names.length; step++) {
    const index = (active + step) % names.length
    if (names[index]?.toLocaleLowerCase().startsWith(letter)) return index
  }
  return undefined
}

export function FactoryPicker({
  factories,
  value,
  onChange,
  disabled = false,
  empty = 'No Factories yet',
  'aria-label': label = 'Factory',
}: {
  factories: readonly Factory[]
  value: string | undefined
  onChange: (id: string) => void
  disabled?: boolean | undefined
  empty?: string
  'aria-label'?: string
}) {
  const listId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const chosenIndex = factories.findIndex((f) => f.id === value)
  const chosen = factories[chosenIndex]
  const [active, setActive] = useState<number>()
  const open = active !== undefined && !disabled && factories.length > 0

  useLayoutEffect(() => {
    const anchor = button.current
    const popup = list.current
    if (!open || !anchor || !popup) return
    if (typeof popup.showPopover === 'function' && !popup.matches(':popover-open')) {
      popup.showPopover()
    }
    const place = () => {
      const box = anchor.getBoundingClientRect()
      popup.style.minWidth = `${box.width}px`
      const size = popup.getBoundingClientRect()
      const below = box.bottom + 6
      const top = below + size.height <= window.innerHeight - 8 ? below : box.top - 6 - size.height
      popup.style.top = `${Math.max(8, top)}px`
      popup.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - size.width - 8))}px`
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  useLayoutEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active, listId])

  function show() {
    setActive(Math.max(0, chosenIndex))
  }

  function choose(index: number) {
    setActive(undefined)
    const factory = factories[index]
    if (factory && factory.id !== value) onChange(factory.id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const key = event.key
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) {
        event.preventDefault()
        show()
      }
      return
    }
    if (key === 'Tab') {
      setActive(undefined)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (key === 'Escape') setActive(undefined)
    else if (key === 'Enter' || key === ' ') choose(active ?? 0)
    else {
      const next = nextFactoryIndex(
        factories.map((f) => f.name),
        active ?? 0,
        key,
      )
      if (next !== undefined) setActive(next)
    }
  }

  return (
    <span className={styles.picker}>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        data-value={value ?? ''}
        disabled={disabled || factories.length === 0}
        className={styles.button}
        onClick={() => (open ? setActive(undefined) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(undefined)}
      >
        {chosen ? (
          <>
            <FactoryIcon factory={chosen} size={16} />
            <span className={styles.name}>{chosen.name}</span>
          </>
        ) : (
          <span className={styles.name}>{empty}</span>
        )}
        <ChevronIcon open className={styles.chevron} />
      </button>
      {open && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label={label}
          popover="manual"
          className={styles.list}
          onPointerDown={(event) => event.preventDefault()}
        >
          {factories.map((f, index) => (
            <button
              type="button"
              tabIndex={-1}
              key={f.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={f.id === value}
              className={`${styles.option} ${index === active ? styles.active : ''}`}
              onPointerMove={() => {
                if (index !== active) setActive(index)
              }}
              onClick={() => choose(index)}
            >
              <FactoryIcon factory={f} size={16} />
              <span className={styles.optionName}>{f.name}</span>
              <svg
                className={styles.check}
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M2.5 6.5 5 9l4.5-6"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
