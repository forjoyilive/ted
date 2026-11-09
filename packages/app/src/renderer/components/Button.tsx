import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
  size?: 'regular' | 'small'
  shortcut?: string
  children: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'regular',
  shortcut,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={[styles.button, styles[variant], styles[size], className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
      {shortcut !== undefined && (
        <kbd className={styles.shortcut} aria-hidden>
          {shortcut}
        </kbd>
      )}
    </button>
  )
}
