import { type ReactNode, useId } from 'react'
import { Help } from '../components/Help.tsx'
import styles from './settings.module.css'

export function SettingsPage({
  title,
  help,
  subtitle,
  children,
}: {
  title: string
  help?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
}) {
  const titleRow = (
    <div className={styles.pageTitleRow}>
      <h1 className={styles.pageTitle}>{title}</h1>
      {help !== undefined && <Help>{help}</Help>}
    </div>
  )
  return (
    <div className={styles.page}>
      {subtitle === undefined ? (
        titleRow
      ) : (
        <div>
          {titleRow}
          <p className={styles.pageSubtitle}>{subtitle}</p>
        </div>
      )}
      {children}
    </div>
  )
}

export function SettingsGroup({
  label,
  help,
  action,
  children,
}: {
  label?: string
  help?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      className={styles.group}
      {...(label !== undefined && { 'aria-labelledby': id, role: 'group' })}
    >
      {label !== undefined && (
        <div className={styles.groupHeader}>
          <div className={styles.titleLine}>
            <h2 className={styles.groupLabel} id={id}>
              {label}
            </h2>
            {help !== undefined && <Help>{help}</Help>}
          </div>
          {action}
        </div>
      )}
      <div className={styles.box}>{children}</div>
    </section>
  )
}

export function SettingRow({
  title,
  help,
  detail,
  leading,
  labelFor,
  children,
}: {
  title: ReactNode
  help?: ReactNode
  detail?: ReactNode
  leading?: ReactNode
  labelFor?: string
  children?: ReactNode
}) {
  const label = labelFor ? (
    <label htmlFor={labelFor} className={styles.rowTitle}>
      {title}
    </label>
  ) : (
    <span className={styles.rowTitle}>{title}</span>
  )
  return (
    <div className={styles.row}>
      {leading}
      <div className={styles.rowText}>
        <div className={styles.titleLine}>
          {label}
          {help !== undefined && <Help>{help}</Help>}
        </div>
        {detail !== undefined && <div className={styles.rowDetail}>{detail}</div>}
      </div>
      {children !== undefined && <div className={styles.rowControls}>{children}</div>}
    </div>
  )
}

export function Button({
  children,
  onClick,
  primary,
  danger,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`${styles.button} ${primary ? styles.primary : ''} ${danger ? styles.danger : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function Stepper({
  value,
  min,
  max,
  lessLabel,
  moreLabel,
  onChange,
}: {
  value: number
  min: number
  max: number
  lessLabel: string
  moreLabel: string
  onChange: (value: number) => void
}) {
  return (
    <div className={styles.stepper}>
      <button
        type="button"
        className={styles.step}
        aria-label={lessLabel}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <output className={styles.stepValue} aria-live="polite">
        {value}
      </output>
      <button
        type="button"
        className={styles.step}
        aria-label={moreLabel}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  )
}

export function Switch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={styles.switch}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} />
    </button>
  )
}

export function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
  width,
}: {
  id: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  width?: number
}) {
  return (
    <select
      id={id}
      className={styles.select}
      style={width !== undefined ? { width } : undefined}
      value={String(value)}
      onChange={(event) => {
        const chosen = options.find((o) => String(o.value) === event.target.value)
        if (chosen) onChange(chosen.value)
      }}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string
  name: string
  value: T | undefined
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className={styles.segment}>
          <input
            type="radio"
            name={name}
            className={styles.radio}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  )
}
