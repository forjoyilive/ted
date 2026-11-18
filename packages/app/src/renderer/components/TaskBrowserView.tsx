import type { Attachment, BrowserRequest, Task, TaskApp } from '@ted/protocol'
import { isString } from '@ted/protocol/parse'
import {
  type PreviewSize,
  type PreviewZoom,
  previewSize,
  previewSizeLabel,
  previewSizeOf,
  previewSizeValue,
} from '@ted/protocol/preview-size'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnection, useTaskApps } from '../data.ts'
import { previewFrame } from '../preview-frame.ts'
import { readableError, ted } from '../ted.ts'
import type { ShownApp } from './AppsSection.tsx'
import { Button } from './Button.tsx'
import { CommentFiles } from './CommentFiles.tsx'
import { OutsideSandboxDialog } from './OutsideSandboxDialog.tsx'
import { PreviewSizeMenu } from './PreviewSizeMenu.tsx'
import { Select } from './Select.tsx'
import styles from './TaskBrowserView.module.css'

const zooms = new Map<string, PreviewZoom>()

export function TaskBrowserView({
  task,
  shown,
  onBack,
  onLog,
  onSwitch,
}: {
  task: Task
  shown: ShownApp
  onBack: () => void
  onLog: () => void
  onSwitch: (app: ShownApp) => void
}) {
  const { epoch, connection } = useConnection()
  const apps = useTaskApps(task.id).filter((a) => a.kind === 'web' && !a.removed)
  const app = apps.find((a) => a.repo === shown.repo && a.name === shown.name)
  const viewport = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const zoomKey = JSON.stringify([task.id, shown.repo, shown.name])
  const [size, setSize] = useState<PreviewSize>(() => previewSizeOf(app?.preview))
  const [zoom, setZoomState] = useState<PreviewZoom>(() => zooms.get(zoomKey) ?? 'fit')
  const [room, setRoom] = useState({ width: 0, height: 0 })
  const frame = previewFrame(size, zoom, room)
  const scale = useRef(frame.scale)
  scale.current = frame.scale
  const sizeValue = useRef(previewSizeValue(size))
  const note = useRef<string>(undefined)
  const setZoom = (next: PreviewZoom) => {
    zooms.set(zoomKey, next)
    setZoomState(next)
  }
  const editing = useRef(false)
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState('Opening…')
  const [capture, setCapture] = useState<Attachment>()
  const [busy, setBusy] = useState(false)
  const [command, setCommand] = useState<BrowserRequest['action']>()
  const active = useRef(false)
  const [ready, setReady] = useState(false)
  const [retryOpen, setRetryOpen] = useState(0)
  const [blocked, setBlocked] = useState(0)
  const [history, setHistory] = useState({ back: false, forward: false })
  const [confirming, setConfirming] = useState<TaskApp>()
  const running = app?.state === 'running'
  const idle = running ? undefined : idleText(app)
  const readHistory = () =>
    ted
      .browserState(task.id)
      .then((state) => {
        if (state?.url)
          setHistory({ back: state.canGoBack === true, forward: state.canGoForward === true })
      })
      .catch(() => {})
  const start = (next: TaskApp) => {
    onSwitch({ repo: next.repo, name: next.name })
    return ted
      .startApp(task.id, { repo: next.repo, name: next.name })
      .catch((error: unknown) => setStatus(readableError(error)))
  }
  const choose = (next: TaskApp) => {
    if (next.state === 'running' || next.state === 'starting' || next.state === 'waiting')
      onSwitch({ repo: next.repo, name: next.name })
    else if (next.confirmOutsideSandbox === true) setConfirming(next)
    else void start(next)
  }
  const act = async (request: BrowserRequest): Promise<boolean> => {
    if (active.current) return false
    active.current = true
    note.current = undefined
    setCommand(request.action)
    setBusy(true)
    try {
      const result = await ted.browserCommand(task.id, {
        ...request,
        app: { repo: shown.repo, name: shown.name },
      })
      if (result.attachment) setCapture(result.attachment)
      if (result.url) setAddress(result.url)
      setStatus(
        result.attachment ? 'Screenshot saved to Task attachments' : (result.text ?? 'Ready'),
      )
      return true
    } catch (error) {
      setStatus(readableError(error))
      return false
    } finally {
      active.current = false
      setBusy(false)
      void readHistory()
    }
  }
  const preset = useRef(app?.preview)
  preset.current = app?.preview
  const synced = useRef(false)
  useEffect(() => {
    setZoomState(zooms.get(zoomKey) ?? 'fit')
    const initial = previewSizeOf(preset.current)
    sizeValue.current = previewSizeValue(initial)
    synced.current = false
    setSize(initial)
  }, [zoomKey])

  useEffect(() => {
    const element = area.current
    if (!element) return
    const measure = () => {
      const box = element.getBoundingClientRect()
      setRoom((old) =>
        old.width === box.width && old.height === box.height
          ? old
          : { width: box.width, height: box.height },
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])

  const showSize = useCallback((next: PreviewSize, byAgent: boolean) => {
    const value = previewSizeValue(next)
    if (value === sizeValue.current) return
    sizeValue.current = value
    setSize(next)
    if (!byAgent || !synced.current) return
    note.current = `An agent switched the preview to ${previewSizeLabel(next)}`
    setStatus(note.current)
  }, [])

  const chooseSize = async (next: PreviewSize) => {
    if (await act({ action: 'size', value: previewSizeValue(next) })) showSize(next, false)
  }

  useEffect(() => {
    void epoch
    void retryOpen
    void app?.startedAt
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    setReady(false)
    setHistory({ back: false, forward: false })
    const open = async () => {
      try {
        const result = await ted.browserCommand(task.id, {
          action: 'open',
          app: { repo: shown.repo, name: shown.name },
        })
        if (stopped) return
        const state = await ted.browserState(task.id).catch(() => undefined)
        if (stopped) return
        const chosen = previewSize(state?.size ?? '')
        if (!isString(chosen)) showSize(chosen, false)
        synced.current = true
        if (state?.url)
          setHistory({ back: state.canGoBack === true, forward: state.canGoForward === true })
        setReady(true)
        setAddress(result.url ?? '')
        setStatus(result.text ?? 'Ready')
      } catch (error) {
        if (stopped) return
        setStatus(readableError(error))
        retry = setTimeout(() => void open(), 1_000)
      }
    }
    if (running && connection.state === 'connected') {
      setStatus('Opening…')
      void open()
    } else setStatus(idle ?? 'Reconnecting…')
    return () => {
      stopped = true
      clearTimeout(retry)
      void ted.hideBrowser()
    }
  }, [
    task.id,
    shown.repo,
    shown.name,
    running,
    idle,
    app?.startedAt,
    epoch,
    connection.state,
    retryOpen,
    showSize,
  ])

  useEffect(() => {
    if (!ready || !running) return
    let stopped = false
    let presenting = false
    const position = () => {
      if (stopped) return
      const rect = viewport.current?.getBoundingClientRect()
      if (
        !rect ||
        document.querySelector('dialog[open], [role="dialog"], [role="menu"], [role="listbox"]') ||
        rect.width < 1 ||
        rect.height < 1
      ) {
        void ted.hideBrowser(true)
        return
      }
      if (presenting) return
      presenting = true
      return ted
        .presentBrowser(
          task.id,
          shown.repo,
          shown.name,
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          scale.current,
        )
        .catch((error: unknown) => {
          if (!stopped) setStatus(readableError(error))
        })
        .finally(() => {
          presenting = false
        })
    }
    const observer = new ResizeObserver(position)
    if (viewport.current) observer.observe(viewport.current)
    const mutations = new MutationObserver(position)
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    })
    position()
    const timer = setInterval(position, 500)
    const stateTimer = setInterval(() => {
      void ted
        .browserState(task.id)
        .then((state) => {
          if (!stopped && state) {
            if (state.opening) {
              setStatus(state.text)
              return
            }
            if (!state.url) {
              setRetryOpen((attempt) => attempt + 1)
              return
            }
            const chosen = previewSize(state.size ?? '')
            if (!isString(chosen)) showSize(chosen, state.sizeByAgent === true)
            setStatus(note.current ?? state.text)
            setBlocked(state.blocked ?? 0)
            setHistory({ back: state.canGoBack === true, forward: state.canGoForward === true })
            if (!editing.current) setAddress(state.url)
          }
        })
        .catch((error: unknown) => {
          if (!stopped) setStatus(readableError(error))
        })
    }, 1500)
    return () => {
      stopped = true
      clearInterval(timer)
      clearInterval(stateTimer)
      observer.disconnect()
      mutations.disconnect()
      void ted.hideBrowser()
    }
  }, [task.id, shown.repo, shown.name, ready, running, showSize])

  return (
    <section className={styles.pane} aria-label="Task browser">
      <div className={styles.toolbar}>
        <Button onClick={onBack}>← Task Lead</Button>
        <Select
          aria-label="Web App"
          value={`${shown.repo}/${shown.name}`}
          onChange={(event) => {
            const next = apps.find((a) => `${a.repo}/${a.name}` === event.target.value)
            if (next) choose(next)
          }}
        >
          {apps.map((a) => (
            <option key={`${a.repo}/${a.name}`} value={`${a.repo}/${a.name}`}>
              {a.name}
              {task.repos.length > 1 ? ` · ${a.repo}` : ''}
            </option>
          ))}
        </Select>
        <Button
          disabled={busy || !ready || !history.back}
          aria-label="Back"
          onClick={() => act({ action: 'back' })}
        >
          ←
        </Button>
        <Button
          disabled={busy || !ready || !history.forward}
          aria-label="Forward"
          onClick={() => act({ action: 'forward' })}
        >
          →
        </Button>
        <Button disabled={busy || !ready} onClick={() => act({ action: 'reload' })}>
          Reload
        </Button>
        <Button onClick={onLog}>App log</Button>
      </div>
      <form
        className={styles.toolbar}
        onSubmit={(event) => {
          event.preventDefault()
          return act({ action: 'navigate', value: address })
        }}
      >
        <input
          aria-label="App address"
          onFocus={() => {
            editing.current = true
          }}
          onBlur={() => {
            editing.current = false
          }}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button type="submit" pending={busy && command === 'navigate'} disabled={busy || !ready}>
          Go
        </Button>
        <Button disabled={busy || !ready} onClick={() => act({ action: 'screenshot' })}>
          Screenshot
        </Button>
        <Button
          disabled={!ready}
          onClick={() =>
            ted.externalBrowser(task.id).catch((error: unknown) => setStatus(readableError(error)))
          }
        >
          Open ↗
        </Button>
        <PreviewSizeMenu
          scope={zoomKey}
          size={size}
          zoom={zoom}
          scale={frame.scale}
          disabled={busy || !ready}
          onSize={chooseSize}
          onZoom={setZoom}
        />
      </form>
      <p className={styles.shared}>
        Shared with this Task’s agents · Local App, plus images, fonts and media from the web
        {blocked > 0 && (
          <span className={styles.blocked}>
            Blocked {blocked} {blocked === 1 ? 'request' : 'requests'} to other sites ·{' '}
            <button
              type="button"
              className={styles.open}
              disabled={!ready}
              onClick={() =>
                ted
                  .externalBrowser(task.id)
                  .catch((error: Error) => setStatus(readableError(error)))
              }
            >
              Open ↗
            </button>
          </span>
        )}
      </p>
      <div
        ref={area}
        className={`${styles.viewport} ${size.kind === 'desktop' ? '' : styles.framed}`}
        data-preview-size={previewSizeValue(size)}
      >
        <div
          ref={viewport}
          className={styles.frame}
          style={{ width: frame.width, height: frame.height }}
        >
          {!ready && <p>{status}</p>}
        </div>
      </div>
      <p className={styles.status} role="status">
        {status}
      </p>
      {capture && (
        <div className={styles.capture}>
          <CommentFiles files={[capture]} />
          <Button
            onClick={() => {
              return ted
                .postComment(task.id, { body: 'Browser screenshot', attachments: [capture] })
                .then(() => {
                  setCapture(undefined)
                  setStatus('Screenshot posted to the Task')
                })
                .catch((error: unknown) => setStatus(readableError(error)))
            }}
          >
            Post screenshot to Task
          </Button>
          <Button onClick={() => setCapture(undefined)}>Dismiss</Button>
        </div>
      )}
      {confirming && (
        <OutsideSandboxDialog
          task={task}
          app={confirming.name}
          onRun={() => start(confirming).then(() => setConfirming(undefined))}
          onCancel={() => setConfirming(undefined)}
        />
      )}
    </section>
  )
}

function idleText(app: TaskApp | undefined): string {
  if (app?.state === 'starting' || app?.state === 'waiting') return `Starting ${app.name}…`
  if (app?.state === 'failed' && app.problem) return app.problem
  return 'This App isn’t running. Use ▶ in Apps, then open preview.'
}
