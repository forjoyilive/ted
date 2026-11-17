import type {
  BoardField,
  BoardView,
  Factory,
  ListFilters,
  MachineSettings,
  QueuedForSlot,
  RunSlots,
  StageId,
  Task,
} from '@ted/protocol'
import { boardCardSizes, boardFields } from '@ted/protocol/board-view'
import { isCleanup } from '@ted/protocol/stage'
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type BoardColumn,
  type BoardDrop,
  boardColumns,
  boardDrop,
  boardLayout,
  boardViewFor,
  canStart,
  cardActivity,
  doneCardLine,
  type Placement,
  placeCard,
  startPlace,
  startStage,
  withoutBlockers,
  withoutGoneStages,
} from '../board.ts'
import { ArchiveDoneDialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import { contextMenu } from '../components/ContextMenu.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { FactoryIcon } from '../components/FactoryIcon.tsx'
import { HierarchyMarker } from '../components/HierarchyMarker.tsx'
import { CloseIcon, PlusIcon, SearchIcon } from '../components/icons.tsx'
import { PriorityButton } from '../components/PriorityMenu.tsx'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { SubAgentTotal, TaskStatusWithSubAgents } from '../components/SubAgentCount.tsx'
import { openTaskActions } from '../components/TaskContextMenu.tsx'
import { ordinal, RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import { boardEmpty } from '../empty-states.ts'
import {
  activeFilterCount,
  columnSelection,
  filterChips,
  filterTasks,
  toggled,
} from '../list-view.ts'
import { useNow } from '../requests.ts'
import { selectionTarget, useSelection } from '../selection.ts'
import { startTask } from '../setup-notice.ts'
import { statusDetail } from '../slots.ts'
import { useStages } from '../stages.tsx'
import { ted } from '../ted.ts'
import styles from './Board.module.css'
import listStyles from './TaskList.module.css'
import {
  CheckItem,
  DisplayIcon,
  FilterIcon,
  FilterMenu,
  MenuButton,
  usePopover,
} from './TaskList.tsx'
import { SetupPanel } from './TaskViews.tsx'
import views from './views.module.css'

interface Dragging {
  task: Task
  from: StageId
  grabY: number
  height: number
}

interface Target {
  stage: StageId
  drop: BoardDrop
  placement: Placement
}

const cardSizeLabels: Record<BoardView['cardSize'], string> = { full: 'Full', compact: 'Compact' }

const fieldLabels: Record<BoardField, string> = {
  priority: 'Priority',
  activity: 'Activity line',
  'sub-agents': 'Sub-agent count',
  blockers: 'Blockers',
  hierarchy: 'Parent and children',
}

function without<T>(list: readonly T[], item: T): T[] {
  return list.filter((other) => other !== item)
}

function report(error: unknown) {
  console.error(error)
}

function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <rect x="1.75" y="4.25" width="6.5" height="4.5" rx="1" stroke="currentColor" />
      <path d="M3.25 4.25V3a1.75 1.75 0 0 1 3.5 0v1.25" stroke="currentColor" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
      <path
        d="M2 1.2v5.6c0 .3.3.5.6.3l4.2-2.8c.2-.2.2-.5 0-.6L2.6.9c-.3-.2-.6 0-.6.3Z"
        fill="currentColor"
      />
    </svg>
  )
}

function RefusedIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <circle cx="5" cy="5" r="4" stroke="currentColor" />
      <path d="M2.2 7.8 7.8 2.2" stroke="currentColor" />
    </svg>
  )
}

