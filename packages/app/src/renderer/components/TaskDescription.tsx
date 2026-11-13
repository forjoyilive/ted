import type { DescriptionVersion, Task } from '@ted/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useDescriptionsState } from '../data.ts'
import { formatDate } from '../time.ts'
import { CommentFiles, showsInline } from './CommentFiles.tsx'
import { CloseIcon } from './icons.tsx'
import { LoadingError, Skeleton } from './Loading.tsx'
import markdownStyles from './Markdown.module.css'
import { Markdown } from './Markdown.tsx'
import styles from './TaskDescription.module.css'

const previewComponents: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <>{alt}</>,
}

export function TaskDescription({ task }: { task: Task }) {
  return <Description key={task.id} task={task} />
}

function Description({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState(false)
  const descriptions = useDescriptionsState(task.id)
  const versions = descriptions.value
  const original = versions?.[0]?.text ?? ''
  const edits = Math.max(0, (versions?.length ?? 1) - 1)
  const images = task.attachments.filter(showsInline)
  const files = task.attachments.filter((file) => !showsInline(file))
  const blank = original.trim() === '' && images.length === 0 && files.length === 0
  if (
    blank &&
    !descriptions.error &&
    (versions === undefined ? task.description.trim() === '' : edits === 0)
  ) {
    return null
  }
  return (
    <section className={styles.request} aria-label="Original request">
      {descriptions.error && <LoadingError error={descriptions.error} retry={descriptions.retry} />}
      {versions === undefined ? (
        !descriptions.error && <Skeleton rows={1} label="Loading original request…" />
      ) : (
        <div className={styles.row}>
          {original.trim() ? (
            <div className={styles.preview}>
              <div className={`${markdownStyles.markdown} ${styles.text}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={previewComponents}>
                  {original}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            blank && <p className={styles.empty}>No description.</p>
          )}
          <button
            type="button"
            className={styles.link}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            See description
          </button>
        </div>
      )}
      {open && versions !== undefined && (
        <DescriptionDialog
          task={task}
          text={original}
          images={images}
          files={files}
          edits={edits}
          onHistory={() => setHistory(true)}
          onClose={() => setOpen(false)}
        />
      )}
      {history && (
        <DescriptionHistory
          task={task}
          versions={versions}
          error={descriptions.error}
          retry={descriptions.retry}
          onClose={() => setHistory(false)}
        />
      )}
    </section>
  )
}

function DescriptionDialog({
  task,
  text,
  images,
  files,
  edits,
  onHistory,
  onClose,
}: {
  task: Task
  text: string
  images: Task['attachments']
  files: Task['attachments']
  edits: number
  onHistory: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={`${styles.historyDialog} ${styles.descriptionDialog}`}
      aria-labelledby={headingId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        onClose()
      }}
    >
      <header className={styles.historyHead}>
        <h2 id={headingId} className={styles.historyHeading}>
          {`${task.displayId} · ${task.title}`}
        </h2>
        <button type="button" className={styles.historyClose} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className={styles.descriptionBody}>
        {text.trim() ? (
          <Markdown text={text} className={styles.text} />
        ) : (
          images.length === 0 &&
          files.length === 0 && <p className={styles.empty}>No description.</p>
        )}
        {images.length > 0 && (
          <div className={styles.expandedImages}>
            <CommentFiles files={images} />
          </div>
        )}
        {files.length > 0 && <CommentFiles files={files} />}
      </div>
      {edits > 0 && (
        <footer className={styles.descriptionFoot}>
          <button type="button" className={styles.link} onClick={onHistory}>
            {`Edited ${edits === 1 ? 'once' : `${edits} times`} · history`}
          </button>
        </footer>
      )}
    </dialog>
  )
}

function DescriptionHistory({
  task,
  versions,
  error,
  retry,
  onClose,
}: {
  task: Task
  versions: readonly DescriptionVersion[] | undefined
  error: string | undefined
  retry: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={styles.historyDialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className={styles.historyHead}>
        <h2 id={headingId} className={styles.historyHeading}>
          {`${task.displayId} description history`}
        </h2>
        <button type="button" className={styles.historyClose} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <ol className={styles.historyList} aria-busy={versions === undefined && error === undefined}>
        {error ? (
          <li>
            <LoadingError error={error} retry={retry} />
          </li>
        ) : versions === undefined ? (
          <li>
            <Skeleton shape="history" label="Loading description history…" />
          </li>
        ) : null}
        {versions?.length === 0 && <li>No description history.</li>}
        {[...(versions ?? [])].reverse().map((v) => (
          <li key={v.version} className={styles.historyItem}>
            <p className={styles.historyMeta}>
              {v.version === 1
                ? `Original request · ${formatDate(v.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                : `Version ${v.version} · edited by you ${formatDate(v.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
              {v.version === versions?.length && versions.length > 1 ? ' · current' : ''}
            </p>
            <p className={styles.historyText}>
              {v.text.trim() === '' ? 'No description.' : v.text}
            </p>
          </li>
        ))}
      </ol>
    </dialog>
  )
}
