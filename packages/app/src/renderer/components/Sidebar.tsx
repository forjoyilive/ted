import type { Coordinator, Factory } from '@ted/protocol'
import type { LucideIcon } from 'lucide-react'
import { Inbox, LayoutDashboard, ListTodo, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { FactoryView, Navigation, NavigationAction, Screen } from '../navigation.ts'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import { FactoryIcon } from './FactoryIcon.tsx'
import { FactoryMenu } from './FactoryMenu.tsx'
import { ChevronIcon, DotIcon, PlusIcon, SearchIcon, WarningIcon } from './icons.tsx'
import { ResizableSidebar } from './ResizableSidebar.tsx'
import { ResourceUsage } from './ResourceUsage.tsx'
import styles from './Sidebar.module.css'
import { StatusChip } from './StatusChip.tsx'

export interface FactoryBadges {
  waiting?: number
  uncounted?: boolean
  failed?: boolean
  plansFailed?: boolean
  stopsWork?: boolean
  drift?: number
  automationFailed?: boolean
  coordinator?: Coordinator['status']
}

export interface SidebarFooter {
  runs?: string
  failed?: string
  paused?: string
  overnight?: string
  simulators?: string
  emulators?: string
  update?: { label: string; busy: boolean }
}

interface SidebarProps {
  navigation: Navigation
  factories: readonly Factory[]
  currentFactoryId: string | undefined
  developerMode?: boolean
  inboxCount: number
  badges?: Readonly<Record<string, FactoryBadges>>
  settingsProblem?: boolean
  footer?: SidebarFooter
  runsOpen?: boolean
  onOpenRuns?: () => void
  onOpenFailed?: () => void
  usage?: ReactNode
  guide?: ReactNode
  onUpdate?: () => void
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
        data-arrows
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
            save()
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

const factoryViews: { view: FactoryView | 'tasks'; label: string; nested?: true }[] = [
  { view: 'coordinator', label: 'Coordinator' },
  { view: 'tasks', label: 'Tasks' },
  { view: 'board', label: 'Board', nested: true },
  { view: 'list', label: 'List', nested: true },
  { view: 'map', label: 'Map', nested: true },
  { view: 'plans', label: 'Plans' },
  { view: 'automations', label: 'Automations' },
  { view: 'settings', label: 'Settings' },
]

const coordinatorMarks = { working: 'Working', queued: 'Queued', paused: 'Paused' }

const openFactoriesKey = 'ted.sidebar.factoriesOpen'
const openTaskViewsKey = 'ted.sidebar.tasksOpen'
const taskViews: readonly FactoryView[] = ['board', 'list', 'map']

function readOpenRecord(key: string): Record<string, boolean> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
    return Object.fromEntries(
      Object.entries(stored).filter(([, open]) => typeof open === 'boolean'),
    ) as Record<string, boolean>
  } catch {
    return {}
  }
}