function RefusedDrop({ x, y, dragging }: { x: number; y: number; dragging: Dragging }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const hint = ref.current
    if (!hint) return
    const { width, height } = hint.getBoundingClientRect()
    const above = y - dragging.grabY - height - 12
    const below = y - dragging.grabY + dragging.height + 12
    hint.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - width - 8))}px`
    hint.style.top = `${Math.max(8, Math.min(above >= 8 ? above : below, window.innerHeight - height - 8))}px`
  }, [x, y, dragging])
  return (
    <span ref={ref} className={styles.refused}>
      <RefusedIcon />
      Can’t drop here
    </span>
  )
}

function SelectedTick() {
  return (
    <span className={styles.tick}>
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
        <path
          d="M1.5 4.7 3.6 6.8 7.5 2.4"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="3" cy="7" r="1.2" fill="currentColor" />
      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
      <circle cx="11" cy="7" r="1.2" fill="currentColor" />
    </svg>
  )
}

function DoneMenu({ count, onArchiveAll }: { count: number; onArchiveAll: () => void }) {
  const [open, setOpen] = useState(false)
  const close = useMemo(() => () => setOpen(false), [])
  const ref = usePopover(open, close)
  return (
    <span ref={ref} className={`${listStyles.menuAnchor} ${styles.columnMenu}`}>
      <button
        type="button"
        className={styles.columnMore}
        aria-label="Done column actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className={listStyles.menu} role="menu" aria-label="Done column actions">
          <button
            type="button"
            role="menuitem"
            className={listStyles.menuItem}
            disabled={count === 0}
            onClick={() => {
              close()
              onArchiveAll()
            }}
          >
            Archive all in Done…
          </button>
        </div>
      )}
    </span>
  )
}

export function Board({
  title,
  factoryId,
  factory,
  tasks,
  factories,
  queue,
  slots,
  settings,
  capLine,
  banners,
  filters,
  onFilters,
  onOpen,
  onOpenTask,
  onNewTask,
  onPlan,
  onShowAllDone,
}: {
  title: string
  factoryId: string
  factory: Factory | undefined
  tasks: readonly Task[]
  factories: readonly Factory[]
  queue: readonly QueuedForSlot[]
  slots?: RunSlots | undefined
  settings?: MachineSettings | undefined
  capLine?: string | undefined
  banners?: ReactNode
  filters: ListFilters
  onFilters: (filters: ListFilters) => void
  onOpen: (task: Task) => void
  onOpenTask: (ref: string) => void
  onNewTask: () => void
  onPlan: () => void
  onShowAllDone: () => void
}) {
  const now = useNow()
  const allStages = useStages()
  const stages = allStages.of(factoryId)
  const stagesLoaded = allStages.loaded(factoryId)
  const start = startStage(stages)
  const [text, setText] = useState('')
  const shown = filterTasks(tasks, filters, text)
  const columns = boardColumns(stages, shown, now)
  const allDone = tasks.filter((t) => t.stage === 'done' && !t.archived).length
  const [archivingDone, setArchivingDone] = useState(false)
  const [dragging, setDragging] = useState<Dragging>()
  const [target, setTarget] = useState<Target>()
  const [refused, setRefused] = useState<{ x: number; y: number }>()
  const chips = filterChips(filters, factories, undefined, allStages)
  const empty = boardEmpty(tasks, filters, text)
  const saved = boardViewFor(settings?.boardViews, factoryId)
  const [draft, setDraft] = useState<{ factoryId: string; view: BoardView }>()
  const view = draft?.factoryId === factoryId ? draft.view : saved
  const savedKey = JSON.stringify(saved)
  useEffect(() => {
    setDraft((current) =>
      current && JSON.stringify(current.view) === savedKey ? undefined : current,
    )
  }, [savedKey])
  const compact = view.cardSize === 'compact'
  const shows = (field: BoardField) => !compact && view.fields.includes(field)
  const isDragging = dragging !== undefined
  const [dropsShown, setDropsShown] = useState(false)
  // Chromium ends a drag when its source element moves during dragstart, so
  // an empty column that takes the drop is drawn one tick later.
  useEffect(() => {
    if (!isDragging) {
      setDropsShown(false)
      return
    }
    const timer = setTimeout(() => setDropsShown(true), 0)
    return () => clearTimeout(timer)
  }, [isDragging])
  const layout = boardLayout(
    columns,
    view,
    dragging && dropsShown
      ? (stage) => boardDrop(dragging.task, dragging.from, stage, start) !== undefined
      : undefined,
  )

  function changeView(next: BoardView) {
    setDraft({ factoryId, view: next })
    ted.updateSettings({ boardViews: { ...settings?.boardViews, [factoryId]: next } }).catch(report)
  }
  const gone = stagesLoaded && settings ? withoutGoneStages(saved, stages) : undefined
  const goneKey = gone ? JSON.stringify(gone) : undefined
  const latest = useRef({ settings, gone })
  latest.current = { settings, gone }
  useEffect(() => {
    const { settings: current, gone: next } = latest.current
    if (goneKey === undefined || next === undefined) return
    ted.updateSettings({ boardViews: { ...current?.boardViews, [factoryId]: next } }).catch(report)
  }, [goneKey, factoryId])
  const selectable = shown.filter((t) => !view.hiddenStages.includes(t.stage))
  const { selected, setSelected, anchor, setAnchor, toggle, clear } = useSelection(
    selectable,
    factoryId,
  )
  const chosen = selectable.filter((t) => selected.includes(t.id))

  const shownIds = selectable.map((t) => t.id).join('\n')
  useEffect(() => {
    const ids = new Set(shownIds.split('\n'))
    setSelected((current) => {
      const kept = current.filter((id) => ids.has(id))
      return kept.length === current.length ? current : kept
    })
  }, [shownIds, setSelected])

  function selectOnModifiedClick(event: MouseEvent<HTMLElement>, task: Task, column: BoardColumn) {
    if (event.shiftKey) {
      const inColumn = anchor !== undefined && column.tasks.some((t) => t.id === anchor)
      setSelected(columnSelection(selected, column.tasks, anchor, task.id))
      if (!inColumn) setAnchor(task.id)
    } else if (event.metaKey || event.ctrlKey) toggle(task.id)
    else return
    event.stopPropagation()
  }

  function onCardClick(event: MouseEvent<HTMLElement>, task: Task) {
    if (!(event.target as HTMLElement).closest('button[data-card-title]')) return
    clear()
    onOpen(task)
  }

  const menuFor = (task: Task) =>
    selected.includes(task.id) && chosen.length > 1 ? chosen.map((t) => t.id) : [task.id]

  function endDrag() {
    setDragging(undefined)
    setTarget(undefined)
    setRefused(undefined)
  }

  function onDragOver(event: DragEvent<HTMLElement>, column: BoardColumn) {
    if (!dragging) return
    const drop = boardDrop(dragging.task, dragging.from, column.stage, start)
    if (!drop) {
      event.dataTransfer.dropEffect = 'none'
      setTarget(undefined)
      setRefused({ x: event.clientX, y: event.clientY })
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setRefused(undefined)
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-task]')].filter(
      (card) => card.dataset.task !== dragging.task.displayId,
    )
    const index = cards.filter((card) => {
      const box = card.getBoundingClientRect()
      return box.top + box.height / 2 < event.clientY
    }).length
    const placement = placeCard(column, dragging.task, drop, index, start)
    if (
      target?.stage !== column.stage ||
      target.placement.index !== placement.index ||
      target.drop !== drop
    ) {
      setTarget({ stage: column.stage, drop, placement })
    }
  }

  async function onDrop() {
    const moving = dragging
    const landed = target
    endDrag()
    if (!moving || !landed) return
    const { task } = moving
    if (landed.drop === 'start') await startTask(task)
    if (landed.drop === 'unstart') await ted.moveToBacklog(task.id)
    const { after, before } = landed.placement
    if (after === undefined && before === undefined) return
    await ted.moveTask(task.id, {
      ...(after !== undefined && { after }),
      ...(before !== undefined && { before }),
    })
  }

  function dropSlot(column: BoardColumn) {
    if (!dragging || target?.stage !== column.stage) return null
    if (target.drop === 'reorder') return <div key="slot" className={styles.reorderSlot} />
    return (
      <div key="slot" className={styles.dropSlot}>
        {target.drop === 'start' ? (
          <>
            <span className={styles.dropTitle}>Drop to start</span>
            <span>
              Joins the queue as Queued ·{' '}
              {ordinal(startPlace(target.placement, dragging.task, queue))}
            </span>
          </>
        ) : (
          <span className={styles.dropTitle}>Drop to move back to Backlog</span>
        )}
      </div>
    )
  }

  function columnState(column: BoardColumn): 'own' | 'target' | 'no' | undefined {
    if (!dragging) return undefined
    if (column.stage === dragging.from)
      return boardDrop(dragging.task, dragging.from, column.stage, start) ? 'own' : 'no'
    return boardDrop(dragging.task, dragging.from, column.stage, start) ? 'target' : 'no'
  }

  function openOnEnter(event: KeyboardEvent<HTMLElement>, task: Task) {
    if (event.key !== 'Enter' || event.target !== event.currentTarget) return
    event.preventDefault()
    onOpen(task)
  }

  function card(task: Task, column: BoardColumn) {
    const activity = cardActivity(task, now)
    const startable = canStart(task) && start !== undefined
    const isSelected = selected.includes(task.id)
    return (
      <article
        key={task.id}
        aria-label={`${task.displayId} ${task.title}`}
        {...contextMenu((at) => openTaskActions(at, menuFor(task)))}
        data-task={task.displayId}
        data-nav-item
        data-selected={isSelected || undefined}
        {...selectionTarget(task.displayId)}
        tabIndex={-1}
        onKeyDown={(event) => openOnEnter(event, task)}
        onClickCapture={(event) => selectOnModifiedClick(event, task, column)}
        onClick={(event) => onCardClick(event, task)}
        className={[
          styles.card,
          compact ? styles.compact : '',
          dragging?.task.id === task.id ? styles.dragged : '',
          isSelected ? styles.selected : '',
        ].join(' ')}
        draggable={!task.archived}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', task.displayId)
          const box = event.currentTarget.getBoundingClientRect()
          const grabY = event.clientY - box.top
          event.dataTransfer.setDragImage(event.currentTarget, event.clientX - box.left, grabY)
          setDragging({ task, from: column.stage, grabY, height: box.height })
        }}
        onDragEnd={endDrag}
      >
        {compact ? (
          <>
            <span className={styles.compactTop}>
              <span className={styles.cardId}>{task.displayId}</span>
              <button
                type="button"
                data-card-title
                className={`${styles.cardTitle} ${styles.compactTitle}`}
              >
                {task.title}
              </button>
              {isSelected && <SelectedTick />}
            </span>
            <TaskStatusChips task={task} onOpenTask={onOpenTask} />
          </>
        ) : (
          <>
            <span className={styles.cardTop}>
              {shows('priority') && <PriorityButton task={task} />}
              <span className={styles.cardId}>{task.displayId}</span>
              <span className={styles.cardEnd}>
                {isSelected && <SelectedTick />}
                {startable ? (
                  <button
                    type="button"
                    className={styles.start}
                    aria-label={`Start ${task.displayId}`}
                    title="Start"
                    onClick={() => {
                      startTask(task).catch(report)
                    }}
                  >
                    <PlayIcon />
                  </button>
                ) : (
                  <RunIcons runs={task.runs} stacked />
                )}
              </span>
            </span>
            <button type="button" data-card-title className={styles.cardTitle}>
              {task.title}
            </button>
            {shows('hierarchy') && <HierarchyMarker task={task} tasks={tasks} />}
            <TaskStatusWithSubAgents
              task={shows('blockers') ? task : withoutBlockers(task)}
              subAgents={shows('sub-agents')}
              onOpenTask={onOpenTask}
            />
            {shows('activity') && activity !== undefined && (
              <span className={styles.cardActivity} title={statusDetail(task.status)}>
                {activity}
              </span>
            )}
          </>
        )}
      </article>
    )
  }

  function doneCard(task: Task, column: BoardColumn) {
    const isSelected = selected.includes(task.id)
    return (
      <article
        key={task.id}
        aria-label={`${task.displayId} ${task.title}`}
        {...contextMenu((at) => openTaskActions(at, menuFor(task)))}
        data-task={task.displayId}
        data-nav-item
        data-selected={isSelected || undefined}
        {...selectionTarget(task.displayId)}
        tabIndex={-1}
        onKeyDown={(event) => openOnEnter(event, task)}
        onClickCapture={(event) => selectOnModifiedClick(event, task, column)}
        onClick={(event) => onCardClick(event, task)}
        className={[styles.card, styles.doneCard, isSelected ? styles.selected : ''].join(' ')}
      >
        <button type="button" data-card-title className={`${styles.cardTitle} ${styles.doneTitle}`}>
          {task.title}
        </button>
        <span className={styles.cardActivity}>{doneCardLine(task, now)}</span>
      </article>
    )
  }

  function cards(column: BoardColumn) {
    if (column.stage === 'done') {
      return [
        ...column.tasks.map((task) => doneCard(task, column)),
        ...((column.allDone ?? 0) > 0
          ? [
              <button
                key="show-all"
                type="button"
                className={styles.showAll}
                onClick={onShowAllDone}
              >
                {`Show all ${column.allDone} →`}
              </button>,
            ]
          : []),
      ]
    }
    const items: ReactNode[] = []
    let at = 0
    for (const task of column.tasks) {
      const moving = dragging?.task.id === task.id
      if (!moving && target?.stage === column.stage && target.placement.index === at) {
        items.push(dropSlot(column))
      }
      items.push(card(task, column))
      if (!moving) at++
    }
    if (target?.stage === column.stage && target.placement.index === at)
      items.push(dropSlot(column))
    if (items.length === 0 && column.turnedOff && isCleanup(column.stage))
      items.push(
        <p key="off" className={styles.columnNote}>
          Cleanup is off for this Factory.
        </p>,
      )
    return items
  }

  return (
    <section className={views.pane} aria-label={title}>
      <header className={views.header}>
        <h1 className={views.title}>
          {factory && <FactoryIcon factory={factory} size={20} className={views.titleIcon} />}
          {title}
          <span className={styles.crumbSlash}>/</span>
          <span className={styles.crumb}>Board</span>
        </h1>
        {capLine !== undefined && <span className={styles.capLine}>{capLine}</span>}
        <span className={views.headerSpacer} />
        <MenuButton label="Filter" icon={<FilterIcon />} badge={activeFilterCount(filters)}>
          {() => (
            <FilterMenu
              filters={filters}
              tasks={tasks}
              factories={factories}
              allTasks={false}
              board
              onChange={onFilters}
            />
          )}
        </MenuButton>
        <MenuButton label="Display" icon={<DisplayIcon />}>
          {() => (
            <>
              <div className={listStyles.menuHeading}>Card size</div>
              <fieldset className={listStyles.segments} aria-label="Card size">
                {boardCardSizes.map((cardSize) => (
                  <button
                    key={cardSize}
                    type="button"
                    role="menuitemradio"
                    aria-checked={view.cardSize === cardSize}
                    className={listStyles.segment}
                    onClick={() => changeView({ ...view, cardSize })}
                  >
                    {cardSizeLabels[cardSize]}
                  </button>
                ))}
              </fieldset>
              <div className={listStyles.menuHeading}>Card fields</div>
              {boardFields.map((field) => (
                <CheckItem
                  key={field}
                  label={fieldLabels[field]}
                  checked={view.fields.includes(field)}
                  disabled={compact}
                  onChange={() => changeView({ ...view, fields: toggled(view.fields, field) })}
                />
              ))}
              {compact && (
                <div className={styles.menuNote}>
                  Compact cards show the ID, title and status only.
                </div>
              )}
              <div className={listStyles.menuDivider} />
              <div className={listStyles.menuHeading}>Columns</div>
              {columns.map((column) => (
                <CheckItem
                  key={column.stage}
                  label={column.name}
                  checked={!view.hiddenStages.includes(column.stage)}
                  count={column.tasks.length}
                  onChange={() =>
                    changeView({
                      ...view,
                      hiddenStages: toggled(view.hiddenStages, column.stage),
                    })
                  }
                />
              ))}
              <div className={listStyles.menuDivider} />
              <CheckItem
                label="Hide empty columns"
                checked={view.hideEmpty}
                onChange={() => changeView({ ...view, hideEmpty: !view.hideEmpty })}
              />
            </>
          )}
        </MenuButton>
        <Button variant="primary" onClick={onNewTask}>
          <PlusIcon />
          New Task…
        </Button>
      </header>
      {banners}
      {factory?.setup && <SetupPanel factory={factory} setup={factory.setup} />}
      <div className={listStyles.toolbar}>
        <label className={listStyles.search}>
          <SearchIcon />
          <input
            type="search"
            data-filter-box
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
          <kbd className={listStyles.slash}>/</kbd>
        </label>
        {chips.map((chip) => (
          <span key={chip.key} className={listStyles.chip}>
            {chip.label}
            <button
              type="button"
              className={listStyles.chipClear}
              aria-label={`Clear ${chip.label}`}
              onClick={() => onFilters(chip.clear(filters))}
            >
              <CloseIcon size={10} />
            </button>
          </span>
        ))}
        <span className={views.headerSpacer} />
        <span className={listStyles.summary}>
          <SubAgentTotal tasks={shown} filtered={text !== '' || chips.length > 0} />
        </span>
      </div>
      <div className={styles.boardArea}>
        <div
          className={`${styles.board} ${chosen.length > 0 ? styles.selecting : ''}`}
          data-rank-order
        >
          {layout.columns.map((column) => {
            const state = columnState(column)
            return (
              <section
                key={column.stage}
                data-stage={column.stage}
                data-nav-column
                data-drop={state}
                className={[
                  styles.column,
                  column.turnedOff ? styles.turnedOff : '',
                  state ? styles[state] : '',
                ].join(' ')}
                aria-label={column.name}
                onDragOver={(event) => onDragOver(event, column)}
                onDrop={(event) => {
                  event.preventDefault()
                  onDrop().catch(report)
                }}
              >
                <h2 className={styles.columnTitle}>
                  {column.name}
                  <span className={styles.columnCount}>{column.tasks.length}</span>
                  {column.gate && (
                    <span className={styles.gate}>
                      <LockIcon />
                      Sign-off
                    </span>
                  )}
                  {column.turnedOff && (
                    <span className={styles.turnedOffTag}>
                      {column.removed ? 'Not in Workflow' : 'Turned off'}
                    </span>
                  )}
                  {column.stage === 'done' && (
                    <DoneMenu count={allDone} onArchiveAll={() => setArchivingDone(true)} />
                  )}
                </h2>
                {cards(column)}
              </section>
            )
          })}
          {layout.hidden.length > 0 && (
            <aside className={styles.hiddenColumns} aria-label="Hidden columns">
              <h2 className={styles.hiddenTitle}>Hidden columns</h2>
              {layout.hidden.map(({ stage, name, count, needsYou }) => (
                <button
                  key={stage}
                  type="button"
                  className={styles.hiddenRow}
                  data-nav-item
                  title={`Show ${name}`}
                  onClick={() =>
                    changeView({ ...view, hiddenStages: without(view.hiddenStages, stage) })
                  }
                >
                  <span>{name}</span>
                  <span className={styles.columnCount}>{count}</span>
                  {needsYou > 0 && (
                    <span className={styles.needsYou}>
                      {needsYou === 1 ? '1 needs you' : `${needsYou} need you`}
                    </span>
                  )}
                </button>
              ))}
            </aside>
          )}
        </div>
        <SelectionBar
          scope={factoryId}
          chosen={chosen}
          allTasks={tasks}
          slots={slots}
          settings={settings}
          onSelect={setSelected}
        />
        {empty === 'no-tasks' && (
          <div className={styles.emptyOverlay}>
            <EmptyState
              card
              title="No Tasks yet"
              help="A Task is one piece of work that agents carry through this Factory’s Stages, from request to merge. Plan helps split a piece of work too big for one Task."
            >
              <Button variant="primary" onClick={onNewTask}>
                New Task…
              </Button>
              <Button onClick={onPlan}>Plan…</Button>
            </EmptyState>
          </div>
        )}
        {empty === 'no-matches' && (
          <div className={styles.emptyOverlay}>
            <EmptyState card title="No Tasks match these filters">
              <Button
                onClick={() => {
                  setText('')
                  onFilters({})
                }}
              >
                Clear filters
              </Button>
            </EmptyState>
          </div>
        )}
      </div>
      {archivingDone && (
        <ArchiveDoneDialog
          factoryId={factoryId}
          count={allDone}
          onClose={() => setArchivingDone(false)}
        />
      )}
      {refused && dragging && <RefusedDrop x={refused.x} y={refused.y} dragging={dragging} />}
    </section>
  )
}
