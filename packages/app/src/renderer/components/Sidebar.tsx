import type { Factory } from '@ted/protocol'
import type { FactoryView, Navigation, NavigationAction, Screen } from '../navigation.ts'
import { ChevronIcon, DotIcon, PlusIcon, SearchIcon, WarningIcon } from './icons.tsx'
import styles from './Sidebar.module.css'

export interface FactoryBadges {
  waiting?: number
  failed?: boolean
  stopsWork?: boolean
}

export interface SidebarFooter {
  runs?: string
  failed?: string
  paused?: string
  simulators?: string
  planChips?: readonly string[]
}

interface SidebarProps {
  navigation: Navigation
  factories: readonly Factory[]
  currentFactoryId: string | undefined
  inboxCount: number
  badges?: Readonly<Record<string, FactoryBadges>>
  settingsProblem?: boolean
  footer?: SidebarFooter
  runsOpen?: boolean
  onOpenRuns?: () => void
  onOpenFailed?: () => void
  onOpenPlanUsage?: () => void
  dispatch: (action: NavigationAction) => void
  onNewTask: () => void
  onAddFactory: () => void
}

const factoryViews: { view: FactoryView; label: string }[] = [
  { view: 'board', label: 'Board' },
  { view: 'list', label: 'List' },
  { view: 'plans', label: 'Plans' },
  { view: 'automations', label: 'Automations' },
  { view: 'settings', label: 'Settings' },
]

function sameScreen(a: Screen, b: Screen): boolean {
  if (a.kind === 'factory' && b.kind === 'factory') {
    return a.factoryId === b.factoryId && a.view === b.view
  }
  return a.kind === b.kind
}

export function Sidebar({
  navigation,
  factories,
  currentFactoryId,
  inboxCount,
  badges = {},
  settingsProblem = false,
  footer = {},
  runsOpen = false,
  onOpenRuns,
  onOpenFailed,
  onOpenPlanUsage,
  dispatch,
  onNewTask,
  onAddFactory,
}: SidebarProps) {
  const open = (screen: Screen) => dispatch({ type: 'open', screen })
  const current = (screen: Screen) =>
    sameScreen(navigation.screen, screen) ? { 'aria-current': 'page' as const } : {}
  const footerLines = Object.entries(footer).filter(
    ([, line]) => line !== undefined && (!Array.isArray(line) || line.length > 0),
  )

  return (
    <nav className={styles.sidebar} aria-label="Sidebar">
      <div className={styles.top}>
        <button type="button" className={styles.search} onClick={() => open({ kind: 'search' })}>
          <SearchIcon className={styles.searchIcon} />
          <span className={styles.searchLabel}>Search</span>
          <span className={styles.shortcut}>⌘K</span>
        </button>
        <button type="button" className={styles.newTask} aria-label="New Task" onClick={onNewTask}>
          <PlusIcon />
        </button>
      </div>

      <button
        type="button"
        className={`${styles.row} ${inboxCount > 0 ? styles.strong : ''}`}
        onClick={() => open({ kind: 'inbox' })}
        {...current({ kind: 'inbox' })}
      >
        <span className={styles.label}>Inbox</span>
        {inboxCount > 0 && <span className={styles.count}>{inboxCount}</span>}
      </button>
      <button
        type="button"
        className={styles.row}
        onClick={() => open({ kind: 'all-tasks' })}
        {...current({ kind: 'all-tasks' })}
      >
        <span className={styles.label}>All Tasks</span>
      </button>

      <h2 className={styles.section}>Factories</h2>
      {factories.map((factory) => {
        const expanded = factory.id === currentFactoryId
        const badge = badges[factory.id] ?? {}
        const waiting = badge.waiting ?? 0
        return (
          <div key={factory.id} className={styles.factory}>
            <div className={styles.factoryRow}>
              <button
                type="button"
                className={`${styles.row} ${expanded ? styles.strong : ''} ${waiting > 0 ? styles.counted : ''}`}
                aria-expanded={expanded}
                onClick={() => dispatch({ type: 'open-factory', factoryId: factory.id })}
              >
                <ChevronIcon open={expanded} className={styles.chevron} />
                <span className={styles.label}>{factory.name}</span>
                {badge.failed && <DotIcon className={styles.failedDot} />}
                {badge.stopsWork && (
                  <span role="img" aria-label="A problem stops work" className={styles.warning}>
                    <WarningIcon />
                  </span>
                )}
              </button>
              {waiting > 0 && (
                <button
                  type="button"
                  className={styles.countButton}
                  aria-label={`${waiting} waiting in ${factory.name}`}
                  title="Show in the Inbox"
                  onClick={() => open({ kind: 'inbox', factoryId: factory.id })}
                >
                  {waiting}
                </button>
              )}
            </div>
            {expanded &&
              factoryViews.map(({ view, label }) => {
                const screen: Screen = { kind: 'factory', factoryId: factory.id, view }
                return (
                  <button
                    key={view}
                    type="button"
                    className={`${styles.row} ${styles.sub}`}
                    onClick={() => open(screen)}
                    {...current(screen)}
                  >
                    <span className={styles.label}>{label}</span>
                  </button>
                )
              })}
          </div>
        )
      })}
      <button type="button" className={`${styles.row} ${styles.addFactory}`} onClick={onAddFactory}>
        <span className={styles.plus}>+</span>
        <span className={styles.label}>Add Factory</span>
      </button>

      <div className={styles.spacer} />

      <button
        type="button"
        className={`${styles.row} ${styles.appSettings}`}
        onClick={() => dispatch({ type: 'open-settings' })}
      >
        <span className={styles.label}>Settings</span>
        {settingsProblem && (
          <span role="img" aria-label="A problem stops work" className={styles.failedDot}>
            <DotIcon />
          </span>
        )}
        <span className={styles.shortcut}>⌘,</span>
      </button>

      {footerLines.length > 0 && (
        <footer className={styles.footer}>
          {footer.runs !== undefined &&
            (onOpenRuns ? (
              <button
                type="button"
                className={styles.runsButton}
                aria-haspopup="dialog"
                aria-expanded={runsOpen}
                onClick={onOpenRuns}
              >
                {footer.runs}
              </button>
            ) : (
              <p className={styles.runs}>{footer.runs}</p>
            ))}
          {footer.failed !== undefined &&
            (onOpenFailed ? (
              <button type="button" className={styles.failedButton} onClick={onOpenFailed}>
                {footer.failed}
              </button>
            ) : (
              <p className={styles.failed}>{footer.failed}</p>
            ))}
          {footer.paused !== undefined && <p className={styles.runs}>{footer.paused}</p>}
          {footer.simulators !== undefined && (
            <p className={styles.simulators}>{footer.simulators}</p>
          )}
          {footer.planChips?.map((chip) => (
            <button
              key={chip}
              type="button"
              className={styles.planChip}
              onClick={() =>
                onOpenPlanUsage
                  ? onOpenPlanUsage()
                  : dispatch({ type: 'open-settings', section: 'agents' })
              }
            >
              <DotIcon />
              {chip}
            </button>
          ))}
        </footer>
      )}
    </nav>
  )
}
