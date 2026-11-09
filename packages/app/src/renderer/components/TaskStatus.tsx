import type { GitHubWait, Task, TaskMarker, TaskRun, TaskStatus } from '@ted/protocol'
import { RunIcon, type RunIconState } from './RunIcon.tsx'
import { StatusChip, type StatusGlyph, type StatusTone } from './StatusChip.tsx'
import styles from './TaskStatus.module.css'

const gitHubLabels: Record<GitHubWait, string> = {
  ci: 'Waiting for CI',
  review: 'Waiting for GitHub review',
  merge: 'Waiting for merge',
  'sign-in': 'Waiting for GitHub sign-in',
}

const gitHubGlyphs: Record<GitHubWait, StatusGlyph> = {
  ci: 'ci',
  review: 'review',
  merge: 'merge',
  'sign-in': 'ci',
}

export function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')
  return `${n}${suffix}`
}

export function statusLabel(status: TaskStatus): string {
  switch (status.kind) {
    case 'failed':
      return 'Failed'
    case 'partly-merged':
      return 'Partly merged'
    case 'waiting-on-you':
      return 'Waiting on you'
    case 'paused':
      return `Paused · ${status.reason}`
    case 'working':
      return 'Working'
    case 'stopped':
      return 'Stopped'
    case 'blocked':
      return `Blocked by ${status.by}`
    case 'queued':
      return `Queued · ${'place' in status ? ordinal(status.place) : status.hold}`
    case 'waiting-for-github':
      return gitHubLabels[status.on]
  }
}

function look(status: TaskStatus): { tone: StatusTone; glyph: StatusGlyph } {
  switch (status.kind) {
    case 'failed':
      return { tone: 'failed', glyph: 'failed' }
    case 'partly-merged':
      return { tone: 'failed', glyph: 'partly' }
    case 'waiting-on-you':
      return { tone: 'waiting', glyph: 'waiting' }
    case 'paused':
      return { tone: 'neutral', glyph: 'paused' }
    case 'working':
      return { tone: 'working', glyph: 'working' }
    case 'stopped':
      return { tone: 'neutral', glyph: 'stopped' }
    case 'blocked':
      return { tone: 'neutral', glyph: 'blocked' }
    case 'queued':
      return { tone: 'working', glyph: 'queued' }
    case 'waiting-for-github':
      return { tone: 'neutral', glyph: gitHubGlyphs[status.on] }
  }
}

function BlockedBy({ by, onOpenTask }: { by: string; onOpenTask: (ref: string) => void }) {
  return (
    <StatusChip tone="neutral" glyph="blocked">
      Blocked by
      <button type="button" className={styles.link} onClick={() => onOpenTask(by)}>
        {by}
      </button>
    </StatusChip>
  )
}

function Marker({ marker, onOpenTask }: { marker: TaskMarker; onOpenTask: (ref: string) => void }) {
  if (marker.kind === 'blocked-by') return <BlockedBy by={marker.by} onOpenTask={onOpenTask} />
  return <span className={styles.marker}>Needs planning</span>
}

export function TaskStatusChips({
  task,
  onOpenTask,
}: {
  task: Pick<Task, 'status' | 'markers'>
  onOpenTask: (ref: string) => void
}) {
  const { status, markers } = task
  if (!status && markers.length === 0) return null
  return (
    <span className={styles.chips}>
      {markers.map((marker) => (
        <Marker key={marker.kind} marker={marker} onOpenTask={onOpenTask} />
      ))}
      {status?.kind === 'blocked' ? (
        <BlockedBy by={status.by} onOpenTask={onOpenTask} />
      ) : (
        status && <StatusChip {...look(status)}>{statusLabel(status)}</StatusChip>
      )}
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
