import type { TaskFileContent, TaskFileRef } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { useConnection } from '../data.ts'
import { openInEditor } from '../editor.ts'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import styles from './FileView.module.css'
import { Loading } from './Loading.tsx'

export function FileView({
  taskId,
  file,
  onBack,
  backLabel = '← Thread',
}: {
  taskId: string
  file: TaskFileRef
  onBack: () => void
  backLabel?: string
}) {
  const [content, setContent] = useState<TaskFileContent>()
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const { epoch } = useConnection()
  useEffect(() => {
    let current = true
    let latest = 0
    const load = () => {
      const call = ++latest
      setContent(undefined)
      setError(undefined)
      void ted.taskFile(taskId, file.repo, file.path).then(
        (loaded) => {
          if (current && call === latest) setContent(loaded)
        },
        (failure: unknown) => {
          if (current && call === latest) setError(readableError(failure))
        },
      )
    }
    void revision
    void epoch
    load()
    window.addEventListener('focus', load)
    return () => {
      current = false
      window.removeEventListener('focus', load)
    }
  }, [taskId, file.repo, file.path, revision, epoch])
  const lines =
    content?.kind === 'text'
      ? content.text.split('\n').map((text, index) => ({ number: index + 1, text }))
      : []
  return (
    <section className={styles.pane} aria-label="File contents">
      <header className={styles.header}>
        <Button variant="quiet" size="small" onClick={onBack}>
          {backLabel}
        </Button>
        <div className={styles.toolbar}>
          <span className={styles.path}>
            {file.repo} / {file.path}
          </span>
          <Button size="small" variant="quiet" onClick={() => setRevision((r) => r + 1)}>
            Refresh
          </Button>
          <Button
            size="small"
            variant="quiet"
            disabled={content?.kind !== 'text'}
            onClick={() => {
              void openInEditor({ taskId, repo: file.repo, file: file.path, snapshot: true }).catch(
                (failure: unknown) => setError(readableError(failure)),
              )
            }}
          >
            Open snapshot
          </Button>
        </div>
        <p className={styles.meta}>
          Current worktree contents · Read-only. Edits to the snapshot do not change Task files.
        </p>
      </header>
      {error && (
        <p role="alert" className={styles.message}>
          {error}
        </p>
      )}
      {content === undefined ? (
        !error && <Loading label="Loading file…" />
      ) : content.kind === 'text' ? (
        <pre className={styles.content}>
          {lines.map((line) => (
            <span className={styles.line} key={line.number}>
              <span aria-hidden className={styles.number}>
                {line.number}
              </span>
              {line.text || '\u200b'}
            </span>
          ))}
        </pre>
      ) : (
        <p className={styles.message}>{content.message}</p>
      )}
    </section>
  )
}
