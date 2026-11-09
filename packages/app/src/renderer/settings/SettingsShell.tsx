import type { Factory, MachineSettings } from '@ted/protocol'
import { DotIcon } from '../components/icons.tsx'
import type { NavigationAction, SettingsSectionId } from '../navigation.ts'
import { NotBuiltYet, settingsSections } from './sections.tsx'
import styles from './settings.module.css'

interface SettingsShellProps {
  section: SettingsSectionId
  settings: MachineSettings | undefined
  factories: readonly Factory[]
  inboxCount: number
  stopsWork?: Partial<Record<SettingsSectionId, boolean>>
  dispatch: (action: NavigationAction) => void
}

export function SettingsShell({
  section,
  settings,
  factories,
  inboxCount,
  stopsWork = {},
  dispatch,
}: SettingsShellProps) {
  const current = settingsSections.find((s) => s.id === section) ?? settingsSections[0]

  return (
    <div className={styles.shell}>
      <nav className={styles.sidebar} aria-label="Settings">
        <button
          type="button"
          className={styles.back}
          title="Back (Esc)"
          onClick={() => dispatch({ type: 'close-settings' })}
        >
          <span>← Back</span>
          <span className={styles.spacer} />
          {inboxCount > 0 && (
            <span className={styles.inbox}>
              Inbox <span className={styles.inboxCount}>{inboxCount}</span>
            </span>
          )}
        </button>

        <h2 className={styles.sidebarHeading}>Settings</h2>
        {settingsSections.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={styles.sidebarRow}
            onClick={() => dispatch({ type: 'open-settings', section: id })}
            {...(id === current?.id && { 'aria-current': 'page' as const })}
          >
            <span className={styles.sidebarLabel}>{label}</span>
            {stopsWork[id] && <DotIcon className={styles.stopsWork} />}
          </button>
        ))}

        {factories.length > 0 && <h2 className={styles.sidebarHeading}>Factories</h2>}
        {factories.map((factory) => (
          <button
            key={factory.id}
            type="button"
            className={styles.sidebarRow}
            onClick={() =>
              dispatch({
                type: 'open',
                screen: { kind: 'factory', factoryId: factory.id, view: 'settings' },
              })
            }
          >
            <span className={styles.sidebarLabel}>{factory.name}</span>
            <span className={styles.leave} aria-hidden>
              ↗
            </span>
          </button>
        ))}
      </nav>
      <main className={styles.main} aria-label={current?.label}>
        {settings &&
          current &&
          (current.Page ? (
            <current.Page settings={settings} />
          ) : (
            <NotBuiltYet title={current.label} />
          ))}
      </main>
    </div>
  )
}
