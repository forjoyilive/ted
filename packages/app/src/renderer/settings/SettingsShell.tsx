import type { Factory, MachineSettings } from '@ted/protocol'
import { type ReactNode, useRef } from 'react'
import { DotIcon } from '../components/icons.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { ResizableSidebar } from '../components/ResizableSidebar.tsx'
import { SettingsSearch } from '../components/SettingsSearch.tsx'
import type { NavigationAction, SettingsSectionId } from '../navigation.ts'
import { useShownSetting } from '../setting-focus.ts'
import { SettingsPage } from './controls.tsx'
import { NotBuiltYet, settingsSections } from './sections.tsx'
import styles from './settings.module.css'

interface SettingsShellProps {
  section: SettingsSectionId
  settings: MachineSettings | undefined
  error?: string | undefined
  retry?: (() => void) | undefined
  factories: readonly Factory[]
  searchFactory?: Factory | undefined
  inboxCount: number
  stopsWork?: Partial<Record<SettingsSectionId, boolean>>
  counts?: Partial<Record<SettingsSectionId, number>>
  guide?: ReactNode
  dispatch: (action: NavigationAction) => void
}

export function SettingsShell({
  section,
  settings,
  error,
  retry,
  factories,
  searchFactory,
  inboxCount,
  stopsWork = {},
  counts = {},
  guide,
  dispatch,
}: SettingsShellProps) {
  const current = settingsSections.find((s) => s.id === section) ?? settingsSections[0]
  const main = useRef<HTMLElement>(null)
  useShownSetting(main, 'app')

  return (
    <div className={styles.shell}>
      <ResizableSidebar side="navigation">
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

          <SettingsSearch
            factory={searchFactory}
            dispatch={dispatch}
            onLeave={() => dispatch({ type: 'close-settings' })}
          >
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
                {(counts[id] ?? 0) > 0 && <span className={styles.sidebarCount}>{counts[id]}</span>}
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
          </SettingsSearch>
          {guide && <div className={styles.guide}>{guide}</div>}
        </nav>
      </ResizableSidebar>
      <main ref={main} className={styles.main} aria-label={current?.label}>
        {!settings && (
          <SettingsPage title={current?.label ?? 'Settings'}>
            {error && retry ? (
              <LoadingError error={error} retry={retry} />
            ) : (
              <Skeleton shape="settings" label="Loading settings…" />
            )}
          </SettingsPage>
        )}
        {settings &&
          current &&
          (current.Page ? (
            <current.Page settings={settings} dispatch={dispatch} />
          ) : (
            <NotBuiltYet title={current.label} />
          ))}
      </main>
    </div>
  )
}
