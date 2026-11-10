import type { AppLog, Task, TaskApp } from '@ted/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { appStatusLine } from '../apps.ts'
import { useTaskApps } from '../data.ts'
import { useNow } from '../requests.ts'
import { ted } from '../ted.ts'
import styles from './Apps.module.css'
import { type ShownApp, StatusDot, useAppActions } from './AppsSection.tsx'
import { Button } from './Button.tsx'
import { OpenIcon } from './icons.tsx'
import { Loading } from './Loading.tsx'

export function AppLogView({
  task,
  shown,
  onBack,
}: {
  task: Task
  shown: ShownApp
  onBack: () => void
}) {
  const app = useTaskApps(task.id).find((a) => a.repo === shown.repo && a.name === shown.name)
  return (
    <section className={styles.logPane} aria-label={`${shown.name} log`}>
      <button type="button" className={styles.back} onClick={onBack}>
        ← Thread
      </button>
      {app ? (
        <LogHeader task={task} app={app} />
      ) : (
        <h2 className={styles.logTitle}>{shown.name}</h2>
      )}
      <LogBody key={`${task.id}:${shown.repo}:${shown.name}`} taskId={task.id} shown={shown} />
    </section>
  )
}

function LogHeader({ task, app }: { task: Task; app: TaskApp }) {
  const now = useNow()
  const actions = useAppActions(task, app)
  return (
    <header className={styles.logHeader}>
      <StatusDot state={app.state} />
      <h2 className={styles.logTitle}>{app.name}</h2>
      <span className={styles.repoChip}>{app.repo}</span>
      <span className={styles.logStatus}>{logStatus(app, now)}</span>
      <span className={styles.logActions}>
        {app.kind === 'web' && (
          <Button
            size="small"
            disabled={actions.busy || app.state !== 'running'}
            onClick={actions.preview}
          >
            Preview <OpenIcon />
          </Button>
        )}
        {actions.live ? (
          <Button size="small" disabled={actions.busy} onClick={actions.stop}>
            Stop
          </Button>
        ) : (
          <Button
            size="small"
            disabled={actions.busy || !actions.runnable}
            onClick={() => actions.start()}
          >
            Run
          </Button>
        )}
        <Button
          size="small"
          disabled={actions.busy || !actions.live || !actions.runnable}
          onClick={actions.restart}
        >
          Restart
        </Button>
      </span>
      {actions.error !== undefined && (
        <p className={styles.error} role="alert">
          {actions.error}
        </p>
      )}
      {actions.dialog}
    </header>
  )
}

function logStatus(app: TaskApp, now: number): string {
  if (app.state === 'running')
    return `Running · ${appStatusLine(app, now).replace(/^Running · /, '')}`
  return appStatusLine(app, now)
}

function LogBody({ taskId, shown }: { taskId: string; shown: ShownApp }) {
  const [log, setLog] = useState<AppLog>()
  const [error, setError] = useState<string>()
  const body = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    let stopped = false
    const load = () =>
      ted
        .appLog(taskId, shown.repo, shown.name)
        .then((next) => {
          if (stopped) return
          setError(undefined)
          setLog((last) => (last?.text === next.text ? last : next))
        })
        .catch((failed: unknown) => {
          if (!stopped) setError(failed instanceof Error ? failed.message : String(failed))
        })
    void load()
    const timer = setInterval(() => void load(), 1_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [taskId, shown.repo, shown.name])

  useLayoutEffect(() => {
    const element = body.current
    if (element && pinned.current && log) element.scrollTop = element.scrollHeight
  }, [log])

  return (
    <pre
      ref={body}
      className={`${styles.logBody} ${log === undefined && error === undefined ? styles.pending : ''}`}
      onScroll={(event) => {
        const element = event.currentTarget
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
      }}
    >
      {error !== undefined ? (
        error
      ) : log === undefined ? (
        <Loading terminal label="Loading App log…" />
      ) : log.text === '' ? (
        'Nothing in the log yet.'
      ) : (
        `${log.truncated ? 'Earlier output isn’t kept.\n' : ''}${log.text}`
      )}
    </pre>
  )
}
