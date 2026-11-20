import type { BlockerEnded, GitHubWait, Task, TaskMarker, TaskRun, TaskStatus } from '@ted/protocol'
import { statusLabel } from '@ted/protocol/task-status'
import { snoozeTime } from '../request-snooze.ts'
import { ago, useNow } from '../requests.ts'
import { formatDate } from '../time.ts'
import { RunIcon, type RunIconState } from './RunIcon.tsx'
import { StatusChip, type StatusGlyph, type StatusTone } from './StatusChip.tsx'
import styles from './TaskStatus.module.css'

const gitHubGlyphs: Record<GitHubWait, StatusGlyph> = {
  ci: 'ci',
  review: 'review',
  merge: 'merge',
  'sign-in': 'ci',
  rerun: 'ci',
  'required-check': 'ci',
}

function look(status: TaskStatus): { tone: StatusTone; glyph: StatusGlyph } {
  switch (status.kind) {
    case 'failed':
      return { tone: 'failed', glyph: 'failed' }
    case 'partly-merged':
      return { tone: 'failed', glyph: 'partly' }
    case 'waiting-on-you':
      return { tone: status.snoozedUntil === undefined ? 'waiting' : 'snoozed', glyph: 'waiting' }
    case 'paused':
      return { tone: 'neutral', glyph: 'paused' }
    case 'working':
      return { tone: 'working', glyph: 'working' }
    case 'stopped':
      return { tone: status.prepared ? 'success' : 'stopped', glyph: 'stopped' }
    case 'blocked':
      return { tone: 'neutral', glyph: 'blocked' }
    case 'queued':
      return { tone: 'working', glyph: 'queued' }
    case 'waiting-for-github':
      return { tone: 'neutral', glyph: gitHubGlyphs[status.on] }
  }
}

function BlockedBy({
  by,
  ended,
  onOpenTask,
  tall = false,
}: {
  by: string
  ended?: BlockerEnded | undefined
  onOpenTask: (ref: string) => void
  tall?: boolean
}) {
  return (
    <StatusChip tone="neutral" glyph="blocked" tall={tall}>
      {ended ? `Blocked by ${ended}` : 'Blocked by'}
      {ended === 'deleted' ? (
        <span>{by}</span>
      ) : (
        <button
          type="button"
          className={styles.link}
          onClick={(event) => {
            event.stopPropagation()
            onOpenTask(by)
          }}
        >
          {by}
        </button>
      )}
    </StatusChip>
  )
}

function Marker({
  marker,
  onOpenTask,
  tall,
}: {
  marker: TaskMarker
  onOpenTask: (ref: string) => void
  tall: boolean
}) {
  const markerClass = tall ? `${styles.marker} ${styles.tall}` : styles.marker
  if (marker.kind === 'test-activity') {
    return (
      <StatusChip
        tall={tall}
        tone={marker.phase === 'running' ? 'testing' : 'neutral'}
        glyph={marker.phase === 'running' ? 'working' : 'queued'}
        title={marker.detail}
      >
        {marker.label}
      </StatusChip>
    )
  }
  if (marker.kind === 'blocked-by') {
    return <BlockedBy by={marker.by} ended={marker.ended} onOpenTask={onOpenTask} tall={tall} />
  }
  if (marker.kind === 'snoozed') {
    return (
      <span
        className={markerClass}
        title={formatDate(marker.until, { dateStyle: 'full', timeStyle: 'long' })}
      >
        Scheduled ·{' '}
        {formatDate(marker.until, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
    )
  }
  return (
    <span className={markerClass}>
      {marker.kind === 'preparing' ? 'Preparing through Design' : 'Needs planning'}
    </span>
  )
}

function statusTitle(status: TaskStatus): string | undefined {
  if (status.kind === 'waiting-on-you' && status.snoozedUntil !== undefined)
    return `Snoozed until ${snoozeTime(status.snoozedUntil)}`
  return undefined
}

function detailedLabel(status: TaskStatus, now: number): string {
  if (status.kind === 'stopped' && !status.prepared && status.at !== undefined) {
    return `Stopped by you · ${ago(status.at, now)}`
  }
  return statusLabel(status)
}

const startsAutomaticallyTitle =
  'Backlog starts is on for this Factory, so Ted starts this Task when there’s room.'

export function TaskStatusChips({
  task,
  onOpenTask,
  detailed = false,
  tall = false,
  hideWaiting = false,
  startsAutomatically = false,
}: {
  task: Pick<Task, 'status' | 'markers'>
  onOpenTask: (ref: string) => void
  detailed?: boolean
  tall?: boolean
  hideWaiting?: boolean
  startsAutomatically?: boolean
}) {
  const now = useNow()
  const { markers } = task
  const testsRunning = markers.some((m) => m.kind === 'test-activity' && m.phase === 'running')
  const status =
    (hideWaiting &&
      task.status?.kind === 'waiting-on-you' &&
      task.status.snoozedUntil === undefined) ||
    (testsRunning && task.status?.kind === 'working' && task.status.app === undefined)
      ? undefined
      : task.status
  if (!task.status && markers.length === 0 && startsAutomatically) {
    return (
      <span className={styles.chips}>
        <StatusChip tone="neutral" glyph="starts" tall={tall} title={startsAutomaticallyTitle}>
          Starts automatically
        </StatusChip>
      </span>
    )
  }
  if (!status && markers.length === 0) return null
  return (
    <span className={styles.chips}>
      {markers
        .filter((marker) => marker.kind !== 'test-activity')
        .map((marker) => (
          <Marker key={marker.kind} marker={marker} onOpenTask={onOpenTask} tall={tall} />
        ))}
      {status?.kind === 'blocked' ? (
        <BlockedBy by={status.by} ended={status.ended} onOpenTask={onOpenTask} tall={tall} />
      ) : (
        status && (
          <StatusChip {...look(status)} tall={tall} title={statusTitle(status)}>
            {detailed ? detailedLabel(status, now) : statusLabel(status)}
          </StatusChip>
        )
      )}
      {markers
        .filter((marker) => marker.kind === 'test-activity')
        .map((marker) => (
          <Marker
            key={`${marker.source}-${marker.phase}`}
            marker={marker}
            onOpenTask={onOpenTask}
            tall={tall}
          />
        ))}
    </span>
  )
}

const iconStates: Record<TaskRun['state'], RunIconState> = {
  working: 'working',
  waiting: 'waiting',
  idle: 'idle',
  finished: 'idle',
}

export function RunIcons({
  runs,
  stacked = false,
}: {
  runs: readonly TaskRun[]
  stacked?: boolean
}) {
  if (runs.length === 0) return null
  const shown = runs.slice(0, 3)
  return (
    <span className={stacked ? styles.stacked : styles.runs}>
      {shown.map((run) => (
        <RunIcon
          key={run.id}
          agent={run.agent}
          state={
            run.paused !== undefined ? 'paused' : run.onSubAgents ? 'idle' : iconStates[run.state]
          }
        />
      ))}
      {runs.length > shown.length && (
        <span className={styles.more}>+{runs.length - shown.length}</span>
      )}
    </span>
  )
}
