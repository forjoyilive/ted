import type { Task, TaskApp } from '@ted/protocol'
import { useState } from 'react'
import { appStatusLine, appsSummary, type HostedPreview, hostedPreviews, isLive } from '../apps.ts'
import { useTaskApps } from '../data.ts'
import { useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import styles from './Apps.module.css'
import { OpenIcon, PlayIcon, RestartIcon, StopIcon } from './icons.tsx'

export interface ShownApp {
  repo: string
  name: string
}

export function AppsSection({
  task,
  shown,
  onOpenApp,
}: {
  task: Task
  shown: ShownApp | undefined
  onOpenApp: (app: ShownApp) => void
}) {
  const apps = useTaskApps(task.id)
  const hosted = hostedPreviews(task)
  if (apps.length === 0 && hosted.length === 0) return null
  const repos = [...new Set([...apps.map((a) => a.repo), ...hosted.map((h) => h.repo)])]
  const grouped = task.repos.filter((r) => !r.removed).length > 1 || repos.length > 1
  const summary = appsSummary(apps, hosted.length)
  return (
    <section className={styles.section} aria-label="Apps">
      <h2 className={styles.heading}>
        Apps{summary !== undefined && <span className={styles.summary}> · {summary}</span>}
      </h2>
      {repos.map((repo) => (
        <div key={repo} className={styles.group}>
          {grouped && <h3 className={styles.repo}>{repo}</h3>}
          <ul className={styles.list}>
            {apps
              .filter((a) => a.repo === repo)
              .map((app) => (
                <AppRow
                  key={`${app.repo}/${app.name}`}
                  task={task}
                  app={app}
                  selected={shown?.repo === app.repo && shown.name === app.name}
                  onOpen={() => onOpenApp({ repo: app.repo, name: app.name })}
                />
              ))}
            {hosted
              .filter((h) => h.repo === repo)
              .map((h) => (
                <HostedRow key={`hosted/${h.repo}`} task={task} hosted={h} />
              ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

export function StatusDot({ state }: { state: TaskApp['state'] | 'hosted' }) {
  return <span className={styles.dot} data-state={state} aria-hidden />
}

export function useAppActions(task: Task, app: TaskApp) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const act = (request: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    request()
      .catch((failed: unknown) => setError(readableError(failed)))
      .finally(() => setBusy(false))
  }
  const live = isLive(app)
  const runnable = !task.archived && task.stage !== 'done' && app.kind !== 'ios-simulator'
  return {
    busy,
    error,
    live,
    runnable,
    preview: () => act(() => ted.openAppPreview(task.id, app.repo, app.name)),
    start: () => act(() => ted.startApp(task.id, app.repo, app.name)),
    stop: () => act(() => ted.stopApp(task.id, app.repo, app.name)),
    restart: () => act(() => ted.restartApp(task.id, app.repo, app.name)),
  }
}

function AppRow({
  task,
  app,
  selected,
  onOpen,
}: {
  task: Task
  app: TaskApp
  selected: boolean
  onOpen: () => void
}) {
  const now = useNow()
  const actions = useAppActions(task, app)
  const { busy, live, runnable } = actions
  return (
    <li className={styles.row} data-selected={selected || undefined}>
      <button
        type="button"
        className={styles.open}
        title={`Show ${app.name}’s log`}
        onClick={onOpen}
      >
        <StatusDot state={app.state} />
        <span className={styles.text}>
          <span className={styles.name}>{app.name}</span>
          <span className={styles.status} data-state={app.state}>
            {appStatusLine(app, now)}
          </span>
          {actions.error !== undefined && (
            <span className={styles.error} role="alert">
              {actions.error}
            </span>
          )}
        </span>
      </button>
      <span className={styles.actions}>
        {app.kind === 'web' && (
          <button
            type="button"
            className={styles.action}
            aria-label={`Preview ${app.name}`}
            title="Preview"
            disabled={busy || app.state !== 'running'}
            onClick={actions.preview}
          >
            <OpenIcon />
          </button>
        )}
        {live ? (
          <button
            type="button"
            className={styles.action}
            aria-label={`Stop ${app.name}`}
            title="Stop"
            disabled={busy}
            onClick={actions.stop}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className={styles.action}
            aria-label={`Run ${app.name}`}
            title="Run"
            disabled={busy || !runnable}
            onClick={actions.start}
          >
            <PlayIcon />
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          aria-label={`Restart ${app.name}`}
          title="Restart"
          disabled={busy || !live || !runnable}
          onClick={actions.restart}
        >
          <RestartIcon />
        </button>
      </span>
    </li>
  )
}

function HostedRow({ task, hosted }: { task: Task; hosted: HostedPreview }) {
  const [error, setError] = useState<string>()
  return (
    <li className={styles.row}>
      <span className={styles.open}>
        <StatusDot state="hosted" />
        <span className={styles.text}>
          <span className={styles.name}>{hosted.preview.label}</span>
          <span className={styles.status}>{`Hosted · from PR #${hosted.pullRequest}`}</span>
          {error !== undefined && (
            <span className={styles.error} role="alert">
              {error}
            </span>
          )}
        </span>
      </span>
      <span className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          aria-label={`Open ${hosted.preview.label}`}
          title={hosted.preview.url}
          onClick={() =>
            void ted
              .openHostedPreview(task.id, hosted.repo)
              .catch((failed: unknown) => setError(readableError(failed)))
          }
        >
          <OpenIcon />
        </button>
      </span>
    </li>
  )
}
