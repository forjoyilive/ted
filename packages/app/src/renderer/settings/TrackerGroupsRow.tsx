import type { ReactNode } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { SettingRow } from './controls.tsx'
import styles from './tracker-groups.module.css'

export function TrackerGroupsRow({
  title,
  help,
  labelFor,
  allowed,
  declined,
  allowLabel,
  label = (group) => group,
  onAllow,
  forgetLabel,
  onForget,
  problem,
  children,
}: {
  title: string
  help: string
  labelFor?: string
  allowed: readonly string[]
  declined: readonly string[]
  allowLabel(group: string): string
  label?(group: string): string
  onAllow(group: string): unknown
  forgetLabel?(group: string): string
  onForget?(group: string): unknown
  problem?: string
  children: ReactNode
}) {
  const notNow = declined.filter((group) => !allowed.includes(group))
  return (
    <SettingRow
      title={title}
      {...(labelFor !== undefined && { labelFor })}
      help={help}
      detail={
        problem ??
        (notNow.length > 0 ? (
          <span className={styles.notNow}>
            You chose Not now for
            {notNow.map((group) => (
              <span key={group} className={styles.notNowGroup}>
                {label(group)}
                <ActionButton
                  type="button"
                  className={styles.allow}
                  aria-label={allowLabel(group)}
                  onClick={() => onAllow(group)}
                >
                  Allow
                </ActionButton>
                {onForget && (
                  <ActionButton
                    type="button"
                    className={styles.allow}
                    aria-label={forgetLabel?.(group) ?? `Remove ${label(group)}`}
                    onClick={() => onForget(group)}
                  >
                    Remove
                  </ActionButton>
                )}
              </span>
            ))}
          </span>
        ) : undefined)
      }
    >
      {children}
    </SettingRow>
  )
}
