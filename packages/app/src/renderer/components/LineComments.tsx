import type { DiffRow, LineComment } from '@ted/protocol'
import { lineLabel } from '@ted/protocol/changes'
import { useEffect, useRef, useState } from 'react'
import type { ChangedFile } from '../changes.ts'
import { useEventValue } from '../data.ts'
import { useProfile } from '../profile.tsx'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import { rowKey } from './DiffTable.tsx'
import type { DiffSeams } from './DiffViews.tsx'
import { Help } from './Help.tsx'
import styles from './LineComments.module.css'

const settleMs = 1_500

export function useLineComments(taskId: string): LineComment[] {
  return useEventValue<LineComment[]>({
    initial: [],
    key: taskId,
    focus: true,
    load: () => ted.lineComments(taskId),
    event: (event) => {
      if (event.type === 'line-comments-changed' && event.taskId === taskId) return 'reload'
      if (
        (event.type === 'task-updated' && event.task.id === taskId) ||
        event.type === 'run-output'
      )
        return settleMs
      return undefined
    },
  }).value
}

export const isDraft = (comment: LineComment) => comment.sent === undefined

export function draftCount(drafts: readonly LineComment[]): string {
  const files = new Set(drafts.map((d) => `${d.repo}\0${d.path}`)).size
  return `${drafts.length} draft ${drafts.length === 1 ? 'comment' : 'comments'} on ${files} ${files === 1 ? 'file' : 'files'}`
}

const lastRow = (comment: LineComment) => comment.quoted.at(-1)

const inFile = (comment: LineComment, file: ChangedFile) =>
  comment.repo === file.repo && comment.path === file.path

function rangeLabel(rows: readonly DiffRow[]): string {
  const side = rows.some((r) => r.new !== undefined) ? 'new' : 'old'
  const numbers = rows.flatMap((r) => r[side] ?? [])
  const label = lineLabel({ start: Math.min(...numbers), end: Math.max(...numbers) })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

type Editing =
  | { kind: 'new'; repo: string; path: string; rows: DiffRow[] }
  | { kind: 'edit'; id: string }

export function useDiffComments(taskId: string, comments: readonly LineComment[]): DiffSeams {
  const [editing, setEditing] = useState<{ taskId: string; editing: Editing }>()
  const open = editing?.taskId === taskId ? editing.editing : undefined
  const close = () => setEditing(undefined)
  const picking = (file: ChangedFile) =>
    open?.kind === 'new' && open.repo === file.repo && open.path === file.path ? open : undefined

  return {
    gutter: (file) => {
      const picked = picking(file)
      const keys = new Set(picked?.rows.map(rowKey))
      return {
        onPick: (_, rows) =>
          setEditing({
            taskId,
            editing: { kind: 'new', repo: file.repo, path: file.path, rows },
          }),
        picked: (row) => keys.has(rowKey(row)),
      }
    },
    after: (file) => {
      const here = comments.filter((c) => inFile(c, file))
      const picked = picking(file)
      return (row) => {
        const key = rowKey(row)
        const cards = here.filter((c) => {
          const last = lastRow(c)
          return last !== undefined && rowKey(last) === key
        })
        const editor = picked && rowKey(picked.rows.at(-1) ?? {}) === key
        if (cards.length === 0 && !editor) return undefined
        return (
          <div className={styles.stack}>
            {cards.map((c) =>
              open?.kind === 'edit' && open.id === c.id ? (
                <LineCommentEditor
                  key={c.id}
                  label={lineLabel(c)}
                  initial={c.body}
                  saveLabel="Save"
                  onSave={async (body) => {
                    await ted.editLineComment(c.id, body)
                    close()
                  }}
                  onCancel={close}
                />
              ) : (
                <LineCommentCard
                  key={c.id}
                  comment={c}
                  onEdit={() => setEditing({ taskId, editing: { kind: 'edit', id: c.id } })}
                />
              ),
            )}
            {editor && (
              <LineCommentEditor
                label={rangeLabel(picked.rows)}
                saveLabel="Add comment"
                onSave={async (body) => {
                  const first = picked.rows[0]
                  const last = picked.rows.at(-1)
                  if (!first || !last) return
                  await ted.draftLineComment(taskId, {
                    repo: picked.repo,
                    path: picked.path,
                    from: anchor(first),
                    to: anchor(last),
                    body,
                  })
                  close()
                }}
                onCancel={close}
              />
            )}
          </div>
        )
      }
    },
  }
}

const anchor = (row: DiffRow) => ({
  ...(row.old !== undefined && { old: row.old }),
  ...(row.new !== undefined && { new: row.new }),
})

function LineCommentCard({ comment, onEdit }: { comment: LineComment; onEdit: () => void }) {
  const profile = useProfile()
  const draft = isDraft(comment)
  const [error, setError] = useState<string>()
  return (
    <article className={styles.card} aria-label={`Line comment on ${lineLabel(comment)}`}>
      <div className={styles.head}>
        <span className={styles.author}>{profile.name}</span>
        <span className={styles.meta}>
          · {draft ? 'draft' : 'sent'} · {lineLabel(comment)}
        </span>
        {comment.outdated && <span className={styles.outdated}>Outdated</span>}
        <span className={styles.spacer} />
        {draft && (
          <>
            <button type="button" className={styles.link} onClick={onEdit}>
              Edit
            </button>
            <button
              type="button"
              className={styles.link}
              onClick={() =>
                void ted
                  .deleteLineComment(comment.id)
                  .catch((failed: unknown) => setError(readableError(failed)))
              }
            >
              Delete
            </button>
          </>
        )}
      </div>
      <p className={styles.body}>{comment.body}</p>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </article>
  )
}

function LineCommentEditor({
  label,
  initial = '',
  saveLabel,
  onSave,
  onCancel,
}: {
  label: string
  initial?: string
  saveLabel: string
  onSave: (body: string) => Promise<void>
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const ready = text.trim() !== '' && !saving
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])
  const save = async () => {
    if (!ready) return
    setSaving(true)
    setError(undefined)
    try {
      await onSave(text)
    } catch (failed) {
      setError(readableError(failed))
      setSaving(false)
    }
  }
  return (
    <div className={styles.editor}>
      <textarea
        className={styles.box}
        aria-label="Line comment"
        value={text}
        ref={box}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void save()
          }
        }}
      />
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.editorRow}>
        <span className={styles.meta}>{label}</span>
        <span className={styles.spacer} />
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="small" variant="primary" disabled={!ready} onClick={() => void save()}>
          {saveLabel}
        </Button>
      </div>
    </div>
  )
}

