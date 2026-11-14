import type { AsanaImportRow, AsanaSync, AsanaImportPreview as Preview, Task } from '@ted/protocol'
import { ownershipLine } from '@ted/protocol/asana-import'
import { useId } from 'react'
import { useSettings } from '../data.ts'
import { ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './AsanaImportPreview.module.css'
import { CloseIcon } from './icons.tsx'

export interface AsanaPreviewState {
  url: string
  preview?: Preview
  error?: string
}

function what(row: AsanaImportRow): { text: string; tone?: keyof typeof styles } {
  const action = row.action
  switch (action.kind) {
    case 'new':
      return {
        text: row.depth === 0 && row.completed ? 'New · complete in Asana' : 'New',
        tone: 'new',
      }
    case 'kept':
      return { text: `${action.displayId} · unchanged` }
    case 'linked':
      return { text: `${action.displayId} · moves under parent` }
    case 'done':
      return { text: `${action.displayId} · Done`, tone: 'done' }
    case 'complete':
      return { text: 'Complete · context', tone: 'done' }
    case 'archived':
      return { text: `${action.displayId} · archived, left alone` }
    case 'conflict':
      return { text: `${action.displayId} · under ${action.parentDisplayId}`, tone: 'warn' }
    case 'unreadable':
      return { text: 'Can’t read', tone: 'bad' }
  }
}

export function asanaCreateLabel(preview: Preview): string {
  if (preview.tracked) {
    const n = preview.create
    const moved = preview.rows.filter((row) => row.action.kind === 'linked').length
    if (n === 0)
      return `Move ${moved} ${moved === 1 ? 'Task' : 'Tasks'} under ${preview.tracked.displayId}`
    return `Add ${n} new ${n === 1 ? 'child' : 'children'} to ${preview.tracked.displayId}`
  }
  return `Create ${preview.create} ${preview.create === 1 ? 'Task' : 'Tasks'}`
}

function syncNote(sync: boolean, switchOn: boolean, tracked: boolean): string {
  const kept = tracked ? ' Tasks TED already tracks keep their own setting.' : ''
  if (!sync)
    return `The new Tasks won’t update Asana. Choose Sync with Asana in a Task’s menu to turn it on later.${kept}`
  if (!switchOn)
    return 'Task Sync is off in Settings, so TED won’t update Asana until you turn it on.'
  return `TED comments on each Asana task with each pull request and completes it once its Task merges.${kept}`
}

export function AsanaImportPreview({
  state,
  sync,
  onSyncChange,
  onRemove,
}: {
  state: AsanaPreviewState
  sync: boolean
  onSyncChange: (sync: boolean) => void
  onRemove: () => void
}) {
  const { preview, error } = state
  const syncId = useId()
  const syncOn = useSettings()?.asanaSync !== false
  const missing = preview?.rows.filter(
    (row) => row.action.kind === 'conflict' || row.action.kind === 'unreadable',
  )
  const problems = preview?.rows.flatMap((row) =>
    (row.problems ?? []).map((problem) => `${row.name}: ${problem}`),
  )
  return (
    <section className={styles.card} aria-label="Asana import">
      <div className={styles.head}>
        <span className={styles.kind}>Asana</span>
        <span className={styles.text}>
          <span className={styles.title}>{preview?.root.name ?? 'Asana task'}</span>
          <span className={styles.note}>
            {preview === undefined && error === undefined
              ? 'Reading the task and everything under it from Asana…'
              : preview?.tracked
                ? `Already tracked as ${preview.tracked.displayId}. Existing Tasks keep their descriptions, Stage and Runs.`
                : 'TED creates a Task for this item and each unfinished item under it, with their descriptions, comments and files. Later changes in Asana don’t come across.'}
          </span>
        </span>
        <ActionButton
          type="button"
          className={styles.remove}
          aria-label="Remove source"
          onClick={onRemove}
        >
          <CloseIcon size={11} />
        </ActionButton>
      </div>
      {error !== undefined && (
        <p className={styles.refusal} role="status">
          {error}
        </p>
      )}
      {preview?.refusal !== undefined && (
        <p className={styles.refusal} role="status">
          {preview.refusal}
        </p>
      )}
      {preview && preview.refusal === undefined && (
        <>
          <span className={styles.summary}>{ownershipLine(preview)}</span>
          {preview.create > 0 && (
            <div className={styles.sync}>
              <input
                id={syncId}
                type="checkbox"
                className={styles.checkbox}
                checked={sync}
                onChange={(event) => onSyncChange(event.target.checked)}
              />
              <span className={styles.syncText}>
                <label className={styles.syncLabel} htmlFor={syncId}>
                  Sync these Tasks with Asana
                </label>
                <span className={styles.note} data-task-sync-note>
                  {syncNote(sync, syncOn, preview.tracked !== undefined)}
                </span>
              </span>
            </div>
          )}
          <span className={styles.note}>
            Priority and Start now apply to every new Task. Title, Task Lead, blockers, parent and
            attachments come from Asana and the Factory’s defaults instead.
          </span>
          <ul className={styles.tree} aria-label="Asana items">
            {preview.rows.map((row) => {
              const shown = what(row)
              return (
                <li
                  key={row.gid}
                  className={`${styles.row} ${row.action.kind === 'complete' ? styles.complete : ''}`}
                  data-gid={row.gid}
                >
                  <span className={styles.name} style={{ paddingLeft: `${row.depth * 14}px` }}>
                    {row.depth > 0 ? '└ ' : ''}
                    {row.name}
                  </span>
                  <span className={styles.who}>
                    {row.assignee ? (row.assignee.you ? 'You' : row.assignee.name) : 'Unassigned'}
                  </span>
                  <span className={`${styles.what} ${shown.tone ? styles[shown.tone] : ''}`}>
                    {shown.text}
                  </span>
                </li>
              )
            })}
          </ul>
          {preview.missing > 0 && (
            <div className={styles.problems} role="status">
              <strong>
                {`${preview.missing} ${preview.missing === 1 ? 'item needs' : 'items need'} your answer after import.`}
              </strong>{' '}
              The Task above {preview.missing === 1 ? 'it' : 'them'} won’t start until you answer.
              <ul>
                {(missing ?? []).map((row) => (
                  <li key={row.gid}>
                    {row.action.kind === 'unreadable'
                      ? `${row.name}: ${row.action.reason}.`
                      : row.action.kind === 'conflict'
                        ? `${row.name} is already ${row.action.displayId} under ${row.action.parentDisplayId}. TED leaves it there.`
                        : row.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {problems && problems.length > 0 && (
            <div className={styles.problems} role="status">
              <ul>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export function AsanaSourceField({ task }: { task: Task }) {
  const asana = task.source?.asana
  if (!asana) return null
  const who = asana.assignee
    ? `Assigned to ${asana.assignee.you ? 'you' : asana.assignee.name}`
    : 'Unassigned'
  const imported = formatDate(asana.importedAt, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  return (
    <span className={styles.sourceField}>
      <ActionButton
        type="button"
        className={styles.sourceLink}
        onClick={() => void ted.openTaskSource(task.id)}
      >
        {`Asana · ${asana.title} ↗`}
      </ActionButton>
      <span className={styles.sourceFacts}>
        {`${who} · ${asana.completed ? 'Complete in Asana' : 'Not complete'} · imported ${imported}`}
      </span>
    </span>
  )
}

export function taskSyncText(sync: AsanaSync): { state: string; why: string } {
  switch (sync.state) {
    case 'not-allowed':
      return {
        state: 'Not syncing',
        why: 'Choose Sync with Asana in the Task menu to let TED update this Asana task.',
      }
    case 'off':
      return {
        state: 'Paused: Task Sync is off',
        why: 'Turn on Task Sync in Settings → Integrations → Asana.',
      }
    case 'disconnected':
      return {
        state: 'Paused: Asana isn’t connected',
        why: 'TED catches up once you connect the same account in Settings → Integrations.',
      }
    case 'other-account':
      return {
        state: 'Paused',
        why: 'Sync was allowed under a different Asana account than the one connected now. Choose Sync with Asana in the Task menu to allow it again.',
      }
    case 'waiting-merge':
      return {
        state: 'Syncing',
        why: `TED comments with each pull request and completes the Asana task once they all merge.${
          sync.linked > 0
            ? ` ${sync.linked} ${sync.linked === 1 ? 'pull request' : 'pull requests'} linked.`
            : ''
        }`,
      }
    case 'waiting-children': {
      const n = sync.openChildren ?? 1
      return {
        state: 'Not completed yet',
        why: `Every pull request merged, but ${n} ${n === 1 ? 'task' : 'tasks'} under it in Asana ${n === 1 ? 'isn’t' : 'aren’t'} complete. ${n === 1 ? 'Its TED Task completes it' : 'Their TED Tasks complete them'} on merging, and TED completes this one after.`,
      }
    }
    case 'needs-answer':
      return {
        state: 'Waiting for your answer',
        why: 'Every pull request merged, but items under it in Asana have no TED Task. Answer the question in this Task’s thread.',
      }
    case 'left-open':
      return {
        state: 'Left open in Asana',
        why: 'You chose to leave it open while items under it are unfinished. TED asks again if a new one appears.',
      }
    case 'completed-by-ted':
      return {
        state: 'Completed by TED',
        why: `${sync.completedAt ? `${formatDate(sync.completedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, ` : ''}after every pull request merged.`,
      }
    case 'completed-in-asana':
      return {
        state: 'Completed in Asana by someone else',
        why: 'TED links any pull requests and leaves completion alone.',
      }
    case 'archived':
      return {
        state: 'Not syncing',
        why: 'This Task was archived without merging, so TED leaves the Asana task as it is.',
      }
  }
}

export function TaskSyncField({ sync }: { sync: AsanaSync }) {
  const text = taskSyncText(sync)
  return (
    <span className={styles.sourceField} data-task-sync={sync.state}>
      <span className={styles.syncState}>{text.state}</span>
      <span className={styles.sourceFacts}>{text.why}</span>
    </span>
  )
}
