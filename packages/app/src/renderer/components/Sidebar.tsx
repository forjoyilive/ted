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
}

interface SidebarProps {
  navigation: Navigation
  factories: readonly Factory[]
  currentFactoryId: string | undefined
  inboxCount: number
  badges?: Readonly<Record<string, FactoryBadges>>
  footer?: SidebarFooter
  dispatch: (action: NavigationAction) => void
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
  footer = {},
  dispatch,
}: SidebarProps) {
  const open = (screen: Screen) => dispatch({ type: 'open', screen })
  const current = (screen: Screen) =>
    sameScreen(navigation.screen, screen) ? { 'aria-current': 'page' as const } : {}
  const footerLines = Object.entries(footer).filter(([, line]) => line !== undefined)

  return (
    <nav className={styles.sidebar} aria-label="Sidebar">
      <div className={styles.top}>
        <button type="button" className={styles.search} onClick={() => open({ kind: 'search' })}>
          <SearchIcon className={styles.searchIcon} />
          <span className={styles.searchLabel}>Search</span>
          <span className={styles.shortcut}>⌘K</span>
        </button>
        <button
          type="button"
          className={styles.newTask}
          aria-label="New Task"
          onClick={() => open({ kind: 'new-task' })}
        >
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
        return (
          <div key={factory.id} className={styles.factory}>
            <button
              type="button"
              className={`${styles.row} ${expanded ? styles.strong : ''}`}
              aria-expanded={expanded}
              onClick={() => dispatch({ type: 'open-factory', factoryId: factory.id })}
            >
              <ChevronIcon open={expanded} className={styles.chevron} />
              <span className={styles.label}>{factory.name}</span>
              {badge.failed && <DotIcon className={styles.failedDot} />}
              {badge.stopsWork && <WarningIcon className={styles.warning} />}
              {(badge.waiting ?? 0) > 0 && <span className={styles.count}>{badge.waiting}</span>}
            </button>
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
      <button
        type="button"
        className={`${styles.row} ${styles.addFactory}`}
        onClick={() => open({ kind: 'add-factory' })}
        {...current({ kind: 'add-factory' })}
      >
        <span className={styles.plus}>+</span>
        <span className={styles.label}>Add Factory</span>
      </button>

      <div className={styles.spacer} />

      <button
        type="button"
        className={`${styles.row} ${styles.appSettings}`}
        onClick={() => open({ kind: 'settings' })}
        {...current({ kind: 'settings' })}
      >
        <span className={styles.label}>Settings</span>
        <span className={styles.shortcut}>⌘,</span>
      </button>

      {footerLines.length > 0 && (
        <footer className={styles.footer}>
          {footer.runs !== undefined && <p className={styles.runs}>{footer.runs}</p>}
          {footer.failed !== undefined && <p className={styles.failed}>{footer.failed}</p>}
          {footer.paused !== undefined && <p className={styles.runs}>{footer.paused}</p>}
          {footer.simulators !== undefined && (
            <p className={styles.simulators}>{footer.simulators}</p>
          )}
        </footer>
      )}
    </nav>
  )
}
