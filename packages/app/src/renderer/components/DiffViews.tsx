import type { FileDiff, LineSide, TaskChanges } from '@ted/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type ChangedFile,
  changedFiles,
  type PullRequestChangesState,
  splitPath,
} from '../changes.ts'
import { readableError, ted } from '../ted.ts'
import { formatTime } from '../time.ts'
import { ActionButton } from './ActionButton.tsx'
import { Button } from './Button.tsx'
import { ChangeList, DiffCounts } from './ChangesSection.tsx'
import { FileDiffBody, type Gutter, type RowExtra } from './DiffTable.tsx'
import styles from './DiffViews.module.css'
import { ChevronIcon } from './icons.tsx'
import { Loading } from './Loading.tsx'

export interface DiffSeams {
  after?: (file: ChangedFile) => RowExtra | undefined
  gutter?: (file: ChangedFile) => Gutter | undefined
  onOpenInEditor?: (file: ChangedFile, line: number | undefined) => Promise<unknown>
}

function useFileDiffs(
  taskId: string,
  repo: string,
  file: string | undefined,
  version: unknown,
  remote?: PullRequestChangesState,
): { diffs?: FileDiff[]; error?: string } {
  const [state, setState] = useState<{ key: string; diffs?: FileDiff[]; error?: string }>()
  const key = `${taskId}\0${repo}\0${file ?? ''}`
  useEffect(() => {
    void version
    if (remote !== undefined) return
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
  }, [taskId, repo, file, key, version, remote])
  if (remote !== undefined) {
    if (!remote.changes) return {}
    const error = remote.changes.repos.find((r) => r.name === repo)?.unavailable
    if (error) return { error }
    const diffs = remote.snapshots.get(repo)?.diffs ?? []
    return { diffs: file === undefined ? diffs : diffs.filter((d) => d.path === file) }
  }
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

function firstChangedLine(diff: FileDiff | undefined): number | undefined {
  const rows = diff?.hunks.flatMap((h) => h.rows) ?? []
  return (rows.find((r) => r.kind === 'added') ?? rows.find((r) => r.new !== undefined))?.new
}

function OpenInEditor({
  file,
  line,
  seams,
}: {
  file: ChangedFile
  line: number | undefined
  seams: DiffSeams
}) {
  const [problem, setProblem] = useState<string>()
  const open = seams.onOpenInEditor
  return (
    <>
      {problem !== undefined && (
        <span className={styles.editorProblem} role="alert">
          {problem}
        </span>
      )}
      <Button
        size="small"
        disabled={!open}
        onClick={() => {
          setProblem(undefined)
          return open?.(file, line).catch((error: unknown) => setProblem(readableError(error)))
        }}
      >
        Open in editor ↗
      </Button>
    </>
  )
}

function PullRequestSummary({ remote, repo }: { remote: PullRequestChangesState; repo?: string }) {
  const snapshots = [...remote.snapshots.values()].filter(
    (s) => repo === undefined || s.repo.name === repo,
  )
  return (
    <div className={styles.remoteSummary}>
      <p className={styles.against}>
        Pull request changes · Read-only. Use Local changes to leave line comments.
      </p>
      {snapshots.map((s) => (
        <p className={styles.against} key={s.repo.name}>
          {s.repo.name} · PR #{s.number} · {s.state} · pushed revision {s.head.slice(0, 7)} ·
          against {s.repo.baseBranch} · loaded {formatTime(s.loadedAt)}
          {s.limited && ' · Showing the first 1,000 files only.'}
        </p>
      ))}
      <Button size="small" onClick={remote.refresh}>
        {remote.changes?.repos.some((r) => r.unavailable) ? 'Retry' : 'Refresh'}
      </Button>
    </div>
  )
}

export interface LineFocus {
  side: LineSide
  line: number
}

export function DiffView({
  taskId,
  changes,
  file,
  seams = {},
  focus,
  footer,
  onBack,
  backLabel = '← Task Lead',
  onOpen,
  remote,
}: {
  taskId: string
  changes: TaskChanges | undefined
  file: ChangedFile
  seams?: DiffSeams
  focus?: LineFocus | undefined
  footer?: ReactNode
  backLabel?: string
  onBack: () => void
  onOpen: (file: ChangedFile) => void
  remote?: PullRequestChangesState | undefined
}) {
  const files = changedFiles(changes)
  const index = files.findIndex((f) => f.repo === file.repo && f.path === file.path)
  const current = files[index] ?? file
  const { diffs, error } = useFileDiffs(taskId, file.repo, file.path, changes, remote)
  const diff = diffs?.[0]
  const previous = files[index - 1]
  const next = files[index + 1]
  const body = useRef<HTMLDivElement>(null)
  const loaded = diff !== undefined
  useEffect(() => {
    if (!focus || !loaded) return
    body.current
      ?.querySelector(`tr[data-${focus.side}="${focus.line}"]`)
      ?.scrollIntoView({ block: 'center' })
  }, [focus, loaded])
  return (
    <section className={styles.pane} aria-label="Diff">
      <header className={styles.header}>
        <ActionButton type="button" className={styles.back} onClick={onBack}>
          {backLabel}
        </ActionButton>
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
          <ActionButton
            type="button"
            className={styles.step}
            aria-label="Previous file"
            disabled={!previous}
            onClick={() => previous && onOpen(previous)}
          >
            <ChevronIcon open className={styles.up} />
          </ActionButton>
          <ActionButton
            type="button"
            className={styles.step}
            aria-label="Next file"
            disabled={!next}
            onClick={() => next && onOpen(next)}
          >
            <ChevronIcon open />
          </ActionButton>
          {remote === undefined && (
            <OpenInEditor
              file={current}
              line={focus?.side === 'new' ? focus.line : firstChangedLine(diff)}
              seams={seams}
            />
          )}
        </div>
        {remote ? (
          <PullRequestSummary remote={remote} repo={file.repo} />
        ) : (
          <p className={styles.against}>
            Local changes · Task branch against its merge-base with {current.baseBranch},{' '}
            {current.repo}’s base branch, including uncommitted work
          </p>
        )}
      </header>
      <div
        className={`${styles.body} ${diffs === undefined && error === undefined ? styles.pending : ''}`}
        ref={body}
      >
        {error !== undefined ? (
          <p className={styles.error}>{error}</p>
        ) : diff ? (
          <FileDiffBody
            key={`${diff.repo}\0${diff.path}`}
            diff={diff}
            after={remote === undefined ? seams.after?.(current) : undefined}
            gutter={remote === undefined ? seams.gutter?.(current) : undefined}
          />
        ) : diffs ? (
          <p className={styles.note}>
            {remote
              ? 'This file is not in the loaded pull request changes.'
              : 'This file no longer differs from its base.'}
          </p>
        ) : (
          <Loading label="Loading diff…" />
        )}
      </div>
      {footer}
    </section>
  )
}

export function AllChanges({
  taskId,
  changes,
  seams = {},
  footer,
  onCollapse,
  backLabel = 'Collapse',
  remote,
  sidebar = false,
}: {
  taskId: string
  changes: TaskChanges | undefined
  remote?: PullRequestChangesState | undefined
  sidebar?: boolean
  seams?: DiffSeams
  footer?: ReactNode
  backLabel?: string
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
          {remote ? 'Pull request changes' : 'Local changes'} · All changes ·{' '}
          {files.length === 1 ? '1 file' : `${files.length} files`}
        </h2>
        <span className={styles.spacer} />
        <Button size="small" onClick={onCollapse}>
          {backLabel}
        </Button>
      </header>
      {remote && <PullRequestSummary remote={remote} />}
      <div className={styles.allBody}>
        {!sidebar && changes && (
          <nav className={styles.index} aria-label="Changed files">
            <ChangeList changes={changes} onOpen={scrollTo} />
          </nav>
        )}
        <div className={styles.column}>
          {!changes && <Loading label="Loading changes…" />}
          {changes?.files === 0 && changes.repos.every((r) => !r.unavailable) && (
            <p className={styles.note}>
              {remote ? 'No changes in the pull request.' : 'No changes yet'}
            </p>
          )}
          {changes?.repos.map((repo) => (
            <RepoDiffs
              key={repo.name}
              taskId={taskId}
              repo={repo.name}
              changes={changes}
              remote={remote}
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
      {footer}
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
  remote,
}: {
  taskId: string
  repo: string
  changes: TaskChanges
  remote?: PullRequestChangesState | undefined
  files: ChangedFile[]
  seams: DiffSeams
  onSection: (file: ChangedFile, element: HTMLElement | null) => void
}) {
  const { diffs, error } = useFileDiffs(taskId, repo, undefined, changes, remote)
  if (error !== undefined) return <p className={styles.error}>{error}</p>
  if (diffs === undefined) return <Loading label="Loading diffs…" />
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
          {remote === undefined && (
            <OpenInEditor file={file} line={firstChangedLine(diff)} seams={seams} />
          )}
        </header>
        {diff && (
          <FileDiffBody
            diff={diff}
            after={remote === undefined ? seams.after?.(file) : undefined}
            gutter={remote === undefined ? seams.gutter?.(file) : undefined}
          />
        )}
      </article>
    )
  })
}
