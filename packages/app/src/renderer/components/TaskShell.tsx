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
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ id: string; kind: 'close' | 'restart' }>()
  const alive = useRef(false)

  useEffect(() => {
    void epoch
    alive.current = true
    let closed = false
    setWorkspace(undefined)
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
        if (added) setActive(added.id)
      } else if (request.kind === 'close') {
        setActive(next.shells[0]?.id)
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
          setActive(action.id)
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
  const draw = (layout: ShellLayout): ReactNode => {
    if ('shellId' in layout) {
      const shell = workspace?.shells.find((s) => s.id === layout.shellId)
      return (
        shell && (
          <TaskShellPane
            key={shell.id}
            taskId={taskId}
            repo={repo}
            shell={shell}
            number={numbers.get(shell.id) ?? 1}
            active={selected === shell.id}
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
      <ShellSplit
        key={layout.id}
        layout={layout}
        disabled={busy}
        onRatio={(ratio) => {
          if (workspace)
            void change({ kind: 'ratio', revision: workspace.revision, branchId: layout.id, ratio })
        }}
        first={draw(layout.first)}
        second={draw(layout.second)}
      />
    )
  }

  return (
    <section className={styles.pane} aria-label="Shell">
      <button type="button" className={styles.back} onClick={onBack}>
        ← Thread
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
      <div className={styles.workspace}>
        {workspace?.layout ? (
          draw(workspace.layout)
        ) : (
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
        )}
      </div>
      {confirm && (
        <Dialog onClose={() => setConfirm(undefined)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                {confirm.kind === 'close' ? 'Close' : 'Restart'} Shell {numbers.get(confirm.id)}?
              </h2>
              <p className={dialogStyles.body}>
                This ends this shell and its child processes.{' '}
                {confirm.kind === 'restart' && 'Its output will be cleared. '}Other panes keep
                running.
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

function minimum(layout: ShellLayout): { width: number; height: number } {
  if ('shellId' in layout) return { width: 220, height: 180 }
  const a = minimum(layout.first),
    b = minimum(layout.second)
  return layout.direction === 'right'
    ? { width: a.width + b.width + 6, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height + 6 }
}

function ShellSplit({
  layout,
  first,
  second,
  onRatio,
  disabled,
}: {
  layout: Exclude<ShellLayout, { shellId: string }>
  first: ReactNode
  second: ReactNode
  onRatio: (ratio: number) => void
  disabled: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(layout.ratio)
  const value = useRef(ratio)
  const dragging = useRef(false)
  const right = layout.direction === 'right'
  useEffect(() => {
    setRatio(layout.ratio)
    value.current = layout.ratio
  }, [layout])
  const update = (next: number) => {
    value.current = Math.max(0.1, Math.min(0.9, next))
    setRatio(value.current)
  }
  const a = minimum(layout.first),
    b = minimum(layout.second)
  return (
    <div
      ref={host}
      className={`${styles.split} ${right ? styles.right : styles.below}`}
      style={{ minWidth: minimum(layout).width, minHeight: minimum(layout).height }}
    >
      <div
        className={styles.child}
        style={{ flex: `${ratio} 1 0`, minWidth: a.width, minHeight: a.height }}
      >
        {first}
      </div>
      <hr
        className={styles.divider}
        tabIndex={disabled ? -1 : 0}
        aria-label="Resize shell panes"
        aria-orientation={right ? 'vertical' : 'horizontal'}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(ratio * 100)}
        onPointerDown={(event) => {
          if (disabled) return
          dragging.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!dragging.current || !host.current) return
          const rect = host.current.getBoundingClientRect()
          update(
            right
              ? (event.clientX - rect.left) / rect.width
              : (event.clientY - rect.top) / rect.height,
          )
        }}
        onPointerUp={() => {
          if (dragging.current) {
            dragging.current = false
            onRatio(value.current)
          }
        }}
        onPointerCancel={() => {
          dragging.current = false
          update(layout.ratio)
        }}
        onKeyDown={(event) => {
          if (disabled) return
          const backwards = right ? 'ArrowLeft' : 'ArrowUp',
            forwards = right ? 'ArrowRight' : 'ArrowDown'
          if (event.key !== backwards && event.key !== forwards) return
          event.preventDefault()
          update(value.current + (event.key === backwards ? -0.05 : 0.05))
          onRatio(value.current)
        }}
      />
      <div
        className={styles.child}
        style={{ flex: `${1 - ratio} 1 0`, minWidth: b.width, minHeight: b.height }}
      >
        {second}
      </div>
    </div>
  )
}
