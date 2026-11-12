import {
  maxShellPanes,
  type ShellChange,
  type ShellLayout,
  type ShellWorkspace,
} from '@ted/protocol/shell'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useConnection } from '../data.ts'
import { openInEditor } from '../editor.ts'
import { readableError, ted } from '../ted.ts'
import dialogStyles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import styles from './TaskShell.module.css'
import { TaskShellPane } from './TaskShellPane.tsx'

const initialSize = { cols: 80, rows: 24 }

export function TaskShell({
  taskId,
  repo,
  onBack,
}: {
  taskId: string
  repo: string
  onBack: () => void
}) {
  const { epoch } = useConnection()
  const [workspace, setWorkspace] = useState<ShellWorkspace>()
  const [active, setActive] = useState<string>()
  const [focus, setFocus] = useState<{ id: string; sequence: number }>()
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ id: string; kind: 'close' | 'restart' }>()
  const alive = useRef(false)

  useEffect(() => {
    void epoch
    alive.current = true
    let closed = false
    setProblem(undefined)
    const load = async () => {
      try {
        const opened = await ted.openShellWorkspace(taskId, repo, initialSize)
        if (!closed) setWorkspace(opened)
      } catch (error) {
        if (!closed) setProblem(readableError(error))
      }
    }
    void load()
    return () => {
      closed = true
      alive.current = false
    }
  }, [taskId, repo, epoch])

  const refresh = () => {
    void ted
      .shellWorkspace(taskId, repo)
      .then((next) => {
        if (alive.current) setWorkspace(next)
      })
      .catch((error: unknown) => {
        if (alive.current) setProblem(readableError(error))
      })
  }

  const focusPane = (id: string | undefined) => {
    setActive(id)
    if (id) setFocus((last) => ({ id, sequence: (last?.sequence ?? 0) + 1 }))
  }

  const change = async (request: ShellChange) => {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    try {
      const next = await ted.changeShellWorkspace(taskId, repo, request)
      if (!alive.current) return
      setWorkspace(next)
      if (request.kind === 'split') {
        const added = next.shells.find((s) => !workspace?.shells.some((old) => old.id === s.id))
        if (added) focusPane(added.id)
      } else if (request.kind === 'close') {
        const neighbor = workspace?.layout
          ? neighborOf(workspace.layout, request.shellId)
          : undefined
        focusPane(next.shells.some((s) => s.id === neighbor) ? neighbor : next.shells[0]?.id)
      }
    } catch (error) {
      if (alive.current) {
        setProblem(readableError(error))
        refresh()
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const confirmAction = async () => {
    if (!confirm || !workspace || busy) return
    const action = confirm
    setConfirm(undefined)
    if (action.kind === 'close') {
      await change({ kind: 'close', revision: workspace.revision, shellId: action.id })
    } else {
      setBusy(true)
      setProblem(undefined)
      try {
        await ted.restartShell(taskId, repo, initialSize, action.id)
        if (alive.current) {
          focusPane(action.id)
          refresh()
        }
      } catch (error) {
        if (alive.current) setProblem(readableError(error))
      } finally {
        if (alive.current) setBusy(false)
      }
    }
  }

  const selected = workspace?.shells.some((s) => s.id === active)
    ? active
    : workspace?.shells[0]?.id
  const numbers = new Map(workspace?.shells.map((s, i) => [s.id, i + 1]))
  const draw = (shellId: string): ReactNode => {
    const shell = workspace?.shells.find((s) => s.id === shellId)
    return (
      shell && (
        <TaskShellPane
          taskId={taskId}
          repo={repo}
          shell={shell}
          number={numbers.get(shell.id) ?? 1}
          active={selected === shell.id}
          focusRequest={focus?.id === shell.id ? focus.sequence : 0}
          canSplit={!busy && (workspace?.shells.length ?? 0) < maxShellPanes}
          onFocus={() => setActive(shell.id)}
          onSplit={(direction) => {
            if (workspace)
              void change({
                kind: 'split',
                revision: workspace.revision,
                shellId: shell.id,
                direction,
                size: initialSize,
              })
          }}
          onClose={() => {
            if (!busy) setConfirm({ id: shell.id, kind: 'close' })
          }}
          onRestart={() => {
            if (!busy) setConfirm({ id: shell.id, kind: 'restart' })
          }}
          onMissing={refresh}
        />
      )
    )
  }

  return (
    <section className={styles.pane} aria-label="Shell">
      <button type="button" className={styles.back} onClick={onBack}>
        ← Task Lead
      </button>
      <header className={styles.header}>
        <span className={styles.repo}>{repo}</span>
        {workspace?.shells[0] && (
          <code className={styles.path} title={workspace.shells[0].path}>
            {workspace.shells[0].path}
          </code>
        )}
        <span className={styles.spacer} />
        <Button
          size="small"
          onClick={() => {
            void openInEditor({ taskId, repo }).catch((error: unknown) =>
              setProblem(readableError(error)),
            )
          }}
        >
          Open in editor
        </Button>
      </header>
      {problem && (
        <p className={styles.notice} role="status">
          {problem}
        </p>
      )}
      {workspace?.layout ? (
        <ShellLayoutView
          layout={workspace.layout}
          disabled={busy}
          renderPane={draw}
          onRatio={(branchId, ratio) =>
            change({ kind: 'ratio', revision: workspace.revision, branchId, ratio })
          }
        />
      ) : (
        <div className={styles.workspace}>
          <div className={styles.empty}>
            {workspace ? (
              <>
                <p>No shells are open.</p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void ted
                      .openShellWorkspace(taskId, repo, initialSize, true)
                      .then(setWorkspace)
                      .catch((error: unknown) => setProblem(readableError(error)))
                      .finally(() => setBusy(false))
                  }}
                >
                  Open Shell
                </Button>
              </>
            ) : (
              <p>{problem ? 'The shells could not be opened.' : 'Opening shells…'}</p>
            )}
          </div>
        </div>
      )}
      {confirm && (
        <Dialog onClose={() => setConfirm(undefined)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                {confirm.kind === 'close' ? 'Close' : 'Restart'} Shell {numbers.get(confirm.id)}?
              </h2>
              <p className={dialogStyles.body}>
                This ends this shell and its jobs. Programs that detached into separate sessions may
                keep running. {confirm.kind === 'restart' && 'Its output will be cleared. '}Other
                panes keep running.
              </p>
              <div className={dialogStyles.actions}>
                <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
                <Button variant="danger" onClick={() => void confirmAction()}>
                  {confirm.kind === 'close' ? 'Close shell' : 'Restart shell'}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </section>
  )
}

function leafIds(layout: ShellLayout): string[] {
  return 'shellId' in layout
    ? [layout.shellId]
    : [...leafIds(layout.first), ...leafIds(layout.second)]
}

function neighborOf(layout: ShellLayout, id: string): string | undefined {
  if ('shellId' in layout) return undefined
  if ('shellId' in layout.first && layout.first.shellId === id) return leafIds(layout.second)[0]
  if ('shellId' in layout.second && layout.second.shellId === id)
    return leafIds(layout.first).at(-1)
  return neighborOf(layout.first, id) ?? neighborOf(layout.second, id)
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}
interface Divider {
  id: string
  direction: 'right' | 'below'
  ratio: number
  parent: Rect
  rect: Rect
}

function minimum(layout: ShellLayout): { width: number; height: number } {
  if ('shellId' in layout) return { width: 220, height: 180 }
  const a = minimum(layout.first),
    b = minimum(layout.second)
  return layout.direction === 'right'
    ? { width: a.width + b.width + 6, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height + 6 }
}

function arrange(
  layout: ShellLayout,
  rect: Rect,
  draft: { id: string; ratio: number } | undefined,
  panes: Map<string, Rect>,
  dividers: Divider[],
): void {
  if ('shellId' in layout) {
    panes.set(layout.shellId, rect)
    return
  }
  const right = layout.direction === 'right'
  const ratio = draft?.id === layout.id ? draft.ratio : layout.ratio
  const a = minimum(layout.first),
    b = minimum(layout.second)
  const available = (right ? rect.width : rect.height) - 6
  const extent = Math.max(
    right ? a.width : a.height,
    Math.min(available - (right ? b.width : b.height), available * ratio),
  )
  const first = { ...rect, ...(right ? { width: extent } : { height: extent }) }
  const divider = {
    ...rect,
    ...(right ? { left: rect.left + extent, width: 6 } : { top: rect.top + extent, height: 6 }),
  }
  const second = {
    ...rect,
    ...(right
      ? { left: divider.left + 6, width: available - extent }
      : { top: divider.top + 6, height: available - extent }),
  }
  dividers.push({ id: layout.id, direction: layout.direction, ratio, parent: rect, rect: divider })
  arrange(layout.first, first, draft, panes, dividers)
  arrange(layout.second, second, draft, panes, dividers)
}

function ShellLayoutView({
  layout,
  disabled,
  renderPane,
  onRatio,
}: {
  layout: ShellLayout
  disabled: boolean
  renderPane: (id: string) => ReactNode
  onRatio: (branchId: string, ratio: number) => Promise<void>
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [draft, setDraft] = useState<{ id: string; ratio: number }>()
  const pending = useRef(draft)
  pending.current = draft
  const drag = useRef<string | undefined>(undefined)
  useEffect(() => {
    const element = host.current
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const min = minimum(layout)
  const width = Math.max(min.width, size.width),
    height = Math.max(min.height, size.height)
  const panes = new Map<string, Rect>(),
    dividers: Divider[] = []
  arrange(layout, { left: 0, top: 0, width, height }, draft, panes, dividers)
  const update = (id: string, value: number) => {
    const next = { id, ratio: Math.max(0.1, Math.min(0.9, value)) }
    pending.current = next
    setDraft(next)
    return next.ratio
  }
  const commit = (id: string, ratio: number) => {
    void onRatio(id, ratio).finally(() => setDraft(undefined))
  }
  return (
    <div ref={host} className={styles.workspace}>
      <div ref={canvas} className={styles.canvas} style={{ width, height }}>
        {size.width > 0 &&
          size.height > 0 &&
          [...panes].map(([id, rect]) => (
            <div key={id} className={styles.positionedPane} style={rect}>
              {renderPane(id)}
            </div>
          ))}
        {dividers.map((divider) => {
          const right = divider.direction === 'right'
          return (
            <hr
              key={divider.id}
              className={`${styles.divider} ${right ? styles.rightDivider : styles.belowDivider}`}
              style={divider.rect}
              tabIndex={disabled ? -1 : 0}
              aria-label="Resize shell panes"
              aria-orientation={right ? 'vertical' : 'horizontal'}
              aria-valuemin={10}
              aria-valuemax={90}
              aria-valuenow={Math.round(divider.ratio * 100)}
              onPointerDown={(event) => {
                if (!disabled) {
                  drag.current = divider.id
                  event.currentTarget.setPointerCapture(event.pointerId)
                }
              }}
              onPointerMove={(event) => {
                if (drag.current !== divider.id || !canvas.current) return
                const bounds = canvas.current.getBoundingClientRect()
                update(
                  divider.id,
                  right
                    ? (event.clientX - bounds.left - divider.parent.left) /
                        (divider.parent.width - 6)
                    : (event.clientY - bounds.top - divider.parent.top) /
                        (divider.parent.height - 6),
                )
              }}
              onPointerUp={() => {
                if (drag.current === divider.id) {
                  drag.current = undefined
                  if (pending.current?.id === divider.id) commit(divider.id, pending.current.ratio)
                }
              }}
              onPointerCancel={() => {
                drag.current = undefined
                pending.current = undefined
                setDraft(undefined)
              }}
              onKeyDown={(event) => {
                if (disabled) return
                const backwards = right ? 'ArrowLeft' : 'ArrowUp',
                  forwards = right ? 'ArrowRight' : 'ArrowDown'
                if (event.key !== backwards && event.key !== forwards) return
                event.preventDefault()
                commit(
                  divider.id,
                  update(divider.id, divider.ratio + (event.key === backwards ? -0.05 : 0.05)),
                )
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
