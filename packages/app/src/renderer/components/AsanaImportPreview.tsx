import type { AsanaImportRow, AsanaImportPreview as Preview, Task } from '@ted/protocol'
import { ownershipLine } from '@ted/protocol/asana-import'
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
    return `Add ${n} new ${n === 1 ? 'child' : 'children'} to ${preview.tracked.displayId}`
  }
  return `Create ${preview.create} ${preview.create === 1 ? 'Task' : 'Tasks'}`
}

export function AsanaImportPreview({
  state,
  onRemove,
}: {
  state: AsanaPreviewState
  onRemove: () => void
}) {
  const { preview, error } = state
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
