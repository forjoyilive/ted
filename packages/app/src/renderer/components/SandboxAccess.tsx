import { type SandboxAccessChange, sandboxAccessChangeText } from '@ted/protocol/sandbox-access'
import { type SandboxGroup, sandboxGroups } from '@ted/protocol/sandbox-groups'
import type { ReactNode } from 'react'
import { ActionButton } from './ActionButton.tsx'
import { Button } from './Button.tsx'
import { buttonPosition, useActionMenu } from './ContextMenu.tsx'
import styles from './SandboxAccess.module.css'

export function AccessChips({ groups }: { groups: readonly SandboxGroup[] | undefined }) {
  if (!groups || groups.length === 0) return null
  return (
    <span className={styles.chips}>
      {groups.map((group) => (
        <span key={group} className={styles.chip} title={groupLabel(group)}>
          {group}
        </span>
      ))}
    </span>
  )
}

export function SandboxAccessField({
  label,
  groups,
  onChange,
}: {
  label: string
  groups: readonly SandboxGroup[] | undefined
  onChange: (groups: SandboxGroup[]) => void
}) {
  const current = groups ?? []
  const left = sandboxGroups.filter((g) => !current.includes(g.name))
  const actions = useActionMenu(`sandbox-access:${label}`)
  return (
    <fieldset className={styles.field} aria-label={`Sandbox access for ${label}`}>
      {actions.menu}
      {current.length === 0 && <span className={styles.none}>None</span>}
      {current.map((group) => (
        <span key={group} className={styles.chip} title={groupLabel(group)}>
          {group}
          <ActionButton
            type="button"
            className={styles.remove}
            aria-label={`Remove ${group}`}
            onClick={() => onChange(current.filter((g) => g !== group))}
          >
            ×
          </ActionButton>
        </span>
      ))}
      {left.length > 0 && (
        <Button
          size="small"
          onClick={(event) =>
            actions.open(
              buttonPosition(event.currentTarget),
              'Add sandbox access',
              left.map((g) => ({
                label: g.name,
                hint: g.label,
                action: () => onChange([...current, g.name]),
              })),
            )
          }
        >
          Add group…
        </Button>
      )}
    </fieldset>
  )
}

export const sandboxAccessHelp =
  'Named groups of extra access Ted’s sandbox gives this command. ios-xcode lets Xcode, SwiftPM, actool and ibtool write in shared folders on your Mac that your other apps also use. Takes effect once the change merges.'

function groupLabel(group: SandboxGroup): string {
  return sandboxGroups.find((g) => g.name === group)?.label ?? group
}

export function AccessChanges({
  title,
  changes,
}: {
  title: ReactNode
  changes: readonly SandboxAccessChange[]
}) {
  if (changes.length === 0) return null
  const groups = [...new Set(changes.flatMap((c) => c.gained))]
  return (
    <section className={styles.changes} aria-label="Sandbox access changes">
      <p className={styles.changesTitle}>{title}</p>
      <ul className={styles.changeList}>
        {changes.map((change) => {
          const text = sandboxAccessChangeText(change)
          return <li key={text}>{text}</li>
        })}
      </ul>
      {groups.includes('ios-xcode') && (
        <p className={styles.changesNote}>
          ios-xcode is shared access on your Mac: Xcode builds can write in folders your other apps
          also use.
        </p>
      )}
    </section>
  )
}

export function AccessUnknown() {
  return (
    <section className={styles.changes} aria-label="Sandbox access changes">
      <p className={styles.changesTitle}>
        Ted couldn’t compare sandbox access in .ted/workflow.yaml. Check the file’s changes.
      </p>
    </section>
  )
}
