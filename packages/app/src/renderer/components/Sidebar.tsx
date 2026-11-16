import type { Coordinator, Factory, FactoryGroup, FactoryLayout } from '@ted/protocol'
import { factoryGroupNameMax } from '@ted/protocol/factory'
import type { LucideIcon } from 'lucide-react'
import {
  Folder as FolderClosed,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Settings,
} from 'lucide-react'
import type { DragEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  addGroup,
  arrange,
  type DropTarget,
  groupOf,
  groups,
  type LayoutKey,
  layoutOf,
  moveStep,
  moveTo,
  putInGroup,
  renameGroup,
  rollUp,
  ungroup,
} from '../factory-layout.ts'
import type { FactoryView, Navigation, NavigationAction, Screen } from '../navigation.ts'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import { FactoryIcon } from './FactoryIcon.tsx'
import { FactoryMenu, PopoverMenu } from './FactoryMenu.tsx'
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
  factoryLayout?: FactoryLayout
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

function GroupNameRow({
  name: initial,
  onSave,
  onDone,
}: {
  name: string
  onSave: (name: string) => Promise<unknown> | undefined
  onDone: () => void
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string>()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  const save = async () => {
    const trimmed = name.trim()
    if (trimmed === '') return setError('Name the Factory group')
    if (trimmed === initial) return onDone()
    await onSave(trimmed)
    onDone()
  }
  return (
    <div className={styles.rename}>
      <input
        className={styles.renameInput}
        aria-label="Group name"
        placeholder="Group name"
        value={name}
        maxLength={factoryGroupNameMax}
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
        onBlur={onDone}
      />
      <span className={error === undefined ? styles.renameHint : styles.renameError}>
        {error ?? 'Enter saves · Esc cancels'}
      </span>
    </div>
  )
}

const factoryViews: { view: FactoryView | 'tasks'; label: string; nested?: true }[] = [
  { view: 'agents', label: 'Agents' },
  { view: 'tasks', label: 'Tasks' },
  { view: 'board', label: 'Board', nested: true },
  { view: 'list', label: 'List', nested: true },
  { view: 'map', label: 'Map', nested: true },
  { view: 'automations', label: 'Automations' },
  { view: 'settings', label: 'Settings' },
]

const coordinatorMarks = { working: 'Working', queued: 'Queued', paused: 'Paused' }

type SidebarMenu =
  | { kind: 'factory'; factoryId: string; x: number; y: number }
  | { kind: 'group'; groupId: string; x: number; y: number }
  | { kind: 'add'; x: number; y: number }

interface Naming {
  groupId: string
  factoryId?: string
  isNew: boolean
}

const newId = () => crypto.randomUUID()

const openFactoriesKey = 'ted.sidebar.factoriesOpen'
const openGroupsKey = 'ted.sidebar.groupsOpen'
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
  if (a.kind === 'inbox' && b.kind === 'inbox') return a.factoryId === b.factoryId
  return a.kind === b.kind
}

