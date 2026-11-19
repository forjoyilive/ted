import type { Task } from '@ted/protocol'
import { type ReactNode, useState } from 'react'
import { appStatusLine, hostOf, isLive, type PreviewChoice, previewChoice } from '../apps.ts'
import { useTaskApps } from '../data.ts'
import { useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import type { ShownApp } from './AppsSection.tsx'
import { Button } from './Button.tsx'
import { OpenIcon, PlayIcon } from './icons.tsx'
import { useOutsideSandbox } from './OutsideSandboxDialog.tsx'
import styles from './PreviewRow.module.css'

export function PreviewRow({
  task,
  onOpenApp,
}: {
  task: Task
  onOpenApp?: ((app: ShownApp) => void) | undefined
}) {
  const apps = useTaskApps(task.id)
  const now = useNow()
  const choice = previewChoice(task, apps)
  if (!choice) return null
  return <Preview task={task} choice={choice} onOpenApp={onOpenApp} now={now} />
}

function Preview({
  task,
  choice,
  onOpenApp,
  now,
}: {
  task: Task
  choice: PreviewChoice
  onOpenApp?: ((app: ShownApp) => void) | undefined
  now: number
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { confirm, dialog } = useOutsideSandbox(
    task,
    choice.kind === 'hosted' ? { name: '' } : choice.app,
  )
  const act = (request: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    return request()
      .catch((failed: unknown) => setError(readableError(failed)))
      .finally(() => setBusy(false))
  }

  let detail: string
  let action: ReactNode
  if (choice.kind === 'hosted') {
    const { hosted } = choice
    detail = `${hostOf(hosted.preview.url)} · ${hosted.preview.label}`
    action = (
      <Button
        size="small"
        variant="primary"
        disabled={busy}
        onClick={() => act(() => ted.openHostedPreview(task.id, hosted.repo))}
      >
        Open <OpenIcon />
      </Button>
    )
  } else if (choice.kind === 'local') {
    const { app } = choice
    detail =
      app.state === 'running'
        ? `${hostOf(app.url ?? '')} · ${app.name}, running locally`
        : appStatusLine(app, now)
    action = (
      <Button
        size="small"
        variant="primary"
        disabled={busy || app.state !== 'running'}
        onClick={() => act(() => ted.openAppPreview(task.id, app.repo, app.name))}
      >
        Open <OpenIcon />
      </Button>
    )
  } else if (choice.kind === 'window') {
    const { app } = choice
    const live = isLive(app)
    const yours = live && app.startedBy === 'human'
    const ended = !live && app.startedAt !== undefined
    detail =
      live || ended ? `${app.name} · ${appStatusLine(app, now)}` : `${app.name} isn’t running`
    action = (
      <>
        {ended && onOpenApp && (
          <ActionButton
            type="button"
            className={styles.link}
            onClick={() => onOpenApp({ repo: app.repo, name: app.name })}
          >
            Log
          </ActionButton>
        )}
        <Button
          size="small"
          variant="primary"
          disabled={busy || yours || task.archived !== undefined}
          onClick={() =>
            confirm((confirmed) =>
              act(() => ted.startApp(task.id, { repo: app.repo, name: app.name, ...confirmed })),
            )
          }
        >
          {yours ? (app.state === 'running' ? 'Running' : 'Starting…') : `Open ${app.name}`}
        </Button>
      </>
    )
  } else {
    const { app, again } = choice
    detail = again ? `${app.name} · ${appStatusLine(app, now)}` : `${app.name} isn’t running`
    action = (
      <>
        {again && onOpenApp && (
          <ActionButton
            type="button"
            className={styles.link}
            onClick={() => onOpenApp({ repo: app.repo, name: app.name })}
          >
            Log
          </ActionButton>
        )}
        <Button
          size="small"
          variant="primary"
          disabled={busy || task.archived !== undefined}
          onClick={() =>
            confirm((confirmed) =>
              act(() => ted.startApp(task.id, { repo: app.repo, name: app.name, ...confirmed })),
            )
          }
        >
          {again ? 'Run again' : 'Run'}
        </Button>
      </>
    )
  }

  return (
    <div className={styles.row}>
      <span className={styles.icon} aria-hidden>
        <PlayIcon />
      </span>
      <span className={styles.text}>
        <span className={styles.title}>Preview</span>
        <span className={styles.detail}>{detail}</span>
        {error !== undefined && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </span>
      <span className={styles.actions}>{action}</span>
      {dialog}
    </div>
  )
}
