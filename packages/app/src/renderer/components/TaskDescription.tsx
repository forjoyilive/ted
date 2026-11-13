import type { DescriptionVersion, Task } from '@ted/protocol'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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
  a: ({ children }) => <span data-preview-link>{children}</span>,
  img: ({ alt }) => <>{alt}</>,
}

export function TaskDescription({ task }: { task: Task }) {
  return <Description key={task.id} task={task} />
}

function Description({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const [links, setLinks] = useState(false)
  const preview = useRef<HTMLDivElement>(null)
  const contentId = useId()
  const descriptions = useDescriptionsState(task.id)
  const versions = descriptions.value
  const original = versions?.[0]?.text ?? ''
  const edits = Math.max(0, (versions?.length ?? 1) - 1)
  const images = task.attachments.filter(showsInline)
  const files = task.attachments.filter((file) => !showsInline(file))
  useLayoutEffect(() => {
    const element = preview.current
    if (open) return
    if (!element || original.trim() === '') {
      setOverflow(false)
      setLinks(false)
      return
    }
    const measure = () => {
      setOverflow(element.scrollHeight > element.clientHeight)
      setLinks(element.querySelector('[data-preview-link]') !== null)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [original, open])
  const seeMore = (open || overflow || links || files.length > 0) && versions !== undefined
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
        <div id={contentId}>
          {open ? (
            original.trim() && <Markdown text={original} className={styles.text} />
          ) : original.trim() ? (
            <div ref={preview} className={styles.preview}>
              <div className={`${markdownStyles.markdown} ${styles.text}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={previewComponents}>
                  {original}
                </ReactMarkdown>
              </div>
            </div>
          ) : images.length === 0 ? (
            <p className={styles.empty}>No description.</p>
          ) : null}
          {images.length > 0 && (
            <div className={open ? styles.expandedImages : styles.images}>
              <CommentFiles files={images} />
            </div>
          )}
          {open && files.length > 0 && <CommentFiles files={files} />}
        </div>
      )}
      {(seeMore || edits > 0) && (
        <div className={styles.controls}>
          {seeMore && (
            <button
              type="button"
              className={styles.link}
              aria-expanded={open}
              aria-controls={contentId}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? 'See less' : 'See more'}
            </button>
          )}
          {edits > 0 && (
            <button type="button" className={styles.link} onClick={() => setHistory(true)}>
              {`Edited ${edits === 1 ? 'once' : `${edits} times`} · history`}
            </button>
          )}
        </div>
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