function useOpenRecord(
  key: string,
): [Record<string, boolean>, (factoryId: string, open: boolean) => void] {
  const [record, setRecord] = useState(() => readOpenRecord(key))
  const setOpen = (factoryId: string, open: boolean) => {
    const next = { ...readOpenRecord(key), [factoryId]: open }
    setRecord(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {}
  }
  return [record, setOpen]
}

function taskViewFactory(screen: Screen): string | undefined {
  return screen.kind === 'factory' && taskViews.includes(screen.view) ? screen.factoryId : undefined
}

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
  developerMode = false,
  badges = {},
  settingsProblem = false,
  footer = {},
  runsOpen = false,
  onOpenRuns,
  onOpenFailed,
  usage,
  guide,
  onUpdate,
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
  const [openFactories, setFactoryOpen] = useOpenRecord(openFactoriesKey)
  const [openTaskViews, setTaskViewsOpen] = useOpenRecord(openTaskViewsKey)
  const onTaskViewsOf = taskViewFactory(navigation.screen)
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens only when arriving at a Task view
  useEffect(() => {
    if (onTaskViewsOf !== undefined) setTaskViewsOpen(onTaskViewsOf, true)
  }, [onTaskViewsOf])
  const reorder = (ids: string[] | undefined) => {
    if (!ids) return
    setOrderError(undefined)
    return ted
      .reorderFactories(ids)
      .catch((failure: unknown) => setOrderError(readableError(failure)))
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
    <ResizableSidebar side="navigation">
      <nav className={styles.sidebar} aria-label="Sidebar">
        <div className={styles.top}>
          <ActionButton type="button" className={styles.search} onClick={onSearch}>
            <SearchIcon className={styles.searchIcon} />
            <span className={styles.searchLabel}>Search</span>
            <span className={styles.shortcut}>⌘K</span>
          </ActionButton>
        </div>

        <ActionButton
          type="button"
          className={`${styles.row} ${inboxCount > 0 ? styles.strong : ''}`}
          onClick={() => open({ kind: 'inbox' })}
          {...current({ kind: 'inbox' })}
        >
          <NavIcon shape={Inbox} />
          <span className={styles.label}>Inbox</span>
          {inboxCount > 0 && <span className={styles.count}>{inboxCount}</span>}
        </ActionButton>
        <ActionButton
          type="button"
          className={styles.row}
          onClick={() => open({ kind: 'all-tasks' })}
          {...current({ kind: 'all-tasks' })}
        >
          <NavIcon shape={ListTodo} />
          <span className={styles.label}>All Tasks</span>
        </ActionButton>
        <ActionButton
          type="button"
          className={styles.row}
          onClick={() => open({ kind: 'dashboard' })}
          {...current({ kind: 'dashboard' })}
        >
          <NavIcon shape={LayoutDashboard} />
          <span className={styles.label}>Dashboard</span>
        </ActionButton>

        <div className={styles.sectionHeading}>
          <h2 className={styles.section}>Factories</h2>
          <ActionButton
            type="button"
            className={styles.addFactory}
            aria-label="Add Factory"
            title="Add Factory"
            onClick={onAddFactory}
          >
            <PlusIcon />
          </ActionButton>
        </div>
        {factories.map((factory, index) => {
          const isCurrent = factory.id === currentFactoryId
          const expanded = openFactories[factory.id] ?? isCurrent
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
                  <ActionButton
                    type="button"
                    className={styles.caret}
                    aria-label="Views"
                    aria-expanded={expanded}
                    onClick={() => setFactoryOpen(factory.id, !expanded)}
                  >
                    <ChevronIcon
                      open
                      className={`${styles.chevron} ${expanded ? '' : styles.chevronClosed}`}
                    />
                  </ActionButton>
                  <ActionButton
                    type="button"
                    className={`${styles.row} ${styles.factoryName} ${isCurrent ? styles.strong : ''} ${waiting > 0 ? styles.counted : styles.withMore}`}
                    onClick={() => {
                      if (expanded) return setFactoryOpen(factory.id, false)
                      setFactoryOpen(factory.id, true)
                      return dispatch({ type: 'open-factory', factoryId: factory.id })
                    }}
                  >
                    <FactoryIcon factory={factory} />
                    <span className={styles.label}>{factory.name}</span>
                    {badge.failed && <DotIcon className={styles.failedDot} />}
                    {badge.stopsWork && (
                      <span role="img" aria-label="A problem stops work" className={styles.warning}>
                        <WarningIcon />
                      </span>
                    )}
                  </ActionButton>
                  <span className={styles.rowEnd}>
                    {waiting > 0 && (
                      <ActionButton
                        type="button"
                        className={`${styles.countButton} ${badge.uncounted ? styles.countQuiet : ''}`}
                        aria-label={`${waiting} waiting in ${factory.name}${badge.uncounted ? ', not counted in the Inbox' : ''}`}
                        title={
                          badge.uncounted
                            ? 'Not counted: Inbox items are off for this Factory. Show in the Inbox'
                            : 'Show in the Inbox'
                        }
                        onClick={() => open({ kind: 'inbox', factoryId: factory.id })}
                      >
                        {waiting}
                      </ActionButton>
                    )}
                    <ActionButton
                      type="button"
                      className={`${styles.more} ${menu?.factoryId === factory.id ? styles.moreOpen : ''}`}
                      aria-label="Factory actions"
                      aria-haspopup="menu"
                      aria-expanded={menu?.factoryId === factory.id}
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect()
                        return openMenu(box.left, box.bottom + 4)
                      }}
                    >
                      ⋯
                    </ActionButton>
                  </span>
                </article>
              )}
              {expanded &&
                factoryViews.map(({ view, label, nested }) => {
                  const taskViewsOpen = openTaskViews[factory.id] ?? false
                  if (nested && !taskViewsOpen) return null
                  if (view === 'tasks') {
                    return (
                      <div key={view} className={styles.tasksRow}>
                        <ActionButton
                          type="button"
                          className={`${styles.caret} ${styles.tasksCaret}`}
                          aria-label="Task views"
                          aria-expanded={taskViewsOpen}
                          onClick={() => setTaskViewsOpen(factory.id, !taskViewsOpen)}
                        >
                          <ChevronIcon
                            open
                            className={`${styles.chevron} ${taskViewsOpen ? '' : styles.chevronClosed}`}
                          />
                        </ActionButton>
                        <button
                          type="button"
                          className={`${styles.row} ${styles.sub}`}
                          onClick={() => {
                            setTaskViewsOpen(factory.id, true)
                            dispatch({ type: 'open-tasks', factoryId: factory.id })
                          }}
                        >
                          <span className={styles.label}>{label}</span>
                        </button>
                      </div>
                    )
                  }
                  const screen: Screen = { kind: 'factory', factoryId: factory.id, view }
                  return (
                    <ActionButton
                      key={view}
                      type="button"
                      className={`${styles.row} ${styles.sub} ${nested ? styles.nested : ''}`}
                      onClick={() => open(screen)}
                      {...current(screen)}
                    >
                      <span className={styles.label}>{label}</span>
                      {view === 'coordinator' &&
                        (badge.coordinator === 'working' ||
                          badge.coordinator === 'queued' ||
                          badge.coordinator === 'paused') && (
                          <span
                            role="img"
                            aria-label={coordinatorMarks[badge.coordinator]}
                            title={coordinatorMarks[badge.coordinator]}
                            className={styles.subStatus}
                          >
                            <StatusChip
                              tone={badge.coordinator === 'working' ? 'working' : 'neutral'}
                              glyph={badge.coordinator}
                            >
                              {null}
                            </StatusChip>
                          </span>
                        )}
                      {view === 'coordinator' && badge.coordinator === 'failed' && (
                        <span
                          role="img"
                          aria-label="The Coordinator failed"
                          className={styles.subDot}
                        >
                          <DotIcon className={styles.failedDot} />
                        </span>
                      )}
                      {view === 'settings' && (badge.drift ?? 0) > 0 && (
                        <span
                          className={styles.subCount}
                          title="Inherited Stage files that changed"
                        >
                          {badge.drift}
                        </span>
                      )}
                      {view === 'automations' && badge.automationFailed && (
                        <span
                          role="img"
                          aria-label="An Automation failed"
                          className={styles.subDot}
                        >
                          <DotIcon className={styles.failedDot} />
                        </span>
                      )}
                      {view === 'plans' && badge.plansFailed && (
                        <span
                          role="img"
                          aria-label="A planning chat failed"
                          className={styles.subDot}
                        >
                          <DotIcon className={styles.failedDot} />
                        </span>
                      )}
                    </ActionButton>
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
              onPlan: () => dispatch({ type: 'open-plan', factoryId: menuFactory.id }),
              onRename: () => setRenaming(menuFactory.id),
              onMoveUp: () => reorder(moveFactory(factories, menuIndex, menuIndex - 1)),
              onMoveDown: () => reorder(moveFactory(factories, menuIndex, menuIndex + 1)),
              onSettings: () =>
                open({ kind: 'factory', factoryId: menuFactory.id, view: 'settings' }),
              onShowFolder: () =>
                ted.showFactoryFolder(menuFactory.id).catch((failure: unknown) => {
                  setOrderError(readableError(failure))
                }),
              onOpenOnGitHub: () =>
                ted
                  .openOnGitHub(`https://github.com/${menuFactory.repo}`)
                  .catch((failure: unknown) => setOrderError(readableError(failure))),
              onRemove: () => onRemoveFactory?.(menuFactory),
            }}
          />
        )}
        <div className={styles.spacer} />
        {guide}

        <ActionButton
          type="button"
          className={`${styles.row} ${styles.appSettings}`}
          onClick={() => dispatch({ type: 'open-settings' })}
        >
          <NavIcon shape={Settings} />
          <span className={styles.label}>Settings</span>
          {settingsProblem && (
            <span role="img" aria-label="A problem stops work" className={styles.failedDot}>
              <DotIcon />
            </span>
          )}
        </ActionButton>

        {footerLines.length > 0 && (
          <footer className={styles.footer}>
            {footer.runs !== undefined &&
              (onOpenRuns ? (
                <ActionButton
                  type="button"
                  className={styles.runsButton}
                  aria-haspopup="dialog"
                  aria-expanded={runsOpen}
                  onClick={onOpenRuns}
                >
                  {footer.runs}
                </ActionButton>
              ) : (
                <p className={styles.runs}>{footer.runs}</p>
              ))}
            {footer.failed !== undefined &&
              (onOpenFailed ? (
                <ActionButton type="button" className={styles.failedButton} onClick={onOpenFailed}>
                  {footer.failed}
                </ActionButton>
              ) : (
                <p className={styles.failed}>{footer.failed}</p>
              ))}
            {footer.paused !== undefined && <p className={styles.runs}>{footer.paused}</p>}
            {footer.overnight !== undefined && <p className={styles.runs}>{footer.overnight}</p>}
            {footer.simulators !== undefined && (
              <p className={styles.simulators}>{footer.simulators}</p>
            )}
            {footer.emulators !== undefined && (
              <p className={styles.simulators}>{footer.emulators}</p>
            )}
            {footer.update !== undefined && (
              <ActionButton
                type="button"
                className={footer.update.busy ? styles.updateBusy : styles.updateChip}
                disabled={footer.update.busy}
                onClick={() => void onUpdate?.()}
              >
                {footer.update.label}
              </ActionButton>
            )}
          </footer>
        )}
        {usage}
        {developerMode && <ResourceUsage />}
      </nav>
    </ResizableSidebar>
  )
}

function NavIcon({ shape: Shape }: { shape: LucideIcon }) {
  return (
    <span className={styles.navIcon} aria-hidden="true">
      <Shape size={16} strokeWidth={1.75} />
    </span>
  )
}