export function Sidebar({
  navigation,
  factories,
  factoryLayout,
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
  const [menu, setMenu] = useState<SidebarMenu>()
  const [renaming, setRenaming] = useState<string>()
  const [naming, setNaming] = useState<Naming>()
  const [dragging, setDragging] = useState<LayoutKey>()
  const [dropAt, setDropAt] = useState<DropTarget>()
  const [orderError, setOrderError] = useState<string>()
  const [openFactories, setFactoryOpen] = useOpenRecord(openFactoriesKey)
  const [openTaskViews, setTaskViewsOpen] = useOpenRecord(openTaskViewsKey)
  const [openGroups, setGroupOpen] = useOpenRecord(openGroupsKey)
  const onTaskViewsOf = taskViewFactory(navigation.screen)
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens only when arriving at a Task view
  useEffect(() => {
    if (onTaskViewsOf !== undefined) setTaskViewsOpen(onTaskViewsOf, true)
  }, [onTaskViewsOf])
  const layout = layoutOf(arrange(factories, factoryLayout))
  const screen = navigation.screen
  const arrivedAt =
    navigation.taskId !== undefined
      ? currentFactoryId
      : screen.kind === 'factory'
        ? screen.factoryId
        : screen.kind === 'dashboard' && screen.dashboard?.factoryIds?.length === 1
          ? screen.dashboard.factoryIds[0]
          : screen.kind === 'inbox'
            ? screen.factoryId
            : undefined
  const arrivedGroup = arrivedAt === undefined ? undefined : groupOf(layout, arrivedAt)?.id
  const arrival = arrivedAt === undefined ? undefined : JSON.stringify([screen, navigation.taskId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens only when arriving at a Factory or Task
  useEffect(() => {
    if (arrivedGroup !== undefined && openGroups[arrivedGroup] === false) {
      setGroupOpen(arrivedGroup, true)
    }
  }, [arrival, arrivedGroup])
  const shown =
    naming?.isNew === true && !groups(layout).some((g) => g.id === naming.groupId)
      ? addGroup(layout, { id: naming.groupId, name: '' }, naming.factoryId)
      : layout
  const entries = arrange(factories, shown)
  const save = (next: FactoryLayout | undefined) => {
    if (!next) return
    setOrderError(undefined)
    return ted
      .saveFactoryLayout(next)
      .catch((failure: unknown) => setOrderError(readableError(failure)))
  }
  const sameKey = (a: LayoutKey | undefined, b: LayoutKey) =>
    a !== undefined && JSON.stringify(a) === JSON.stringify(b)
  const isDragging = (key: LayoutKey) => sameKey(dragging, key)
  const endDrag = () => {
    setDragging(undefined)
    setDropAt(undefined)
  }
  const dragSource = (key: LayoutKey, name: string) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.stopPropagation()
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', name)
      setDragging(key)
    },
    onDragEnd: endDrag,
  })
  const placeFor = (event: DragEvent, key: LayoutKey): DropTarget => {
    const box = event.currentTarget.getBoundingClientRect()
    const y = (event.clientY - box.top) / Math.max(1, box.height)
    if ('groupId' in key && dragging && 'factoryId' in dragging && y > 0.25 && y < 0.75) {
      return { into: key.groupId }
    }
    return y < 0.5 ? { before: key } : { after: key }
  }
  const dropZone = (key: LayoutKey) => ({
    onDragOver: (event: DragEvent) => {
      if (dragging === undefined || sameKey(dragging, key)) return
      event.preventDefault()
      event.stopPropagation()
      const target = placeFor(event, key)
      if (JSON.stringify(target) !== JSON.stringify(dropAt)) setDropAt(target)
    },
    onDrop: (event: DragEvent) => {
      if (dragging === undefined) return
      event.preventDefault()
      event.stopPropagation()
      save(moveTo(layout, dragging, placeFor(event, key)))
      endDrag()
    },
  })
  const dropClass = (key: LayoutKey) =>
    dropAt === undefined
      ? ''
      : 'before' in dropAt && sameKey(dropAt.before, key)
        ? styles.dropAbove
        : 'after' in dropAt && sameKey(dropAt.after, key)
          ? styles.dropBelow
          : 'into' in dropAt && 'groupId' in key && dropAt.into === key.groupId
            ? styles.dropInto
            : ''
  const isMenu = (factoryId: string) => menu?.kind === 'factory' && menu.factoryId === factoryId
  const menuFactory =
    menu?.kind === 'factory' ? factories.find((f) => f.id === menu.factoryId) : undefined
  const menuGroup =
    menu?.kind === 'group' ? groups(layout).find((g) => g.id === menu.groupId) : undefined
  const open = (screen: Screen) => dispatch({ type: 'open', screen })
  const current = (screen: Screen) =>
    sameScreen(navigation.screen, screen) ? { 'aria-current': 'page' as const } : {}
  const footerLines = Object.entries(footer).filter(
    ([, line]) => line !== undefined && (!Array.isArray(line) || line.length > 0),
  )

  const renderFactory = (factory: Factory) => {
    const isCurrent = factory.id === currentFactoryId
    const expanded = openFactories[factory.id] ?? isCurrent
    const badge = badges[factory.id] ?? {}
    const waiting = badge.waiting ?? 0
    const openMenu = (x: number, y: number) =>
      setMenu({ kind: 'factory', factoryId: factory.id, x, y })
    return (
      <div
        key={factory.id}
        className={`${styles.factory} ${isDragging({ factoryId: factory.id }) ? styles.dragging : ''}`}
      >
        {renaming === factory.id ? (
          <RenameRow factory={factory} onDone={() => setRenaming(undefined)} />
        ) : (
          <article
            aria-label={factory.name}
            className={`${styles.factoryRow} ${dropClass({ factoryId: factory.id })}`}
            {...dragSource({ factoryId: factory.id }, factory.name)}
            {...dropZone({ factoryId: factory.id })}
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
                if (openFactories[factory.id] === undefined) setFactoryOpen(factory.id, expanded)
                open({ kind: 'inbox', factoryId: factory.id })
              }}
              {...current({ kind: 'inbox', factoryId: factory.id })}
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
                className={`${styles.more} ${isMenu(factory.id) ? styles.moreOpen : ''}`}
                aria-label="Factory actions"
                aria-haspopup="menu"
                aria-expanded={isMenu(factory.id)}
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
                {view === 'agents' &&
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
                {view === 'agents' && (badge.coordinator === 'failed' || badge.plansFailed) && (
                  <span
                    role="img"
                    aria-label={
                      badge.coordinator === 'failed'
                        ? 'A Coordinator chat failed'
                        : 'A planning chat failed'
                    }
                    className={styles.subDot}
                  >
                    <DotIcon className={styles.failedDot} />
                  </span>
                )}
                {view === 'settings' && (badge.drift ?? 0) > 0 && (
                  <span className={styles.subCount} title="Inherited Stage files that changed">
                    {badge.drift}
                  </span>
                )}
                {view === 'automations' && badge.automationFailed && (
                  <span role="img" aria-label="An Automation failed" className={styles.subDot}>
                    <DotIcon className={styles.failedDot} />
                  </span>
                )}
              </ActionButton>
            )
          })}
      </div>
    )
  }

  const renderGroup = (group: FactoryGroup, members: readonly Factory[]) => {
    const key = { groupId: group.id }
    const isOpen = openGroups[group.id] ?? true
    const marks = rollUp(
      badges,
      members.map((f) => f.id),
    )
    const menuOpen = menu?.kind === 'group' && menu.groupId === group.id
    const openMenu = (x: number, y: number) => setMenu({ kind: 'group', groupId: group.id, x, y })
    const Folder = isOpen ? FolderOpen : FolderClosed
    return (
      <section
        key={group.id}
        aria-label={group.name || 'New Factory group'}
        className={`${styles.group} ${isOpen ? '' : styles.groupClosed} ${isDragging(key) ? styles.dragging : ''}`}
      >
        {naming?.groupId === group.id ? (
          <GroupNameRow
            name={group.name}
            onSave={(name) =>
              save(
                naming.isNew
                  ? addGroup(layout, { id: group.id, name }, naming.factoryId)
                  : renameGroup(layout, group.id, name),
              )
            }
            onDone={() => setNaming(undefined)}
          />
        ) : (
          <article
            aria-label={group.name}
            className={`${styles.groupRow} ${dropClass(key)}`}
            {...dragSource(key, group.name)}
            {...dropZone(key)}
            onContextMenu={(event) => {
              event.preventDefault()
              openMenu(event.clientX, event.clientY)
            }}
          >
            <ActionButton
              type="button"
              className={styles.groupName}
              aria-expanded={isOpen}
              onClick={() => setGroupOpen(group.id, !isOpen)}
            >
              <span className={styles.groupIcon} aria-hidden="true">
                <Folder size={17} strokeWidth={1.75} />
              </span>
              <span className={styles.label}>{group.name}</span>
              {!isOpen && marks.failed && <DotIcon className={styles.failedDot} />}
              {!isOpen && marks.stopsWork && (
                <span role="img" aria-label="A problem stops work" className={styles.warning}>
                  <WarningIcon />
                </span>
              )}
            </ActionButton>
            <span className={styles.groupEnd}>
              {!isOpen && marks.waiting > 0 && (
                <ActionButton
                  type="button"
                  className={`${styles.countButton} ${marks.uncounted ? styles.countQuiet : ''}`}
                  aria-label={`${marks.waiting} waiting in ${group.name}`}
                  title="Show in the Inbox"
                  onClick={() => open({ kind: 'inbox', groupId: group.id })}
                >
                  {marks.waiting}
                </ActionButton>
              )}
              <ActionButton
                type="button"
                className={`${styles.more} ${menuOpen ? styles.moreOpen : ''}`}
                aria-label="Factory group actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  return openMenu(box.left, box.bottom + 4)
                }}
              >
                ⋯
              </ActionButton>
              <ChevronIcon
                open
                className={`${styles.chevron} ${isOpen ? '' : styles.chevronClosed}`}
              />
            </span>
          </article>
        )}
        {isOpen && (
          <div className={styles.groupMembers}>
            {members.map(renderFactory)}
            {members.length === 0 && (
              <p
                className={`${styles.groupEmpty} ${dropAt !== undefined && 'into' in dropAt && dropAt.into === group.id ? styles.dropInto : ''}`}
                onDragOver={(event) => {
                  if (dragging === undefined || !('factoryId' in dragging)) return
                  event.preventDefault()
                  setDropAt({ into: group.id })
                }}
                onDrop={(event) => {
                  if (dragging === undefined) return
                  event.preventDefault()
                  save(moveTo(layout, dragging, { into: group.id }))
                  endDrag()
                }}
              >
                Drag a Factory here
              </p>
            )}
          </div>
        )}
      </section>
    )
  }

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
            aria-label="New Factory or Factory group"
            title="New Factory or Factory group"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'add'}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              setMenu({ kind: 'add', x: box.left, y: box.bottom + 4 })
            }}
          >
            <PlusIcon />
          </ActionButton>
        </div>
        {entries.map((entry) =>
          entry.kind === 'factory'
            ? renderFactory(entry.factory)
            : renderGroup(entry.group, entry.factories),
        )}
        {orderError !== undefined && (
          <p className={styles.orderError} role="alert">
            {orderError}
          </p>
        )}
        {menu?.kind === 'add' && (
          <PopoverMenu
            label="New Factory or Factory group"
            at={menu}
            pendingKey="sidebar-add"
            onClose={() => setMenu(undefined)}
            items={[
              { label: 'New Factory…', act: onAddFactory },
              {
                label: 'New Factory group…',
                act: () => setNaming({ groupId: newId(), isNew: true }),
              },
            ]}
          />
        )}
        {menu?.kind === 'group' && menuGroup && (
          <PopoverMenu
            label="Factory group actions"
            at={menu}
            pendingKey={`group-actions:${menuGroup.id}`}
            onClose={() => setMenu(undefined)}
            items={[
              {
                label: 'Rename…',
                act: () => setNaming({ groupId: menuGroup.id, isNew: false }),
              },
              {
                label: 'Move up',
                act: () => save(moveStep(layout, { groupId: menuGroup.id }, -1)),
                disabled: !moveStep(layout, { groupId: menuGroup.id }, -1),
              },
              {
                label: 'Move down',
                act: () => save(moveStep(layout, { groupId: menuGroup.id }, 1)),
                disabled: !moveStep(layout, { groupId: menuGroup.id }, 1),
              },
              {
                label: 'Ungroup',
                divider: true,
                act: () => save(ungroup(layout, menuGroup.id)),
              },
            ]}
          />
        )}
        {menu?.kind === 'factory' && menuFactory && (
          <FactoryMenu
            factory={menuFactory}
            at={menu}
            first={!moveStep(layout, { factoryId: menuFactory.id }, -1)}
            last={!moveStep(layout, { factoryId: menuFactory.id }, 1)}
            groups={groups(layout)}
            groupId={groupOf(layout, menuFactory.id)?.id}
            onClose={() => setMenu(undefined)}
            actions={{
              onNewTask: () => onNewTask(menuFactory.id),
              onPlan: () => dispatch({ type: 'open-plan', factoryId: menuFactory.id }),
              onRename: () => setRenaming(menuFactory.id),
              onMoveUp: () => save(moveStep(layout, { factoryId: menuFactory.id }, -1)),
              onMoveDown: () => save(moveStep(layout, { factoryId: menuFactory.id }, 1)),
              onMoveToGroup: (groupId) => save(putInGroup(layout, menuFactory.id, groupId)),
              onNewGroup: () =>
                setNaming({ groupId: newId(), factoryId: menuFactory.id, isNew: true }),
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
