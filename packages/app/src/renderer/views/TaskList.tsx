import type {
  ArchivedFilter,
  Factory,
  ListColumn,
  ListFilters,
  ListGroup,
  ListSort,
  ListView,
  MachineSettings,
  Priority,
  RunSlots,
  StatusFilter,
  Task,
} from '@ted/protocol'
import { archivedFilters, listColumns, listGroups, listSorts } from '@ted/protocol/list-view'
import { createdByKinds, priorities } from '@ted/protocol/task'
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { AutopilotLabel } from '../components/Autopilot.tsx'
import { Button } from '../components/Button.tsx'
import { contextMenu } from '../components/ContextMenu.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { Help } from '../components/Help.tsx'
import markerStyles from '../components/HierarchyMarker.module.css'
import { HierarchyMarker } from '../components/HierarchyMarker.tsx'
import { ChevronIcon, CloseIcon, PlusIcon, SearchIcon } from '../components/icons.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { SubAgentTotal, TaskStatusWithSubAgents } from '../components/SubAgentCount.tsx'
import { openTaskActions } from '../components/TaskContextMenu.tsx'
import { ordinal } from '../components/TaskStatus.tsx'
import { useListCollapsed } from '../list-collapse.ts'
import {
  activeFilterCount,
  columnLabels,
  createdByLabels,
  dropAction,
  dropTargets,
  filterChips,
  filterTasks,
  groupLabels,
  groupTasks,
  isAllTasks,
  isQueueMode,
  type NestedRow,
  neighbours,
  nestedRows,
  selectionRange,
  shownColumns,
  sortLabels,
  stageName,
  stageOrder,
  statusFilterLabels,
  statusFilterOrder,
  summaryLine,
  type TaskGroup,
  toggled,
  viewFor,
  viewKey,
} from '../list-view.ts'
import { age, useNow } from '../requests.ts'
import { selectionTarget, useSelection } from '../selection.ts'
import { startTask } from '../setup-notice.ts'
import { activeSubAgentCount } from '../sub-agents.ts'
import { priorityLabels } from '../task-fields.ts'
import { ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import styles from './TaskList.module.css'
import views from './views.module.css'

const columnWidths: Record<ListColumn | 'queue', string> = {
  queue: '40px',
  priority: '16px',
  id: '56px',
  title: 'minmax(160px, 1fr)',
  factory: '110px',
  stage: '80px',
  status: 'fit-content(300px)',
  'blocked-by': '90px',
  'created-by': '110px',
  tokens: '64px',
  created: '56px',
  updated: '56px',
  started: '56px',
}

export function idColumnWidth(tasks: readonly Pick<Task, 'displayId'>[]): string {
  const longest = Math.max(0, ...tasks.map((t) => t.displayId.length))
  return `max(${columnWidths.id}, calc(${longest + 2} * 0.65 * var(--text-14)))`
}

export function listGrid(
  columns: readonly (ListColumn | 'queue')[],
  tasks: readonly Pick<Task, 'displayId'>[],
): string {
  return [
    '4px',
    '24px',
    ...columns.map((c) => (c === 'id' ? idColumnWidth(tasks) : columnWidths[c])),
    '4px',
  ].join(' ')
}

const sortHints: Partial<Record<ListSort, string>> = { manual: 'Priority, then rank' }

export function saveListView(
  settings: MachineSettings | undefined,
  scope: string,
  view: ListView,
): Promise<MachineSettings> {
  return ted.updateSettings({ listViews: { ...settings?.listViews, [scope]: view } })
}

function report(error: unknown) {
  console.error(error)
}

function shortDate(iso: string): string {
  return formatDate(iso, { day: 'numeric', month: 'short' })
}

function ending(task: Task): string {
  const ended = task.archived?.ended
  if (!ended) return ''
  if (ended.kind === 'never-started') return 'Never started'
  if (ended.kind === 'merged') return `Merged ${shortDate(ended.at)}`
  if (ended.kind === 'pull-request-closed') return 'Pull request closed on GitHub'
  return `Archived from ${stageName(ended.stage)}`
}

export function usePopover(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, close])
  return ref
}

