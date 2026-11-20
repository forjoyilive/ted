import type { Factory, Task } from '@ted/protocol'
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { blockerMap, linkRefusal, type MapLink } from '../blocker-map.ts'
import { useStartsOnItsOwn } from '../components/BacklogStarts.tsx'
import { Button } from '../components/Button.tsx'
import { contextMenu } from '../components/ContextMenu.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { FactoryIcon, FactoryName } from '../components/FactoryIcon.tsx'
import { CloseIcon, PlusIcon } from '../components/icons.tsx'
import { Loading } from '../components/Loading.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { TaskStatusWithSubAgents } from '../components/SubAgentCount.tsx'
import { openTaskActions } from '../components/TaskContextMenu.tsx'
import { useStages } from '../stages.tsx'
import { readableError, ted } from '../ted.ts'
import boardStyles from './Board.module.css'
import styles from './TaskMap.module.css'
import { factoryName } from './TaskViews.tsx'
import views from './views.module.css'

const cardWidth = 232
const cardHeight = 128
const columnGap = 84
const rowGap = 18
const edge = 28
const noticeMs = 6000

interface Drag {
  from: Task
  startX: number
  startY: number
  x: number
  y: number
  over?: Task
}

interface Notice {
  text: string
  undo?: () => Promise<unknown>
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`
}

export function TaskMap({
  title,
  factoryId,
  tasks,
  loaded = true,
  factories,
  banners,
  onOpen,
  onOpenTask,
  onNewTask,
}: {
  title: string
  factoryId: string
  tasks: readonly Task[]
  loaded?: boolean
  factories: readonly Factory[]
  banners?: ReactNode
  onOpen: (task: Task) => void
  onOpenTask: (ref: string) => void
  onNewTask: () => void
}) {
  const stages = useStages()
  const startsOnItsOwn = useStartsOnItsOwn()
  const map = useMemo(() => blockerMap(tasks, factoryId), [tasks, factoryId])
  const [sideOpen, setSideOpen] = useState(false)
  const [hot, setHot] = useState<string>()
  const [drag, setDragState] = useState<Drag>()
  const live = useRef<Drag>(undefined)
  const setDrag = (next: (drag: Drag | undefined) => Drag | undefined) => {
    live.current = next(live.current)
    setDragState(live.current)
  }
  const [notice, setNotice] = useState<Notice>()
  const dragging = drag !== undefined
  const names = new Map(tasks.map((t) => [t.id, t.displayId]))
  const name = (id: string) => names.get(id) ?? id

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), noticeMs)
    return () => clearTimeout(timer)
  }, [notice])

  function refusal(from: Task, to: Task): string | undefined {
    if (to.factoryId !== factoryId) {
      return `Change ${to.displayId}’s blockers in ${factoryName(factories, to.factoryId)}`
    }
    return linkRefusal(tasks, from.id, to.id)
  }

  function change(request: Promise<unknown>, done: Notice) {
    request
      .then(() => setNotice(done))
      .catch((failure: unknown) => setNotice({ text: readableError(failure) }))
  }

  function remove(link: MapLink) {
    setHot(undefined)
    change(ted.unblockTask(link.blocked, link.blocker), {
      text: `${name(link.blocked)} no longer waits for ${name(link.blocker)}`,
      undo: () => ted.blockTask(link.blocked, link.blocker),
    })
  }

  function add(blocker: Task, blocked: Task) {
    change(ted.blockTask(blocked.id, blocker.id), {
      text: `${blocked.displayId} now waits for ${blocker.displayId}`,
      undo: () => ted.unblockTask(blocked.id, blocker.id),
    })
  }

  const drop = useRef<() => void>(() => undefined)
  drop.current = () => {
    const ended = live.current
    setDrag(() => undefined)
    if (ended?.over && refusal(ended.from, ended.over) === undefined) add(ended.from, ended.over)
  }

  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent) => {
      live.current = live.current && { ...live.current, x: event.clientX, y: event.clientY }
      setDragState(live.current)
    }
    const end = () => drop.current()
    const stop = () => {
      live.current = undefined
      setDragState(undefined)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging])

  function openOnEnter(event: KeyboardEvent<HTMLElement>, task: Task) {
    if (event.key !== 'Enter' || event.target !== event.currentTarget) return
    event.preventDefault()
    onOpen(task)
  }

  function card(task: Task, at?: CSSProperties) {
    const other = task.factoryId !== factoryId
    const done = task.stage === 'done'
    const source = drag?.from.id === task.id
    const refused = !source && drag?.over?.id === task.id && refusal(drag.from, task) !== undefined
    const target = !source && drag?.over?.id === task.id && !refused
    return (
      <article
        key={task.id}
        aria-label={`${task.displayId} ${task.title}`}
        {...(other ? {} : contextMenu((point) => openTaskActions(point, [task.id])))}
        data-task={task.displayId}
        data-nav-item
        tabIndex={-1}
        style={at}
        onKeyDown={(event) => openOnEnter(event, task)}
        onPointerMove={() =>
          setDrag((d) => (d && d.over?.id !== task.id ? { ...d, over: task } : d))
        }
        onPointerLeave={() =>
          setDrag((d) => {
            if (d?.over?.id !== task.id) return d
            const { over: _, ...rest } = d
            return rest
          })
        }
        className={[
          boardStyles.card,
          styles.card,
          at ? styles.placed : '',
          done ? styles.done : '',
          other ? styles.other : '',
          target ? styles.target : '',
          refused ? styles.refused : '',
          source ? styles.source : '',
        ].join(' ')}
      >
        <span className={boardStyles.cardTop}>
          <PriorityIcon priority={task.priority} />
          <span className={boardStyles.cardId}>{task.displayId}</span>
          {other && (
            <span className={styles.factory}>
              <FactoryName factories={factories} factoryId={task.factoryId} />
            </span>
          )}
          <span className={styles.stage}>{stages.name(task.stage, task.factoryId)}</span>
        </span>
        <button
          type="button"
          className={`${boardStyles.cardTitle} ${styles.title}`}
          title={task.title}
          onClick={() => onOpen(task)}
        >
          {task.title}
        </button>
        {!done && (
          <span className={styles.status}>
            <TaskStatusWithSubAgents
              task={task}
              onOpenTask={onOpenTask}
              startsAutomatically={startsOnItsOwn(task)}
            />
          </span>
        )}
        {!other && (
          <button
            type="button"
            className={styles.handle}
            aria-label={`Drag to the Task that should wait for ${task.displayId}`}
            title="Drag to the Task that should wait for this one"
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              const box = event.currentTarget.getBoundingClientRect()
              const startX = box.left + box.width / 2
              const startY = box.top + box.height / 2
              setDrag(() => ({ from: task, startX, startY, x: event.clientX, y: event.clientY }))
            }}
          />
        )}
      </article>
    )
  }

  const place = new Map(
    map.cards.map((c) => [
      c.task.id,
      {
        left: edge + c.column * (cardWidth + columnGap),
        top: edge + c.row * (cardHeight + rowGap),
        width: cardWidth,
        height: cardHeight,
      },
    ]),
  )
  const size = {
    width: edge * 2 + Math.max(1, map.columns) * (cardWidth + columnGap) - columnGap,
    height: edge * 2 + map.rows * (cardHeight + rowGap) - rowGap,
  }
  const lines = map.links.flatMap((link) => {
    const from = place.get(link.blocker)
    const to = place.get(link.blocked)
    if (!from || !to) return []
    const x1 = from.left + cardWidth
    const y1 = from.top + cardHeight / 2
    const y2 = to.top + cardHeight / 2
    const label = `Remove blocker: ${name(link.blocked)} stops waiting for ${name(link.blocker)}`
    return [
      {
        link,
        key: `${link.blocker}>${link.blocked}`,
        d: curve(x1, y1, to.left, y2),
        x: (x1 + to.left) / 2,
        y: (y1 + y2) / 2,
        label,
      },
    ]
  })
  const dragHint =
    drag &&
    (drag.over
      ? (refusal(drag.from, drag.over) ??
        `${drag.over.displayId} will wait for ${drag.from.displayId}`)
      : `Drop on the Task that should wait for ${drag.from.displayId}`)
  const dragRefused = drag?.over !== undefined && refusal(drag.from, drag.over) !== undefined
  const scopeFactory = factories.find((f) => f.id === factoryId)

  return (
    <section className={views.pane} aria-label={title}>
      <header className={views.header}>
        <h1 className={views.title}>
          {scopeFactory && (
            <FactoryIcon factory={scopeFactory} size={20} className={views.titleIcon} />
          )}
          {title}
          <span className={boardStyles.crumbSlash}>/</span>
          <span className={boardStyles.crumb}>Map</span>
        </h1>
        <span className={views.headerSpacer} />
        <Button size="small" aria-pressed={sideOpen} onClick={() => setSideOpen((open) => !open)}>
          Tasks with no blockers
        </Button>
        <Button size="small" variant="primary" onClick={onNewTask}>
          <PlusIcon />
          New Task…
        </Button>
      </header>
      {banners}
      <p className={styles.hint}>
        Tasks run left to right: a Task waits for every Task with a line into it. Hover a line and
        click its ✕ to remove that blocker. Drag from the dot on a Task’s right edge to the Task
        that should wait for it.
      </p>
      <div className={`${styles.body} ${dragging ? styles.dragging : ''}`}>
        <div className={styles.area}>
          <div className={styles.canvas} style={size} data-blocker-map>
            <svg className={styles.lines} aria-hidden>
              <defs>
                <marker
                  id="blocker-map-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M1 1 7 4 1 7" className={styles.arrow} />
                </marker>
              </defs>
              {lines.map(({ link, key, d, label }) => (
                <g key={key} data-link={key}>
                  <path
                    d={d}
                    markerEnd="url(#blocker-map-arrow)"
                    className={[
                      styles.line,
                      link.muted ? styles.muted : '',
                      hot === key ? styles.hot : '',
                    ].join(' ')}
                  />
                  <path
                    d={d}
                    className={styles.hit}
                    onPointerEnter={() => setHot(key)}
                    onPointerLeave={() => setHot((h) => (h === key ? undefined : h))}
                  >
                    <title>{label}</title>
                  </path>
                </g>
              ))}
            </svg>
            {lines.map(({ link, key, x, y, label }) => (
              <button
                key={key}
                type="button"
                className={`${styles.remove} ${hot === key ? styles.shown : ''}`}
                style={{ left: x, top: y }}
                aria-label={label}
                title={label}
                onPointerEnter={() => setHot(key)}
                onPointerLeave={() => setHot((h) => (h === key ? undefined : h))}
                onFocus={() => setHot(key)}
                onBlur={() => setHot((h) => (h === key ? undefined : h))}
                onClick={() => remove(link)}
              >
                <CloseIcon size={10} />
              </button>
            ))}
            {map.cards.map((c) => card(c.task, place.get(c.task.id)))}
          </div>
          {!loaded && (
            <div className={boardStyles.emptyOverlay}>
              <Loading label="Loading Tasks…" />
            </div>
          )}
          {loaded && map.links.length === 0 && (
            <div className={boardStyles.emptyOverlay}>
              <EmptyState
                card
                title="No blockers in this Factory"
                help="When one Task has to merge before another can start, the two appear here with a line between them."
              >
                {!sideOpen && (
                  <Button size="small" onClick={() => setSideOpen(true)}>
                    Show Tasks with no blockers
                  </Button>
                )}
              </EmptyState>
            </div>
          )}
        </div>
        {sideOpen && (
          <aside className={styles.side} aria-label="Tasks with no blockers">
            <h2 className={styles.sideTitle}>
              No blockers
              <span className={boardStyles.columnCount}>{map.unlinked.length}</span>
            </h2>
            <p className={styles.sideLine}>
              These Tasks wait for nothing and nothing waits for them. Drag between here and the map
              to add a blocker.
            </p>
            {map.unlinked.map((task) => card(task))}
          </aside>
        )}
      </div>
      {drag && (
        <>
          <svg className={styles.overlay} aria-hidden>
            <path
              d={curve(drag.startX, drag.startY, drag.x, drag.y)}
              className={`${styles.dragLine} ${dragRefused ? styles.dragRefused : ''}`}
            />
          </svg>
          <span
            className={styles.dragHint}
            role="status"
            style={{ left: drag.x + 14, top: drag.y + 16 }}
          >
            {dragHint}
          </span>
        </>
      )}
      {notice && (
        <div className={styles.notice} role="status">
          <span>{notice.text}</span>
          {notice.undo && (
            <button
              type="button"
              className={styles.undo}
              onClick={() => {
                const undo = notice.undo
                setNotice(undefined)
                undo?.().catch((failure: unknown) => setNotice({ text: readableError(failure) }))
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </section>
  )
}
