import type { Attachment, BrowserRequest, Task } from '@ted/protocol'
import { useEffect, useRef, useState } from 'react'
import { useConnection, useTaskApps } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import type { ShownApp } from './AppsSection.tsx'
import { Button } from './Button.tsx'
import { CommentFiles } from './CommentFiles.tsx'
import { Select } from './Select.tsx'
import styles from './TaskBrowserView.module.css'

export function TaskBrowserView({
  task,
  shown,
  onBack,
  onLog,
}: {
  task: Task
  shown: ShownApp
  onBack: () => void
  onLog: () => void
}) {
  const { epoch, connection } = useConnection()
  const apps = useTaskApps(task.id).filter((a) => a.kind === 'web' && !a.removed)
  const app = apps.find((a) => a.repo === shown.repo && a.name === shown.name)
  const viewport = useRef<HTMLDivElement>(null)
  const editing = useRef(false)
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState('Opening…')
  const [capture, setCapture] = useState<Attachment>()
  const [busy, setBusy] = useState(false)
  const [command, setCommand] = useState<BrowserRequest['action']>()
  const active = useRef(false)
  const [ready, setReady] = useState(false)
  const [retryOpen, setRetryOpen] = useState(0)
  const running = app?.state === 'running'
  const act = async (request: BrowserRequest) => {
    if (active.current) return
    active.current = true
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
    } catch (error) {
      setStatus(readableError(error))
    } finally {
      active.current = false
      setBusy(false)
    }
  }
  useEffect(() => {
    void epoch
    void retryOpen
    void app?.startedAt
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    setReady(false)
    const open = async () => {
      try {
        const result = await ted.browserCommand(task.id, {
          action: 'open',
          app: { repo: shown.repo, name: shown.name },
        })
        if (stopped) return
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
    } else
      setStatus(
        running ? 'Reconnecting…' : 'This App isn’t running. Use ▶ in Apps, then open Preview.',
      )
    return () => {
      stopped = true
      clearTimeout(retry)
      void ted.hideBrowser()
    }
  }, [task.id, shown.repo, shown.name, running, app?.startedAt, epoch, connection.state, retryOpen])

  useEffect(() => {
    if (!ready || !running) return
    let stopped = false
    let presenting = false
    const position = () => {
      if (stopped) return
      const rect = viewport.current?.getBoundingClientRect()
      if (
        !rect ||
        document.querySelector('dialog[open], [role="dialog"], [role="menu"]') ||
        rect.width < 1 ||
        rect.height < 1
      ) {
        void ted.hideBrowser(true)
        return
      }
      if (presenting) return
      presenting = true
      return ted
        .presentBrowser(task.id, shown.repo, shown.name, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })
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
            if (!state.url) {
              setRetryOpen((attempt) => attempt + 1)
              return
            }
            setStatus(state.text)
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
  }, [task.id, shown.repo, shown.name, ready, running])

  return (
    <section className={styles.pane} aria-label="Task browser">
      <div className={styles.toolbar}>
        <Button size="small" onClick={onBack}>
          ← Task Lead
        </Button>
        <Select
          aria-label="Web App"
          value={`${shown.repo}/${shown.name}`}
          onChange={(event) => {
            const next = apps.find((a) => `${a.repo}/${a.name}` === event.target.value)
            if (next)
              ted
                .openAppPreview(task.id, next.repo, next.name)
                .catch((error: unknown) => setStatus(readableError(error)))
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
          size="small"
          disabled={busy || !ready}
          aria-label="Back"
          onClick={() => act({ action: 'back' })}
        >
          ←
        </Button>
        <Button
          size="small"
          disabled={busy || !ready}
          aria-label="Forward"
          onClick={() => act({ action: 'forward' })}
        >
          →
        </Button>
        <Button size="small" disabled={busy || !ready} onClick={() => act({ action: 'reload' })}>
          Reload
        </Button>
        <Button size="small" onClick={onLog}>
          App log
        </Button>
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
        <Button
          size="small"
          type="submit"
          pending={busy && command === 'navigate'}
          disabled={busy || !ready}
        >
          Go
        </Button>
        <Button
          size="small"
          disabled={busy || !ready}
          onClick={() => act({ action: 'screenshot' })}
        >
          Screenshot
        </Button>
        <Button
          size="small"
          disabled={!ready}
          onClick={() =>
            ted.externalBrowser(task.id).catch((error: unknown) => setStatus(readableError(error)))
          }
        >
          Open ↗
        </Button>
      </form>
      <p className={styles.shared}>Shared with this Task’s agents · Local App only</p>
      <div ref={viewport} className={styles.viewport}>
        {!ready && <p>{status}</p>}
      </div>
      <p className={styles.status} role="status">
        {status}
      </p>
      {capture && (
        <div className={styles.capture}>
          <CommentFiles files={[capture]} />
          <Button
            size="small"
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
          <Button size="small" onClick={() => setCapture(undefined)}>
            Dismiss
          </Button>
        </div>
      )}
    </section>
  )
}