export function MenuButton({
  label,
  icon,
  badge,
  children,
}: {
  label: string
  icon: ReactNode
  badge?: number
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const close = useMemo(() => () => setOpen(false), [])
  const ref = usePopover(open, close)
  return (
    <div ref={ref} className={styles.menuAnchor}>
      <Button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon}
        {label}
        {badge !== undefined && badge > 0 && <span className={styles.badge}>{badge}</span>}
      </Button>
      {open && (
        <div className={styles.menu} role="menu" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  )
}

function Submenu({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string | undefined
  children: ReactNode
}) {
  return (
    <div className={styles.submenuAnchor}>
      <ActionButton type="button" role="menuitem" aria-haspopup="menu" className={styles.menuItem}>
        <span className={styles.menuLabel}>{label}</span>
        {hint !== undefined && <span className={styles.menuHint}>{hint}</span>}
        <ChevronIcon open={false} className={styles.menuChevron} />
      </ActionButton>
      <div className={styles.submenu} role="menu" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

export function CheckItem({
  label,
  checked,
  disabled,
  count,
  icon,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  count?: number | undefined
  icon?: ReactNode
  onChange: () => void
}) {
  return (
    <ActionButton
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      className={styles.menuItem}
      onClick={onChange}
    >
      <span className={`${styles.check} ${checked ? styles.checked : ''}`} aria-hidden>
        {checked ? '✓' : ''}
      </span>
      {icon}
      <span className={styles.menuLabel}>{label}</span>
      {count !== undefined && <span className={styles.menuCount}>{count}</span>}
    </ActionButton>
  )
}

function RadioItem({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <ActionButton
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={styles.menuItem}
      onClick={onChange}
    >
      <span className={styles.menuLabel}>{label}</span>
      {checked && <span className={styles.menuTick}>✓</span>}
    </ActionButton>
  )
}

export function FilterMenu({
  filters,
  tasks,
  factories,
  allTasks,
  board = false,
  onChange,
}: {
  filters: ListFilters
  tasks: readonly Task[]
  factories: readonly Factory[]
  allTasks: boolean
  board?: boolean
  onChange: (filters: ListFilters) => void
}) {
  const count = (keep: (filters: ListFilters) => ListFilters) =>
    filterTasks(tasks, keep(filters)).length
  const set = <K extends keyof ListFilters>(name: K, value: ListFilters[K]) => {
    const next = { ...filters, [name]: value }
    if (Array.isArray(value) && value.length === 0) delete next[name]
    onChange(next)
  }
  return (
    <>
      {allTasks && (
        <Submenu label="Factory">
          {factories.map((f) => (
            <CheckItem
              key={f.id}
              label={f.name}
              checked={filters.factories?.includes(f.id) ?? false}
              count={count((c) => ({ ...c, factories: [f.id] }))}
              onChange={() => set('factories', toggled(filters.factories, f.id))}
            />
          ))}
        </Submenu>
      )}
      {!board && (
        <Submenu label="Stage">
          {stageOrder.map((stage) => (
            <CheckItem
              key={stage}
              label={stageName(stage)}
              checked={filters.stages?.includes(stage) ?? false}
              count={count((c) => ({ ...c, stages: [stage] }))}
              onChange={() => set('stages', toggled(filters.stages, stage))}
            />
          ))}
        </Submenu>
      )}
      <Submenu label="Status">
        {statusFilterOrder.map((status: StatusFilter) => (
          <CheckItem
            key={status}
            label={statusFilterLabels[status]}
            checked={filters.statuses?.includes(status) ?? false}
            count={count((c) => ({ ...c, statuses: [status] }))}
            onChange={() => set('statuses', toggled(filters.statuses, status))}
          />
        ))}
      </Submenu>
      <Submenu label="Priority">
        {priorities.map((priority: Priority) => (
          <CheckItem
            key={priority}
            label={priority === 'none' ? 'No priority' : priorityLabels[priority]}
            icon={<PriorityIcon priority={priority} />}
            checked={filters.priorities?.includes(priority) ?? false}
            count={count((c) => ({ ...c, priorities: [priority] }))}
            onChange={() => set('priorities', toggled(filters.priorities, priority))}
          />
        ))}
      </Submenu>
      <Submenu label="Created by">
        {createdByKinds.map((kind) => (
          <CheckItem
            key={kind}
            label={createdByLabels[kind]}
            checked={filters.createdBy?.includes(kind) ?? false}
            count={count((c) => ({ ...c, createdBy: [kind] }))}
            onChange={() => set('createdBy', toggled(filters.createdBy, kind))}
          />
        ))}
      </Submenu>
      <CheckItem
        label="Needs planning"
        checked={filters.needsPlanning === true}
        onChange={() => {
          const { needsPlanning: _, ...rest } = filters
          onChange(filters.needsPlanning ? rest : { ...rest, needsPlanning: true })
        }}
      />
      {!board && (
        <>
          <div className={styles.menuDivider} />
          <div className={styles.menuHeading}>Archived</div>
          <fieldset className={styles.segments} aria-label="Archived">
            {archivedFilters.map((value: ArchivedFilter) => (
              <ActionButton
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={(filters.archived ?? 'hidden') === value}
                className={styles.segment}
                onClick={() => {
                  const { archived: _, ...rest } = filters
                  return onChange(value === 'hidden' ? rest : { ...rest, archived: value })
                }}
              >
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </ActionButton>
            ))}
          </fieldset>
        </>
      )}
    </>
  )
}

function DisplayMenu({ view, onChange }: { view: ListView; onChange: (view: ListView) => void }) {
  return (
    <>
      <div className={styles.menuHeading}>
        Sort
        <Help>Manual is the queue order: Priority, then the rank you set by dragging.</Help>
      </div>
      <Submenu label={sortLabels[view.sort]} hint={sortHints[view.sort]}>
        {listSorts.map((sort) => (
          <RadioItem
            key={sort}
            label={sortLabels[sort]}
            checked={view.sort === sort}
            onChange={() => onChange({ ...view, sort })}
          />
        ))}
      </Submenu>
      <div className={styles.menuHeading}>Group</div>
      <Submenu label={groupLabels[view.group]}>
        {listGroups.map((group: ListGroup) => (
          <RadioItem
            key={group}
            label={groupLabels[group]}
            checked={view.group === group}
            onChange={() => onChange({ ...view, group })}
          />
        ))}
      </Submenu>
      <CheckItem
        label="Show empty groups"
        checked={view.showEmptyGroups ?? false}
        disabled={view.group === 'none'}
        onChange={() => onChange({ ...view, showEmptyGroups: !view.showEmptyGroups })}
      />
      <CheckItem
        label="Nest child Tasks"
        checked={view.nested ?? false}
        onChange={() => onChange({ ...view, nested: !view.nested })}
      />
      <div className={styles.menuDivider} />
      <div className={styles.menuHeading}>Columns</div>
      {listColumns.map((column) => (
        <CheckItem
          key={column}
          label={columnLabels[column]}
          checked={column === 'title' || view.columns.includes(column)}
          disabled={column === 'title'}
          onChange={() => onChange({ ...view, columns: toggled(view.columns, column) })}
        />
      ))}
    </>
  )
}

export function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 4H12M4 7H10M6 10H8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function DisplayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.75" y="2.75" width="10.5" height="8.5" rx="1.5" stroke="currentColor" />
      <path d="M1.75 5.5H12.25M5.5 5.5V11.25" stroke="currentColor" />
    </svg>
  )
}

function GripIcon() {
  return (
    <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden>
      {[2, 6, 10].flatMap((y) => [
        <circle key={`l${y}`} cx="2" cy={y} r="1" fill="currentColor" />,
        <circle key={`r${y}`} cx="6" cy={y} r="1" fill="currentColor" />,
      ])}
    </svg>
  )
}

interface DropSpot {
  group: string
  index: number
}

export function TaskList({
  scope,
  title,
  breadcrumb,
  tasks,
  factories,
  settings,
  onOpen,
  onOpenTask,
  onNewTask,
  onPlan,
  banners,
  capLine,
  slots,
}: {
  scope: string
  title: string
  breadcrumb?: string
  tasks: readonly Task[]
  factories: readonly Factory[]
  settings: MachineSettings | undefined
  onOpen: (task: Task) => void
  onOpenTask: (ref: string) => void
  onNewTask: () => void
  onPlan?: () => void
  banners?: ReactNode
  capLine?: string | undefined
  slots?: RunSlots | undefined
}) {
  const now = useNow()
  const allTasks = isAllTasks(scope)
  const saved = viewFor(settings?.listViews, scope)
  const [draft, setDraft] = useState<{ scope: string; view: ListView }>()
  const view = draft?.scope === scope ? draft.view : saved
  const savedKey = viewKey(saved)
  useEffect(() => {
    setDraft((current) => (current && viewKey(current.view) === savedKey ? undefined : current))
  }, [savedKey])
  const [text, setText] = useState('')
  const collapse = useListCollapsed(scope, view.group)
  const [dragging, setDragging] = useState<{ task: Task; group: string }>()
  const [spot, setSpot] = useState<DropSpot>()
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    void scope
    setText('')
  }, [scope])

  const change = (next: ListView) => {
    setDraft({ scope, view: next })
    return saveListView(settings, scope, next).catch(report)
  }
  const changeFilters = (filters: ListFilters) => change({ ...view, filters })

  const inScope = allTasks ? tasks : tasks.filter((t) => t.factoryId === scope)
  const shown = filterTasks(inScope, view.filters, text)
  const groups = groupTasks(
    shown,
    view,
    allTasks ? factories : factories.filter((f) => f.id === scope),
    dragging ? dropTargets(view.group) : [],
  )
  const queueMode = isQueueMode(view)
  const columns = shownColumns(view)
  const archivedOnly = view.filters.archived === 'only'
  const nested = view.nested === true
  const canReorder = view.sort === 'manual' && !archivedOnly
  const canDrag = canReorder && !nested
  const isCollapsed = (group: TaskGroup) => collapse.collapsed(group.key, group.collapsed)
  const rowsOf = (group: TaskGroup): NestedRow[] =>
    nested
      ? nestedRows(group.tasks, folded)
      : group.tasks.map((task) => ({ task, depth: 0, hasChildren: false }))
  const ordered = groups.flatMap((g) => (isCollapsed(g) ? [] : rowsOf(g).map((r) => r.task)))
  const grid = listGrid([...(queueMode ? (['queue'] as const) : []), ...columns], tasks)
  const chips = filterChips(view.filters, factories)
  const displayIds = new Map(tasks.map((t) => [t.id, t.displayId]))
  const { selected, setSelected, anchor, setAnchor, toggle } = useSelection(ordered, scope)
  const chosen = tasks.filter((t) => selected.includes(t.id))

  function select(task: Task, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) {
    if (event.shiftKey) {
      setSelected(selectionRange(ordered, anchor ?? selected.at(-1), task.id))
      return true
    }
    if (event.metaKey || event.ctrlKey) {
      toggle(task.id)
      return true
    }
    return false
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, task: Task) {
    const at = ordered.findIndex((t) => t.id === task.id)
    if ((event.target as HTMLElement).closest('input, button')) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onOpen(task)
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey) {
      event.preventDefault()
      const next = ordered[at + (event.key === 'ArrowDown' ? 1 : -1)]
      if (!next) return
      if (event.shiftKey) {
        const start = anchor ?? task.id
        setAnchor(start)
        setSelected(selectionRange(ordered, start, next.id))
      }
      rowRefs.current.get(next.id)?.focus()
    }
  }

  async function drop(target: DropSpot) {
    const moving = dragging
    setDragging(undefined)
    setSpot(undefined)
    if (!moving) return
    const group = groups.find((g) => g.key === target.group)
    if (!group) return
    const action = dropAction(moving.task, view.group, moving.group, target.group)
    if (!action) return
    const task = moving.task
    if (action === 'start') await startTask(task)
    if (action === 'unstart') await ted.moveToBacklog(task.id)
    const placed = neighbours(group.tasks, task.id, target.index)
    if (placed.after === undefined && placed.before === undefined) {
      if (view.group === 'priority' && task.priority !== target.group) {
        await ted.setPriority(task.id, target.group as Priority)
      }
      return
    }
    await ted.moveTask(task.id, placed)
  }

  function dropHint(target: DropSpot): string | undefined {
    if (!dragging) return undefined
    const action = dropAction(dragging.task, view.group, dragging.group, target.group)
    if (action === 'start') return 'Drop to Start · Joins the queue as Queued'
    if (action === 'unstart') return 'Drop to move back to Backlog'
    if (action === 'reorder' && queueMode) {
      const from = ordered.findIndex((t) => t.id === dragging.task.id)
      const place = target.index + (from !== -1 && from < target.index ? 0 : 1)
      return `Moves ${dragging.task.displayId} to ${ordinal(Math.max(1, place))}`
    }
    return undefined
  }

  function onDragOver(event: DragEvent, group: TaskGroup, index: number) {
    if (!dragging) return
    if (!dropAction(dragging.task, view.group, dragging.group, group.key)) {
      event.dataTransfer.dropEffect = 'none'
      setSpot(undefined)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rest = group.tasks.filter((t) => t.id !== dragging.task.id)
    const clamped = Math.min(Math.max(index, 0), rest.length)
    if (spot?.group !== group.key || spot.index !== clamped) {
      setSpot({ group: group.key, index: clamped })
    }
  }

  function fold(task: Task) {
    setFolded((current) => {
      const next = new Set(current)
      if (!next.delete(task.id)) next.add(task.id)
      return next
    })
  }

  function caret(nest: NestedRow) {
    if (!nested) return null
    if (!nest.hasChildren && !folded.has(nest.task.id)) {
      return <span className={markerStyles.caretSpace} aria-hidden />
    }
    const open = !folded.has(nest.task.id)
    return (
      <button
        type="button"
        className={markerStyles.caret}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} children of ${nest.task.displayId}`}
        onClick={(event) => {
          event.stopPropagation()
          fold(nest.task)
        }}
      >
        <ChevronIcon open={open} />
      </button>
    )
  }

  function cell(column: ListColumn, task: Task, nest: NestedRow): ReactNode {
    switch (column) {
      case 'priority':
        return <PriorityIcon priority={task.priority} />
      case 'id':
        return <span className={styles.id}>{task.displayId}</span>
      case 'title':
        return (
          <span
            className={styles.titleCell}
            style={nest.depth > 0 ? { paddingLeft: nest.depth * 20 } : undefined}
          >
            {caret(nest)}
            <span className={styles.titleText}>{task.title}</span>
            <HierarchyMarker task={task} tasks={tasks} showParent={nest.depth === 0} />
            <AutopilotLabel task={task} />
            {task.archived && <span className={styles.archivedChip}>Archived</span>}
          </span>
        )
      case 'factory':
        return factories.find((f) => f.id === task.factoryId)?.name ?? 'No Factory'
      case 'stage':
        return stageName(task.stage)
      case 'status':
        if (task.archived) return <span className={styles.meta}>{ending(task)}</span>
        if (!task.status && task.markers.length === 0 && activeSubAgentCount(task.runs) === 0) {
          return <span className={styles.none}>—</span>
        }
        return <TaskStatusWithSubAgents task={task} onOpenTask={onOpenTask} />
      case 'blocked-by': {
        const blockers = task.blockedBy.map((id) => displayIds.get(id) ?? id)
        return blockers.length === 0 ? <span className={styles.none}>—</span> : blockers.join(', ')
      }
      case 'created':
        return age(task.createdAt, now)
      case 'created-by':
        return createdByLabels[task.createdBy]
      case 'tokens':
        return <span className={styles.none}>—</span>
      case 'updated':
        return archivedOnly && task.archived
          ? shortDate(task.archived.at)
          : age(task.updatedAt, now)
      case 'started':
        return task.startedAt ? age(task.startedAt, now) : <span className={styles.none}>—</span>
    }
  }

  const rightAligned = new Set<ListColumn>(['updated', 'created', 'tokens', 'started'])

  function row(nest: NestedRow, group: TaskGroup, index: number) {
    const task = nest.task
    const isSelected = selected.includes(task.id)
    const place = task.status?.kind === 'queued' && 'place' in task.status ? task.status.place : 0
    return (
      <tr
        key={task.id}
        ref={(element) => {
          if (element) rowRefs.current.set(task.id, element)
          else rowRefs.current.delete(task.id)
        }}
        tabIndex={0}
        aria-selected={isSelected}
        {...contextMenu((at) =>
          openTaskActions(
            at,
            isSelected && chosen.length > 1 ? chosen.map((t) => t.id) : [task.id],
          ),
        )}
        data-task={task.displayId}
        data-nav-item
        {...selectionTarget(task.displayId)}
        className={[
          styles.row,
          isSelected ? styles.selected : '',
          task.archived ? styles.archived : '',
          dragging?.task.id === task.id ? styles.dragged : '',
        ].join(' ')}
        title={canReorder && nested ? 'Turn off Nest child Tasks to reorder' : undefined}
        draggable={canDrag && !task.archived}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', task.displayId)
          setDragging({ task, group: group.key })
        }}
        onDragEnd={() => {
          setDragging(undefined)
          setSpot(undefined)
        }}
        onDragOver={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          const below = event.clientY > box.top + box.height / 2
          const rest = group.tasks.filter((t) => t.id !== dragging?.task.id)
          const at = rest.findIndex((t) => t.id === task.id)
          onDragOver(event, group, at === -1 ? index : at + (below ? 1 : 0))
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (spot) drop(spot).catch(report)
        }}
        onClick={(event) => {
          if (select(task, event)) return
          setSelected([])
          setAnchor(task.id)
          return onOpen(task)
        }}
        onKeyDown={(event) => onRowKeyDown(event, task)}
      >
        <td className={`${styles.cell} ${styles.selectionCell}`}>
          <input
            type="checkbox"
            className={styles.selectionCheckbox}
            data-selection-box
            aria-label={`Select ${task.displayId}`}
            checked={isSelected}
            onClick={(event) => event.stopPropagation()}
            onChange={() => toggle(task.id)}
          />
        </td>
        {queueMode && (
          <td className={styles.queueCell}>
            <span className={styles.grip} aria-hidden>
              <GripIcon />
            </span>
            {place > 0 ? ordinal(place) : ''}
          </td>
        )}
        {columns.map((column) => (
          <td
            key={column}
            className={[
              styles.cell,
              column === 'title' ? styles.title : styles.meta,
              rightAligned.has(column) ? styles.right : '',
            ].join(' ')}
          >
            {cell(column, task, nest)}
          </td>
        ))}
      </tr>
    )
  }

  function dropLine(group: TaskGroup, index: number) {
    if (spot?.group !== group.key || spot.index !== index) return null
    const hint = dropHint(spot)
    return (
      <tr className={styles.dropLine} key={`drop-${group.key}-${index}`}>
        <td>{hint !== undefined && <span className={styles.dropHint}>{hint}</span>}</td>
      </tr>
    )
  }

  function groupRows(group: TaskGroup) {
    if (nested) return rowsOf(group).map((nest, i) => row(nest, group, i))
    const rest = group.tasks.filter((t) => t.id !== dragging?.task.id)
    const items: ReactNode[] = []
    group.tasks.forEach((task, i) => {
      const at = rest.findIndex((t) => t.id === task.id)
      if (at !== -1) items.push(dropLine(group, at))
      items.push(row({ task, depth: 0, hasChildren: false }, group, i))
    })
    items.push(dropLine(group, rest.length))
    return items
  }

  function empty() {
    if (inScope.length === 0) {
      return (
        <EmptyState title="No Tasks yet">
          <Button variant="primary" onClick={onNewTask}>
            New Task
          </Button>
          {onPlan && <Button onClick={onPlan}>Plan</Button>}
        </EmptyState>
      )
    }
    if (archivedOnly && activeFilterCount(view.filters) === 1 && text === '') {
      return <EmptyState title="No archived Tasks" />
    }
    return (
      <EmptyState title="No Tasks match these filters">
        <Button
          onClick={() => {
            setText('')
            return changeFilters({})
          }}
        >
          Clear filters
        </Button>
      </EmptyState>
    )
  }

  return (
    <section
      className={`${views.pane} ${styles.listPane} ${chosen.length > 0 ? styles.selecting : ''}`}
      aria-label={title}
    >
      <header className={views.header}>
        <h1 className={views.title}>
          {title}
          {breadcrumb !== undefined && (
            <>
              <span className={styles.crumbSlash}>/</span>
              <span className={styles.crumb}>{breadcrumb}</span>
            </>
          )}
        </h1>
        <span className={views.headerSpacer} />
        {capLine !== undefined && <span className={styles.capLine}>{capLine}</span>}
        <MenuButton label="Filter" icon={<FilterIcon />} badge={activeFilterCount(view.filters)}>
          {() => (
            <FilterMenu
              filters={view.filters}
              tasks={inScope}
              factories={factories}
              allTasks={allTasks}
              onChange={changeFilters}
            />
          )}
        </MenuButton>
        <MenuButton label="Display" icon={<DisplayIcon />}>
          {() => <DisplayMenu view={view} onChange={change} />}
        </MenuButton>
        {onPlan && <Button onClick={onPlan}>Plan</Button>}
        <Button variant="primary" onClick={onNewTask}>
          <PlusIcon />
          New Task
        </Button>
      </header>
      {banners}
      <div className={styles.toolbar}>
        {chips.length === 0 || text !== '' ? (
          <label className={styles.search}>
            <SearchIcon />
            <input
              data-filter-box
              type="search"
              value={text}
              placeholder="Filter by ID or title"
              aria-label="Filter by ID or title"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setText('')
                  event.currentTarget.blur()
                }
              }}
            />
            <kbd className={styles.slash}>/</kbd>
          </label>
        ) : (
          <input
            data-filter-box
            className={styles.hiddenSearch}
            type="search"
            value={text}
            aria-label="Filter by ID or title"
            onChange={(event) => setText(event.target.value)}
          />
        )}
        {chips.map((chip) => (
          <span key={chip.key} className={styles.chip}>
            {chip.label}
            <ActionButton
              type="button"
              className={styles.chipClear}
              aria-label={`Clear ${chip.label}`}
              onClick={() => changeFilters(chip.clear(view.filters))}
            >
              <CloseIcon size={10} />
            </ActionButton>
          </span>
        ))}
        {queueMode && (
          <>
            <span className={styles.plainChip}>Sort: Manual</span>
            <span className={styles.plainChip}>Group: None</span>
          </>
        )}
        <span className={views.headerSpacer} />
        <span className={styles.summary}>
          {summaryLine(inScope, shown, view, scope, factories)}
          {' · '}
          <SubAgentTotal tasks={shown} filtered={text !== '' || chips.length > 0} />
        </span>
        {queueMode && (
          <Help>
            Queued Tasks of every Factory, in the order they’ll start. Drag a row to change its
            place.
          </Help>
        )}
      </div>
      {groups.length === 0 ? (
        empty()
      ) : (
        <div className={styles.body}>
          <table
            className={styles.table}
            style={{ gridTemplateColumns: grid }}
            aria-label={`${title} Tasks`}
            data-rank-order={canDrag ? '' : undefined}
          >
            <thead>
              <tr className={`${styles.row} ${styles.heads}`}>
                <th className={styles.cell} aria-label="Selection" />
                {queueMode && <th className={styles.cell}>Queue</th>}
                {columns.map((column) => (
                  <th
                    key={column}
                    className={`${styles.cell} ${rightAligned.has(column) ? styles.right : ''}`}
                  >
                    {column === 'priority'
                      ? ''
                      : column === 'updated' && archivedOnly
                        ? 'Archived'
                        : columnLabels[column]}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => {
              const closed = isCollapsed(group)
              return (
                <tbody key={group.key} aria-label={group.label}>
                  {view.group !== 'none' && (
                    <tr className={styles.groupRow}>
                      <th>
                        <input
                          type="checkbox"
                          className={styles.selectionCheckbox}
                          data-selection-box
                          aria-label={`Select all ${group.label} Tasks`}
                          aria-checked={
                            group.tasks.some((t) => selected.includes(t.id)) &&
                            !group.tasks.every((t) => selected.includes(t.id))
                              ? 'mixed'
                              : undefined
                          }
                          checked={
                            group.tasks.length > 0 &&
                            group.tasks.every((t) => selected.includes(t.id))
                          }
                          ref={(input) => {
                            if (input)
                              input.indeterminate =
                                group.tasks.some((t) => selected.includes(t.id)) &&
                                !group.tasks.every((t) => selected.includes(t.id))
                          }}
                          disabled={group.tasks.length === 0}
                          onChange={() => {
                            const ids = new Set(group.tasks.map((t) => t.id))
                            const all = group.tasks.every((t) => selected.includes(t.id))
                            setSelected((current) =>
                              all
                                ? current.filter((id) => !ids.has(id))
                                : [...new Set([...current, ...ids])],
                            )
                          }}
                        />
                        <ActionButton
                          type="button"
                          className={styles.groupHead}
                          aria-expanded={!closed}
                          onClick={() => collapse.change(group.key, !closed)}
                          onDragOver={(event) => onDragOver(event, group, group.tasks.length)}
                          onDrop={(event) => {
                            event.preventDefault()
                            if (spot) drop(spot).catch(report)
                          }}
                        >
                          <ChevronIcon open={!closed} />
                          <span className={styles.groupLabel}>{group.label}</span>
                          <span className={styles.groupCount}>{group.tasks.length}</span>
                        </ActionButton>
                      </th>
                    </tr>
                  )}
                  {!closed && groupRows(group)}
                </tbody>
              )
            })}
          </table>
        </div>
      )}
      <SelectionBar
        scope={scope}
        chosen={chosen}
        allTasks={tasks}
        slots={slots}
        settings={settings}
        onSelect={setSelected}
      />
    </section>
  )
}
