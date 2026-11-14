import type { TaskApp } from '@ted/protocol'
import { isDeviceApp, isEmulatorApp } from '@ted/protocol/app'
import { useState } from 'react'
import { appStatusLine, isLive } from '../apps.ts'
import { useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import { LogBody } from './AppLogView.tsx'
import styles from './Apps.module.css'
import type { ShownApp } from './AppsSection.tsx'
import { StatusDot } from './AppsSection.tsx'
import { Button } from './Button.tsx'
import { OpenIcon, StopIcon } from './icons.tsx'

function useRunAppActions(runId: string, app: TaskApp) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const act = (request: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    return request()
      .catch((failed: unknown) => setError(readableError(failed)))
      .finally(() => setBusy(false))
  }
  const ref = { repo: app.repo, name: app.name }
  return {
    busy,
    error,
    live: isLive(app),
    preview: () => act(() => ted.openRunAppPreview(runId, app.repo, app.name)),
    show: () => act(() => ted.showRunApp(runId, ref)),
    stop: () => act(() => ted.stopRunApp(runId, ref)),
  }
}

export function RunAppRows({
  runId,
  apps,
  shown,
  onOpen,
}: {
  runId: string
  apps: readonly TaskApp[]
  shown: ShownApp | undefined
  onOpen: (app: ShownApp) => void
}) {
  const grouped = new Set(apps.map((a) => a.repo)).size > 1
  return (
    <ul className={styles.list}>
      {apps.map((app) => (
        <RunAppRow
          key={`${app.repo}/${app.name}`}
          runId={runId}
          app={app}
          grouped={grouped}
          selected={shown?.repo === app.repo && shown.name === app.name}
          onOpen={() => onOpen({ repo: app.repo, name: app.name })}
        />
      ))}
    </ul>
  )
}

function runAppStatus(app: TaskApp, now: number): string {
  if (app.state === 'waiting') {
    const since = app.startedAt === undefined ? undefined : minutesSince(app.startedAt, now)
    return [
      `Waiting for ${isEmulatorApp(app) ? 'an emulator' : 'a simulator'} slot`,
      since,
      app.simulator?.device,
    ]
      .filter((part) => part !== undefined)
      .join(' · ')
  }
  return appStatusLine(app, now)
}

function minutesSince(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000))
  return minutes === 0 ? 'just now' : `${minutes} min`
}

function RunAppRow({
  runId,
  app,
  grouped,
  selected,
  onOpen,
}: {
  runId: string
  app: TaskApp
  grouped: boolean
  selected: boolean
  onOpen: () => void
}) {
  const now = useNow()
  const actions = useRunAppActions(runId, app)
  return (
    <li className={styles.row} data-selected={selected || undefined}>
      <ActionButton
        type="button"
        className={styles.open}
        title={`Show ${app.name}’s log`}
        onClick={onOpen}
      >
        <StatusDot state={app.state} />
        <span className={styles.text}>
          <span className={styles.name}>{grouped ? `${app.repo} · ${app.name}` : app.name}</span>
          <span className={styles.status} data-state={app.state}>
            {runAppStatus(app, now)}
          </span>
          {actions.error !== undefined && (
            <span className={styles.error} role="alert">
              {actions.error}
            </span>
          )}
        </span>
      </ActionButton>
      <span className={styles.actions}>
        {app.kind === 'web' && (
          <ActionButton
            type="button"
            className={styles.action}
            aria-label={`Preview ${app.name}`}
            title="Preview"
            disabled={actions.busy || app.state !== 'running'}
            onClick={actions.preview}
          >
            <OpenIcon />
          </ActionButton>
        )}
        {isDeviceApp(app) && (
          <ActionButton
            type="button"
            className={styles.action}
            aria-label={`Show ${app.name}`}
            title={`Show the ${isEmulatorApp(app) ? 'emulator' : 'simulator'}`}
            disabled={actions.busy || app.simulator?.booted !== true}
            onClick={actions.show}
          >
            <OpenIcon />
          </ActionButton>
        )}
        <ActionButton
          type="button"
          className={styles.action}
          aria-label={`Stop ${app.name}`}
          title="Stop"
          disabled={actions.busy || !actions.live}
          onClick={actions.stop}
        >
          <StopIcon />
        </ActionButton>
      </span>
    </li>
  )
}

export function RunAppLog({
  runId,
  apps,
  shown,
  onBack,
}: {
  runId: string
  apps: readonly TaskApp[]
  shown: ShownApp
  onBack: () => void
}) {
  const now = useNow()
  const app = apps.find((a) => a.repo === shown.repo && a.name === shown.name)
  const actions = useRunAppActions(runId, app ?? { ...shown, kind: 'web', state: 'stopped' })
  return (
    <section className={styles.logPane} aria-label={`${shown.name} log`}>
      <button type="button" className={styles.back} onClick={onBack}>
        ← Conversation
      </button>
      <header className={styles.logHeader}>
        {app && <StatusDot state={app.state} />}
        <h2 className={styles.logTitle}>{shown.name}</h2>
        <span className={styles.repoChip}>{shown.repo}</span>
        {app && <span className={styles.logStatus}>{runAppStatus(app, now)}</span>}
        <span className={styles.logActions}>
          <Button disabled={actions.busy || !actions.live} onClick={actions.stop}>
            Stop
          </Button>
        </span>
        {actions.error !== undefined && (
          <p className={styles.error} role="alert">
            {actions.error}
          </p>
        )}
      </header>
      <LogBody
        key={`${runId}:${shown.repo}:${shown.name}`}
        load={() => ted.runAppLog(runId, { repo: shown.repo, name: shown.name })}
      />
    </section>
  )
}
