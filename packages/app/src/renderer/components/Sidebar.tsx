import type { Factory } from '@ted/protocol'
import { useEffect, useRef, useState } from 'react'
import type { FactoryView, Navigation, NavigationAction, Screen } from '../navigation.ts'
import { readableError, ted } from '../ted.ts'
import { FactoryMenu } from './FactoryMenu.tsx'
import { ChevronIcon, DotIcon, PlusIcon, SearchIcon, WarningIcon } from './icons.tsx'
import styles from './Sidebar.module.css'

export interface FactoryBadges {
  waiting?: number
  failed?: boolean
  stopsWork?: boolean
  automationFailed?: boolean
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
  onNewTask: (factoryId?: string) => void
  onSearch: () => void
  onAddFactory: () => void
  onRemoveFactory?: (factory: Factory) => void
}

export function moveFactory(
  factories: readonly Factory[],
  from: number,
  to: number,
): string[] | undefined {
  if (from === to || from < 0 || to < 0 || from >= factories.length || to >= factories.length) {
    return undefined
  }
  const ids = factories.map((f) => f.id)
  const [moved] = ids.splice(from, 1)
  if (moved === undefined) return undefined
  ids.splice(to, 0, moved)
  return ids
}

function RenameRow({ factory, onDone }: { factory: Factory; onDone: () => void }) {
  const [name, setName] = useState(factory.name)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  async function save() {
    const trimmed = name.trim()
    if (trimmed === factory.name) return onDone()
    if (saving) return
    setSaving(true)
    try {
      await ted.renameFactory(factory.id, trimmed)
      onDone()
    } catch (failure) {
      setError(readableError(failure))
      setSaving(false)
    }
  }
  return (
    <div className={styles.rename}>
      <input
        className={styles.renameInput}
        aria-label={`Rename ${factory.name}`}
        value={name}
        maxLength={60}
        ref={field}
        onChange={(event) => {
          setName(event.target.value)
          setError(undefined)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void save()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onDone()
          }
        }}
        onBlur={() => {
          if (!saving) onDone()
        }}
      />
      <span className={error === undefined ? styles.renameHint : styles.renameError}>
        {error ?? 'Enter saves · Esc cancels'}
      </span>
    </div>
  )
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
  onSearch,
  onAddFactory,
  onRemoveFactory,
}: SidebarProps) {
  const [menu, setMenu] = useState<{ factoryId: string; x: number; y: number }>()
  const [renaming, setRenaming] = useState<string>()
  const [dragging, setDragging] = useState<number>()
  const [dropAt, setDropAt] = useState<number>()
  const [orderError, setOrderError] = useState<string>()
  const reorder = (ids: string[] | undefined) => {
    if (!ids) return
    setOrderError(undefined)
    ted.reorderFactories(ids).catch((failure: unknown) => setOrderError(readableError(failure)))
  }
  const menuFactory = menu && factories.find((f) => f.id === menu.factoryId)
  const menuIndex = menuFactory ? factories.indexOf(menuFactory) : -1
  const open = (screen: Screen) => dispatch({ type: 'open', screen })
  const current = (screen: Screen) =>
    sameScreen(navigation.screen, screen) ? { 'aria-current': 'page' as const } : {}
  const footerLines = Object.entries(footer).filter(
    ([, line]) => line !== undefined && (!Array.isArray(line) || line.length > 0),
  )

  return (
    <nav className={styles.sidebar} aria-label="Sidebar">
      <div className={styles.top}>
        <button type="button" className={styles.search} onClick={onSearch}>
          <SearchIcon className={styles.searchIcon} />
          <span className={styles.searchLabel}>Search</span>
          <span className={styles.shortcut}>⌘K</span>
        </button>
        <button
          type="button"
          className={styles.newTask}
          aria-label="New Task"
          onClick={() => onNewTask()}
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
      {factories.map((factory, index) => {
        const expanded = factory.id === currentFactoryId
        const badge = badges[factory.id] ?? {}
        const waiting = badge.waiting ?? 0
        const openMenu = (x: number, y: number) => setMenu({ factoryId: factory.id, x, y })
        const dropClass =
          dropAt === index && dragging !== undefined && dragging !== index
            ? dragging < index
              ? styles.dropBelow
              : styles.dropAbove
            : ''
        return (
          <div
            key={factory.id}
            className={`${styles.factory} ${dragging === index ? styles.dragging : ''}`}
          >
            {renaming === factory.id ? (
              <RenameRow factory={factory} onDone={() => setRenaming(undefined)} />
            ) : (
              <article
                aria-label={factory.name}
                className={`${styles.factoryRow} ${dropClass}`}
                draggable
                onDragOver={(event) => {
                  if (dragging === undefined) return
                  event.preventDefault()
                  setDropAt(index)
                }}
                onDrop={(event) => {
                  if (dragging === undefined) return
                  event.preventDefault()
                  reorder(moveFactory(factories, dragging, index))
                  setDragging(undefined)
                  setDropAt(undefined)
                }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', factory.name)
                  setDragging(index)
                }}
                onDragEnd={() => {
                  setDragging(undefined)
                  setDropAt(undefined)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  openMenu(event.clientX, event.clientY)
                }}
              >
                <button
                  type="button"
                  className={`${styles.row} ${expanded ? styles.strong : ''} ${waiting > 0 ? styles.counted : styles.withMore}`}
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
                <span className={styles.rowEnd}>
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
                  <button
                    type="button"
                    className={`${styles.more} ${menu?.factoryId === factory.id ? styles.moreOpen : ''}`}
                    aria-label="Factory actions"
                    aria-haspopup="menu"
                    aria-expanded={menu?.factoryId === factory.id}
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect()
                      openMenu(box.left, box.bottom + 4)
                    }}
                  >
                    ⋯
                  </button>
                </span>
              </article>
            )}
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
                    {view === 'automations' && badge.automationFailed && (
                      <span role="img" aria-label="An Automation failed" className={styles.subDot}>
                        <DotIcon className={styles.failedDot} />
                      </span>
                    )}
                  </button>
                )
              })}
          </div>
        )
      })}
      {orderError !== undefined && (
        <p className={styles.orderError} role="alert">
          {orderError}
        </p>
      )}
      {menu && menuFactory && (
        <FactoryMenu
          factory={menuFactory}
          at={{ x: menu.x, y: menu.y }}
          first={menuIndex === 0}
          last={menuIndex === factories.length - 1}
          onClose={() => setMenu(undefined)}
          actions={{
            onNewTask: () => onNewTask(menuFactory.id),
            onRename: () => setRenaming(menuFactory.id),
            onMoveUp: () => reorder(moveFactory(factories, menuIndex, menuIndex - 1)),
            onMoveDown: () => reorder(moveFactory(factories, menuIndex, menuIndex + 1)),
            onSettings: () =>
              open({ kind: 'factory', factoryId: menuFactory.id, view: 'settings' }),
            onShowFolder: () =>
              void ted.showFactoryFolder(menuFactory.id).catch((failure: unknown) => {
                setOrderError(readableError(failure))
              }),
            onOpenOnGitHub: () =>
              void ted
                .openOnGitHub(`https://github.com/${menuFactory.repo}`)
                .catch((failure: unknown) => setOrderError(readableError(failure))),
            onRemove: () => onRemoveFactory?.(menuFactory),
          }}
        />
      )}
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
