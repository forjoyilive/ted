import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type SelectHTMLAttributes,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { ChevronIcon } from './icons.tsx'
import { type ListOption, listPlacement, nextOptionIndex, startIndex } from './option-list.ts'
import styles from './Select.module.css'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlClassName?: string | undefined
  fullWidth?: boolean | undefined
}

export function Select({ className, controlClassName, fullWidth, ...props }: SelectProps) {
  const { control, list } = useOptionList(props)
  return (
    <span
      className={[styles.wrap, fullWidth && styles.fullWidth, className].filter(Boolean).join(' ')}
    >
      <select
        className={[styles.control, controlClassName ?? styles.select].filter(Boolean).join(' ')}
        {...props}
        {...control}
      />
      <ChevronIcon open className={styles.chevron} />
      {list}
    </span>
  )
}

interface Shown {
  label: string
  options: (ListOption & { value: string })[]
  chosen: number
  active: number
}

type Handlers = Pick<
  SelectHTMLAttributes<HTMLSelectElement>,
  'onMouseDown' | 'onKeyDown' | 'onBlur'
>

const openingKeys = ['ArrowDown', 'ArrowUp', 'Enter', ' ']

export function useOptionList(handlers: Handlers = {}) {
  const listId = useId()
  const select = useRef<HTMLSelectElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState<Shown>()
  const open = shown !== undefined

  useLayoutEffect(() => {
    const anchor = select.current
    const list = popup.current
    if (!open || !anchor || !list) return
    if ('showPopover' in list && !list.matches(':popover-open')) {
      list.popover = 'manual'
      list.showPopover()
    }
    const box = anchor.getBoundingClientRect()
    list.style.minWidth = `${box.width}px`
    list.style.maxHeight = 'none'
    const size = list.getBoundingClientRect()
    const place = listPlacement(box, size, { width: window.innerWidth, height: window.innerHeight })
    list.style.top = `${place.top}px`
    list.style.left = `${place.left}px`
    list.style.maxHeight = `${place.maxHeight}px`
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
    const hide = () => setShown(undefined)
    const outside = (event: Event) => {
      if (event.target instanceof Node && (list.contains(event.target) || anchor === event.target))
        return
      hide()
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', outside, true)
    window.addEventListener('resize', hide)
    anchor.addEventListener('change', hide)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', hide)
      anchor.removeEventListener('change', hide)
    }
  }, [open])

  const active = shown?.active
  useLayoutEffect(() => {
    if (active !== undefined)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, listId])

  function show() {
    const element = select.current
    if (!element || element.disabled) return
    const options = [...element.options].map((option) => ({
      value: option.value,
      label: option.label,
      disabled: option.disabled,
    }))
    const label =
      element.getAttribute('aria-label') ?? element.labels?.[0]?.textContent ?? undefined
    setShown({
      label: label ?? '',
      options,
      chosen: element.selectedIndex,
      active: startIndex(options, element.selectedIndex),
    })
  }

  function choose(index: number) {
    const element = select.current
    setShown(undefined)
    if (!element || shown?.options[index]?.disabled || element.selectedIndex === index) return
    element.selectedIndex = index
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function onMouseDown(event: MouseEvent<HTMLSelectElement>) {
    handlers.onMouseDown?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey) return
    event.preventDefault()
    event.currentTarget.focus()
    if (shown) setShown(undefined)
    else show()
  }

  function onKeyDown(event: KeyboardEvent<HTMLSelectElement>) {
    handlers.onKeyDown?.(event)
    const key = event.key
    if (event.defaultPrevented || event.metaKey || event.ctrlKey) return
    if (!shown) {
      if (!openingKeys.includes(key)) return
      event.preventDefault()
      event.stopPropagation()
      show()
      return
    }
    if (key === 'Tab') {
      setShown(undefined)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (key === 'Escape') setShown(undefined)
    else if (key === 'Enter' || key === ' ') choose(shown.active)
    else {
      const next = nextOptionIndex(shown.options, shown.active, key)
      if (next !== undefined) setShown({ ...shown, active: next })
    }
  }

  const list = shown && (
    <div
      ref={popup}
      id={listId}
      role="listbox"
      aria-label={shown.label}
      className={styles.list}
      onMouseDown={(event) => event.preventDefault()}
    >
      {shown.options.map((option, index) => (
        <button
          type="button"
          tabIndex={-1}
          key={option.value}
          id={`${listId}-${index}`}
          role="option"
          aria-selected={index === shown.chosen}
          disabled={option.disabled}
          className={[styles.option, index === shown.active && styles.active]
            .filter(Boolean)
            .join(' ')}
          onPointerMove={() => {
            if (!option.disabled && index !== shown.active) setShown({ ...shown, active: index })
          }}
          onClick={() => choose(index)}
        >
          <span className={styles.optionLabel}>{option.label}</span>
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
  )

  return {
    control: {
      ref: select,
      onMouseDown,
      onKeyDown,
      onBlur: (event: FocusEvent<HTMLSelectElement>) => {
        handlers.onBlur?.(event)
        setShown(undefined)
      },
      'aria-expanded': open,
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open ? `${listId}-${shown.active}` : undefined,
    },
    list,
  }
}
