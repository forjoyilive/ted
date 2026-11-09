import { type ButtonHTMLAttributes, type ReactNode, useContext, useRef } from 'react'
import { type ArmAction, ArmedContext } from '../armed.ts'
import styles from './Button.module.css'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
  size?: 'regular' | 'small'
  shortcut?: string
  arm?: ArmAction
  children: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'regular',
  shortcut,
  arm,
  className,
  children,
  ...props
}: ButtonProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const armed = useContext(ArmedContext)
  const isArmed = armed !== undefined && armed === ref.current
  return (
    <button
      ref={ref}
      type="button"
      className={[styles.button, styles[variant], styles[size], isArmed && styles.armed, className]
        .filter(Boolean)
        .join(' ')}
      data-arm={arm}
      data-primary={variant === 'primary' ? '' : undefined}
      {...props}
    >
      {children}
      {shortcut !== undefined && (
        <kbd className={styles.shortcut} aria-hidden>
          {shortcut}
        </kbd>
      )}
      {isArmed && <span className={styles.confirm}>↵ to confirm</span>}
    </button>
  )
}
