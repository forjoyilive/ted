import type { SimulatorSlots, Task, TaskApp } from '@ted/protocol'
import { isSimulatorApp } from '@ted/protocol/app'
import { useEffect, useRef, useState } from 'react'
import {
  appStatusLine,
  appsSummary,
  type HostedPreview,
  hostedPreviews,
  isLive,
  needsSlot,
} from '../apps.ts'
import { useSimulators, useTaskApps } from '../data.ts'
import { useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import styles from './Apps.module.css'
import { Button } from './Button.tsx'
import { DetailsSection } from './DetailsSection.tsx'
import { OpenIcon, PlayIcon, RestartIcon, StopIcon } from './icons.tsx'
import { useOutsideSandbox } from './OutsideSandboxDialog.tsx'
import { firstChoice, SimulatorChoices } from './SimulatorChoices.tsx'

export interface ShownApp {
  browser?: boolean
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
  const simulators = useSimulators()
  const hosted = hostedPreviews(task)
  if (apps.length === 0 && hosted.length === 0) return null
  const repos = [...new Set([...apps.map((a) => a.repo), ...hosted.map((h) => h.repo)])]
  const grouped = task.repos.filter((r) => !r.removed).length > 1 || repos.length > 1
  const summary = appsSummary(apps, hosted.length)
  return (
    <DetailsSection id="apps" title="Apps" summary={summary}>
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
                  simulators={simulators}
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
    </DetailsSection>
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
  const runnable = !task.archived && task.stage !== 'done' && !app.removed
  const { confirm, dialog } = useOutsideSandbox(task, app)
  return {
    busy,
    error,
    live,
    runnable,
    dialog,
    preview: () => act(() => ted.openAppPreview(task.id, app.repo, app.name)),
    start: (shutDown?: string) =>
      confirm(() => act(() => ted.startApp(task.id, app.repo, app.name, shutDown))),
    show: () => act(() => ted.showApp(task.id, app.repo, app.name)),
    stop: () => act(() => ted.stopApp(task.id, app.repo, app.name)),
    restart: () => confirm(() => act(() => ted.restartApp(task.id, app.repo, app.name))),
  }
}

function AppRow({
  task,
  app,
  simulators,
  selected,
  onOpen,
}: {
  task: Task
  app: TaskApp
  simulators: SimulatorSlots | undefined
  selected: boolean
  onOpen: () => void
}) {
  const now = useNow()
  const actions = useAppActions(task, app)
  const { busy, live, runnable } = actions
  const [choosing, setChoosing] = useState<DOMRect>()
  const row = useRef<HTMLLIElement>(null)
  const run = () => {
    const rect = row.current?.getBoundingClientRect()
    if (needsSlot(app, simulators) && rect) setChoosing(rect)
    else actions.start()
  }
  return (
    <li ref={row} className={styles.row} data-selected={selected || undefined}>
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
        {isSimulatorApp(app) && (
          <button
            type="button"
            className={styles.action}
            aria-label={`Show ${app.name}`}
            title="Show the simulator"
            disabled={busy || app.simulator?.booted !== true}
            onClick={actions.show}
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
            aria-expanded={isSimulatorApp(app) ? choosing !== undefined : undefined}
            disabled={busy || !runnable}
            onClick={run}
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
      {actions.dialog}
      {choosing && simulators && (
        <SlotPopover
          task={task}
          app={app}
          simulators={simulators}
          anchor={choosing}
          onCancel={() => setChoosing(undefined)}
          onRun={(udid) => {
            setChoosing(undefined)
            actions.start(udid)
          }}
        />
      )}
    </li>
  )
}

function SlotPopover({
  task,
  app,
  simulators,
  anchor,
  onCancel,
  onRun,
}: {
  task: Task
  app: TaskApp
  simulators: SimulatorSlots
  anchor: DOMRect
  onCancel: () => void
  onRun: (udid: string) => void
}) {
  const now = useNow()
  const [chosen, setChosen] = useState(() => firstChoice(simulators.booted))
  const owner = simulators.booted.find((b) => b.udid === chosen)?.displayId
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onCancel])
  const count = simulators.booted.length
  const below = window.innerHeight - anchor.bottom > 240
  const place = {
    right: Math.max(8, window.innerWidth - anchor.right),
    ...(below
      ? { top: anchor.bottom + 4 }
      : { bottom: Math.max(8, window.innerHeight - anchor.top + 4) }),
  }
  return (
    <div
      className={styles.popover}
      style={place}
      role="dialog"
      aria-label="Choose a simulator to shut down"
    >
      <h3 className={styles.popoverTitle}>
        {count === 1 ? 'The only simulator slot is taken' : `All ${count} simulators are booted`}
      </h3>
      <p className={styles.popoverText}>
        {`Running ${app.name} for ${task.displayId} needs one of them shut down. Its app and state stay; it boots again when needed.`}
      </p>
      <SimulatorChoices
        booted={simulators.booted}
        chosen={chosen}
        onChoose={setChosen}
        now={now}
        label="Simulator to shut down"
      />
      <div className={styles.popoverButtons}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          disabled={chosen === undefined}
          onClick={() => chosen !== undefined && onRun(chosen)}
        >
          {owner !== undefined ? `Shut down ${owner}’s and run` : 'Shut down and run'}
        </Button>
      </div>
    </div>
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
