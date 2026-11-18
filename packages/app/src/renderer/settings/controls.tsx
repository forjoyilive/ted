import { type ReactNode, useId } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { Help } from '../components/Help.tsx'
import { Select as Dropdown } from '../components/Select.tsx'
import { usePendingAction } from '../pending-action.ts'
import { type SettingId, settingEntry } from '../settings-search.ts'
import styles from './settings.module.css'

export function SettingsPage({
  title,
  help,
  subtitle,
  actions,
  children,
}: {
  title: string
  help?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const titleRow = (
    <div className={styles.pageTitleRow}>
      <h1 className={styles.pageTitle}>{title}</h1>
      {help !== undefined && <Help>{help}</Help>}
      {actions !== undefined && <div className={styles.pageActions}>{actions}</div>}
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
  setting,
  label = setting && settingEntry(setting).name,
  help = setting && settingEntry(setting).help,
  action,
  children,
}: {
  setting?: SettingId
  label?: string | undefined
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
            <h2 className={styles.groupLabel} id={id} data-setting={setting}>
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
  setting,
  title = setting && settingEntry(setting).name,
  help = setting && settingEntry(setting).help,
  detail = setting && settingEntry(setting).detail,
  leading,
  labelFor,
  children,
}: ({ setting: SettingId; title?: ReactNode } | { setting?: undefined; title: ReactNode }) & {
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
    <div className={styles.row} data-setting={setting}>
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
    <ActionButton
      type="button"
      className={`${styles.button} ${primary ? styles.primary : ''} ${danger ? styles.danger : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </ActionButton>
  )
}

export function Stepper({
  value,
  min,
  max,
  lessLabel,
  moreLabel,
  onChange,
  step = 1,
  format = String,
}: {
  step?: number
  format?: (value: number) => string
  value: number
  min: number
  max: number
  lessLabel: string
  moreLabel: string
  onChange: (value: number) => unknown
}) {
  const activity = usePendingAction()
  return (
    <div className={styles.stepper}>
      <ActionButton
        type="button"
        className={styles.step}
        aria-label={lessLabel}
        disabled={activity.pending || value <= min}
        onClick={() => activity.run(() => onChange(Math.max(min, value - step)))}
      >
        −
      </ActionButton>
      <output className={styles.stepValue} aria-live="polite">
        {format(value)}
      </output>
      <ActionButton
        type="button"
        className={styles.step}
        aria-label={moreLabel}
        disabled={activity.pending || value >= max}
        onClick={() => activity.run(() => onChange(Math.min(max, value + step)))}
      >
        +
      </ActionButton>
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
    <ActionButton
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={styles.switch}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} />
    </ActionButton>
  )
}

export function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
  width,
  disabled,
}: {
  id: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  width?: number
  disabled?: boolean
}) {
  return (
    <Dropdown
      id={id}
      disabled={disabled}
      controlClassName={styles.select}
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
    </Dropdown>
  )
}

export function Segmented<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
  className,
  disabled = false,
}: {
  label: string
  name: string
  value: T | undefined
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  className?: string | undefined
  disabled?: boolean
}) {
  return (
    <div
      className={className === undefined ? styles.segmented : `${styles.segmented} ${className}`}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <label key={option.value} className={styles.segment}>
          <input
            type="radio"
            name={name}
            className={styles.radio}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  )
}