export type DraftsMode = 'request' | 'none' | 'done'

export function DraftBar({
  taskId,
  drafts,
  mode,
  onBack,
}: {
  taskId: string
  drafts: readonly LineComment[]
  mode: DraftsMode
  onBack: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (drafts.length === 0) return null
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={styles.bar} aria-label="Draft line comments">
      <span className={styles.count}>{draftCount(drafts)}</span>
      <Help>
        {mode === 'request'
          ? 'Drafts go with Request changes or the next Comment you send. Approve never sends them.'
          : mode === 'done'
            ? 'This Task is done. Drafts go with Follow up.'
            : 'Drafts go with the next Comment you send. Send to Task Lead sends them now as one Comment.'}
      </Help>
      {error !== undefined && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
      <span className={styles.spacer} />
      <Button
        size="small"
        disabled={busy}
        onClick={() => void run(() => ted.discardLineComments(taskId))}
      >
        Discard all
      </Button>
      {mode === 'request' ? (
        <Button size="small" variant="primary" onClick={onBack}>
          Back to sign-off
        </Button>
      ) : mode === 'none' ? (
        <Button
          size="small"
          variant="primary"
          disabled={busy}
          onClick={() => void run(() => ted.sendLineComments(taskId))}
        >
          Send to Task Lead
        </Button>
      ) : null}
    </section>
  )
}

export function UnsentChip({
  drafts,
  onOpen,
}: {
  drafts: readonly LineComment[]
  onOpen: (comment: LineComment) => void
}) {
  const [open, setOpen] = useState(false)
  if (drafts.length === 0) return null
  return (
    <div className={styles.chipWrap}>
      <button
        type="button"
        className={styles.chip}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {drafts.length} unsent line {drafts.length === 1 ? 'comment' : 'comments'}
      </button>
      {open && (
        <ul className={styles.chipList} aria-label="Unsent line comments">
          {drafts.map((c) => (
            <li key={c.id}>
              <button type="button" className={styles.lineLink} onClick={() => onOpen(c)}>
                {c.path} · {lineLabel(c)}
              </button>
              <span className={styles.preview}>{c.body}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function SentLineComments({
  comments,
  taskId,
  current,
  onOpen,
}: {
  comments: readonly LineComment[]
  taskId: string
  current: readonly LineComment[]
  onOpen: (comment: LineComment) => void
}) {
  const [open, setOpen] = useState(false)
  const outdated = new Set(current.filter((c) => c.outdated).map((c) => c.id))
  return (
    <div className={styles.sent}>
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? '▾' : '▸'} {comments.length} line {comments.length === 1 ? 'comment' : 'comments'}
      </button>
      {open && (
        <ul className={styles.sentList}>
          {comments.map((c) => (
            <li key={c.id}>
              <div className={styles.head}>
                {c.taskId === taskId ? (
                  <button type="button" className={styles.lineLink} onClick={() => onOpen(c)}>
                    {c.path} · {lineLabel(c)}
                  </button>
                ) : (
                  <span className={styles.meta}>
                    {c.path} · {lineLabel(c)}
                  </span>
                )}
                {outdated.has(c.id) && <span className={styles.outdated}>Outdated</span>}
              </div>
              <p className={styles.body}>{c.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
