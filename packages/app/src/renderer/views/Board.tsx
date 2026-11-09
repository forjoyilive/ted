import type { BoardStage, Factory, ListFilters, QueuedForSlot, StageId, Task } from '@ted/protocol'
import { type DragEvent, type ReactNode, useEffect, useState } from 'react'
import {
  type BoardColumn,
  type BoardDrop,
  boardColumns,
  boardDrop,
  builtInStages,
  canStart,
  cardActivity,
  type Placement,
  placeCard,
  startPlace,
  startStage,
} from '../board.ts'
import { Button } from '../components/Button.tsx'
import { CloseIcon, PlusIcon } from '../components/icons.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { ordinal, RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import { activeFilterCount, filterChips, filterTasks, stageName } from '../list-view.ts'
import { useNow } from '../requests.ts'
import { ted } from '../ted.ts'
import styles from './Board.module.css'
import listStyles from './TaskList.module.css'
import { FilterIcon, FilterMenu, MenuButton } from './TaskList.tsx'
import { SetupPanel } from './TaskViews.tsx'
import views from './views.module.css'

interface Dragging {
  task: Task
  from: StageId
}

interface Target {
  stage: StageId
  drop: BoardDrop
  placement: Placement
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

function useBoardStages(factoryId: string, stagesInUse: string): readonly BoardStage[] {
  const [loaded, setLoaded] = useState<{ factoryId: string; stages: BoardStage[] }>()
  useEffect(() => {
    void stagesInUse
    let live = true
    ted
      .factoryBoard(factoryId)
      .then((board) => {
        if (live) setLoaded({ factoryId, stages: board.stages })
      })
      .catch(report)
    return () => {
      live = false
    }
  }, [factoryId, stagesInUse])
  return loaded?.factoryId === factoryId ? loaded.stages : builtInStages
}

export function Board({
  title,
  factoryId,
  factory,
  tasks,
  factories,
  queue,
  capLine,
  banners,
  filters,
  onFilters,
  onOpen,
  onOpenTask,
  onNewTask,
  onPlan,
}: {
  title: string
  factoryId: string
  factory: Factory | undefined
  tasks: readonly Task[]
  factories: readonly Factory[]
  queue: readonly QueuedForSlot[]
  capLine?: string | undefined
  banners?: ReactNode
  filters: ListFilters
  onFilters: (filters: ListFilters) => void
  onOpen: (task: Task) => void
  onOpenTask: (ref: string) => void
  onNewTask: () => void
  onPlan: () => void
}) {
  const now = useNow()
  const inUse = [...new Set(tasks.filter((t) => !t.archived).map((t) => t.stage))].sort().join()
  const stages = useBoardStages(factoryId, inUse)
  const start = startStage(stages)
  const columns = boardColumns(stages, filterTasks(tasks, filters))
  const [dragging, setDragging] = useState<Dragging>()
  const [target, setTarget] = useState<Target>()
  const [refused, setRefused] = useState<{ x: number; y: number }>()
  const chips = filterChips(filters, factories)

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
    if (landed.drop === 'start') await ted.startTask(task.id)
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
            <span className={styles.dropTitle}>Drop to Start</span>
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

  function card(task: Task, column: BoardColumn) {
    const activity = cardActivity(task, now)
    const startable = canStart(task) && start !== undefined
    return (
      <article
        key={task.id}
        aria-label={`${task.displayId} ${task.title}`}
        data-task={task.displayId}
        className={`${styles.card} ${dragging?.task.id === task.id ? styles.dragged : ''}`}
        draggable={!task.archived}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', task.displayId)
          setDragging({ task, from: column.stage })
        }}
        onDragEnd={endDrag}
      >
        <span className={styles.cardTop}>
          <PriorityIcon priority={task.priority} />
          <span className={styles.cardId}>{task.displayId}</span>
          <span className={styles.cardEnd}>
            {startable ? (
              <button
                type="button"
                className={styles.start}
                aria-label={`Start ${task.displayId}`}
                title="Start"
                onClick={() => {
                  ted.startTask(task.id).catch(report)
                }}
              >
                <PlayIcon />
              </button>
            ) : (
              <RunIcons runs={task.runs} stacked />
            )}
          </span>
        </span>
        <button type="button" className={styles.cardTitle} onClick={() => onOpen(task)}>
          {task.title}
        </button>
        <TaskStatusChips task={task} onOpenTask={onOpenTask} />
        {activity !== undefined && <span className={styles.cardActivity}>{activity}</span>}
      </article>
    )
  }

  function cards(column: BoardColumn) {
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
    return items
  }

  return (
    <section className={views.pane} aria-label={title}>
      <header className={views.header}>
        <h1 className={views.title}>
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
        <Button size="small" onClick={onPlan}>
          Plan
        </Button>
        <Button size="small" variant="primary" onClick={onNewTask}>
          <PlusIcon />
          New Task
        </Button>
      </header>
      {banners}
      {factory?.setup && <SetupPanel factory={factory} setup={factory.setup} />}
      {chips.length > 0 && (
        <div className={listStyles.toolbar}>
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
        </div>
      )}
      <div className={styles.board}>
        {columns.map((column) => {
          const state = columnState(column)
          return (
            <section
              key={column.stage}
              data-stage={column.stage}
              data-drop={state}
              className={[
                styles.column,
                column.turnedOff ? styles.turnedOff : '',
                state ? styles[state] : '',
              ].join(' ')}
              aria-label={stageName(column.stage)}
              onDragOver={(event) => onDragOver(event, column)}
              onDrop={(event) => {
                event.preventDefault()
                onDrop().catch(report)
              }}
            >
              <h2 className={styles.columnTitle}>
                {stageName(column.stage)}
                <span className={styles.columnCount}>{column.tasks.length}</span>
                {column.gate && (
                  <span className={styles.gate}>
                    <LockIcon />
                    Gate
                  </span>
                )}
                {column.turnedOff && <span className={styles.turnedOffTag}>Turned off</span>}
              </h2>
              {cards(column)}
            </section>
          )
        })}
      </div>
      {refused && (
        <span className={styles.refused} style={{ left: refused.x + 12, top: refused.y + 12 }}>
          <RefusedIcon />
          Can’t drop here
        </span>
      )}
    </section>
  )
}
