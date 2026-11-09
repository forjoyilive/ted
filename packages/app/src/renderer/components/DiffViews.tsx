import type { FileDiff, TaskChanges } from '@ted/protocol'
import { useEffect, useRef, useState } from 'react'
import { type ChangedFile, changedFiles, splitPath } from '../changes.ts'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import { ChangeList, DiffCounts } from './ChangesSection.tsx'
import { DiffTable, type RowExtra } from './DiffTable.tsx'
import styles from './DiffViews.module.css'
import { ChevronIcon } from './icons.tsx'

export interface DiffSeams {
  after?: (file: ChangedFile) => RowExtra | undefined
  onOpenInEditor?: (file: ChangedFile) => void
}

function useFileDiffs(
  taskId: string,
  repo: string,
  file: string | undefined,
  version: unknown,
): { diffs?: FileDiff[]; error?: string } {
  const [state, setState] = useState<{ key: string; diffs?: FileDiff[]; error?: string }>()
  const key = `${taskId}\0${repo}\0${file ?? ''}`
  useEffect(() => {
    void version
    let live = true
    void ted.fileDiffs(taskId, repo, file).then(
      (diffs) => {
        if (live) setState({ key, diffs })
      },
      (error: unknown) => {
        if (live) setState({ key, error: readableError(error) })
      },
    )
    return () => {
      live = false
    }
  }, [taskId, repo, file, key, version])
  if (state?.key !== key) return {}
  return {
    ...(state.diffs !== undefined && { diffs: state.diffs }),
    ...(state.error !== undefined && { error: state.error }),
  }
}

function FilePath({ path }: { path: string }) {
  const { name, folder } = splitPath(path)
  return (
    <span className={styles.path}>
      {folder !== '' && <span className={styles.folder}>{folder}/</span>}
      <span className={styles.fileName}>{name}</span>
    </span>
  )
}

function OpenInEditor({ file, seams }: { file: ChangedFile; seams: DiffSeams }) {
  const open = seams.onOpenInEditor
  return (
    <Button
      size="small"
      disabled={!open}
      title={open ? undefined : 'Opening files in an editor isn’t set up yet.'}
      onClick={() => open?.(file)}
    >
      Open in editor ↗
    </Button>
  )
}

export function DiffView({
  taskId,
  changes,
  file,
  seams = {},
  onBack,
  onOpen,
}: {
  taskId: string
  changes: TaskChanges | undefined
  file: ChangedFile
  seams?: DiffSeams
  onBack: () => void
  onOpen: (file: ChangedFile) => void
}) {
  const files = changedFiles(changes)
  const index = files.findIndex((f) => f.repo === file.repo && f.path === file.path)
  const current = files[index] ?? file
  const { diffs, error } = useFileDiffs(taskId, file.repo, file.path, changes)
  const diff = diffs?.[0]
  const previous = files[index - 1]
  const next = files[index + 1]
  return (
    <section className={styles.pane} aria-label="Diff">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack}>
          ← Thread
        </button>
        <div className={styles.titleRow}>
          <FilePath path={current.path} />
          <span className={styles.repoChip}>{current.repo}</span>
          <DiffCounts added={current.added} removed={current.removed} />
          <span className={styles.spacer} />
          {index >= 0 && (
            <span className={styles.position}>
              {index + 1} of {files.length}
            </span>
          )}
          <button
            type="button"
            className={styles.step}
            aria-label="Previous file"
            disabled={!previous}
            onClick={() => previous && onOpen(previous)}
          >
            <ChevronIcon open className={styles.up} />
          </button>
          <button
            type="button"
            className={styles.step}
            aria-label="Next file"
            disabled={!next}
            onClick={() => next && onOpen(next)}
          >
            <ChevronIcon open />
          </button>
          <OpenInEditor file={current} seams={seams} />
        </div>
        <p className={styles.against}>
          Task branch against its merge-base with {current.baseBranch}, {current.repo}’s base
          branch, including uncommitted work
        </p>
      </header>
      <div className={styles.body}>
        {error !== undefined ? (
          <p className={styles.error}>{error}</p>
        ) : diff ? (
          <DiffTable diff={diff} after={seams.after?.(current)} />
        ) : diffs ? (
          <p className={styles.note}>This file no longer differs from its base.</p>
        ) : null}
      </div>
    </section>
  )
}

export function AllChanges({
  taskId,
  changes,
  seams = {},
  onCollapse,
}: {
  taskId: string
  changes: TaskChanges
  seams?: DiffSeams
  onCollapse: () => void
}) {
  const sections = useRef(new Map<string, HTMLElement>())
  const files = changedFiles(changes)
  const scrollTo = (file: ChangedFile) =>
    sections.current
      .get(`${file.repo}\0${file.path}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <section className={styles.all} aria-label="All changes">
      <header className={styles.allHeader}>
        <h2 className={styles.allTitle}>
          All changes · {files.length === 1 ? '1 file' : `${files.length} files`}
        </h2>
        <span className={styles.spacer} />
        <Button size="small" onClick={onCollapse}>
          Collapse
        </Button>
      </header>
      <div className={styles.allBody}>
        <nav className={styles.index} aria-label="Changed files">
          <ChangeList changes={changes} onOpen={scrollTo} />
        </nav>
        <div className={styles.column}>
          {changes.repos
            .filter((repo) => repo.files.length > 0)
            .map((repo) => (
              <RepoDiffs
                key={repo.name}
                taskId={taskId}
                repo={repo.name}
                changes={changes}
                files={files.filter((f) => f.repo === repo.name)}
                seams={seams}
                onSection={(file, element) => {
                  const key = `${file.repo}\0${file.path}`
                  if (element) sections.current.set(key, element)
                  else sections.current.delete(key)
                }}
              />
            ))}
        </div>
      </div>
    </section>
  )
}

function RepoDiffs({
  taskId,
  repo,
  changes,
  files,
  seams,
  onSection,
}: {
  taskId: string
  repo: string
  changes: TaskChanges
  files: ChangedFile[]
  seams: DiffSeams
  onSection: (file: ChangedFile, element: HTMLElement | null) => void
}) {
  const { diffs, error } = useFileDiffs(taskId, repo, undefined, changes)
  if (error !== undefined) return <p className={styles.error}>{error}</p>
  return files.map((file) => {
    const diff = diffs?.find((d) => d.path === file.path)
    return (
      <article
        key={file.path}
        className={styles.fileDiff}
        ref={(element) => onSection(file, element)}
      >
        <header className={styles.fileHeader}>
          <h3 className={styles.fileTitle}>{file.path}</h3>
          <span className={styles.repoChip}>{file.repo}</span>
          <DiffCounts added={file.added} removed={file.removed} />
          <span className={styles.spacer} />
          <OpenInEditor file={file} seams={seams} />
        </header>
        {diff && <DiffTable diff={diff} after={seams.after?.(file)} />}
      </article>
    )
  })
}
