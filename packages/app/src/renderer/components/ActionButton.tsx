import {
  type ButtonHTMLAttributes,
  type MouseEvent,
  type Ref,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { isPromise } from '../pending-action.ts'
import { readableError } from '../ted.ts'
import styles from './ActionButton.module.css'

export interface ActionButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  onClick?: ((event: MouseEvent<HTMLButtonElement>) => unknown) | undefined
  pending?: boolean | undefined
  buttonRef?: Ref<HTMLButtonElement> | undefined
  ref?: Ref<HTMLButtonElement> | undefined
}

export function ActionButton({
  onClick,
  type = 'button',
  pending = false,
  buttonRef,
  ref: forwardedRef,
  className,
  children,
  disabled,
  ...props
}: ActionButtonProps) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const [label, setLabel] = useState<string>()
  const active = useRef(false)
  const ref = useRef<HTMLButtonElement>(null)
  const statusId = useId()
  const busy = pending || working
  const resting = useRef(children)
  if (!busy) resting.current = children

  useLayoutEffect(() => {
    if (!busy || !ref.current) return
    const content = ref.current.cloneNode(true) as HTMLElement
    for (const hidden of content.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
    setLabel(props['aria-label'] ?? content.textContent?.trim() ?? props.title)
  }, [busy, props['aria-label'], props.title])

  function click(event: MouseEvent<HTMLButtonElement>) {
    if (
      active.current ||
      busy ||
      disabled ||
      props['aria-disabled'] === true ||
      props['aria-disabled'] === 'true'
    ) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const button = event.currentTarget
    const name = props['aria-label'] ?? button.textContent?.trim() ?? props.title
    active.current = true
    setError(undefined)
    try {
      const result = onClick?.(event)
      if (isPromise(result)) {
        setLabel(name)
        setWorking(true)
        Promise.resolve(result)
          .catch((failure: unknown) => setError(readableError(failure)))
          .finally(() => {
            active.current = false
            setWorking(false)
          })
      } else {
        active.current = false
      }
    } catch (failure) {
      active.current = false
      setError(readableError(failure))
    }
  }

  return (
    <>
      <button
        {...props}
        type={type}
        ref={(button) => {
          ref.current = button
          for (const target of [buttonRef, forwardedRef]) {
            if (typeof target === 'function') target(button)
            else if (target) target.current = button
          }
        }}
        disabled={disabled}
        className={[styles.button, className].filter(Boolean).join(' ')}
        data-pending={busy || undefined}
        aria-busy={busy || undefined}
        aria-disabled={busy || props['aria-disabled']}
        aria-label={props['aria-label'] ?? (busy ? label : undefined)}
        aria-describedby={
          [props['aria-describedby'], busy && statusId].filter(Boolean).join(' ') || undefined
        }
        onClick={click}
      >
        <span className={styles.content}>{busy ? resting.current : children}</span>
        {busy && <span className={styles.spinner} aria-hidden />}
      </button>
      {busy && (
        <span id={statusId} role="status" className={styles.status}>
          Working…
        </span>
      )}
      {error !== undefined && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
    </>
  )
}
