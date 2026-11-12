import type { ChangesSource, SignOffChanges, TaskChanges } from '@ted/protocol'
import { type ChangedFile, splitPath } from '../changes.ts'
import { Button } from './Button.tsx'
import styles from './ChangesSection.module.css'
import { contextMenu, useActionMenu } from './ContextMenu.tsx'
import { DetailsSection } from './DetailsSection.tsx'
import { Loading } from './Loading.tsx'

export type DraftCount = (file: ChangedFile) => number

export function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={styles.counts}>
      {added > 0 && <span className={styles.added}>+{added}</span>}
      {removed > 0 && <span className={styles.removed}>−{removed}</span>}
    </span>
  )
}

export function ChangesSection({
  changes,
  selected,
  onOpen,
  onExpandAll,
  drafts,
  draftTotal = 0,
  source = 'local',
  onSource,
  hasPullRequest = false,
  refresh,
}: {
  changes: TaskChanges | undefined
  selected?: ChangedFile | undefined
  onOpen: (file: ChangedFile) => void
  onExpandAll?: (() => void) | undefined
  drafts?: DraftCount | undefined
  draftTotal?: number
  source?: ChangesSource
  onSource?: (source: ChangesSource) => void
  hasPullRequest?: boolean
  refresh?: () => void
}) {
  if ((!changes || changes.repos.length === 0) && !hasPullRequest) return null
  const count = !changes
    ? 'Loading…'
    : changes.repos.length > 0 && changes.repos.every((r) => r.unavailable)
      ? 'Unavailable'
      : `${changes.files === 1 ? '1 file' : `${changes.files} files`}${
          draftTotal > 0 ? ` · ${draftTotal === 1 ? '1 draft' : `${draftTotal} drafts`}` : ''
        }`
  return (
    <DetailsSection
      id="changes"
      title="Changes"
      summary={count}
      action={
        onExpandAll &&
        (changes?.files ?? 0) > 0 && (
          <button type="button" className={styles.expandAll} onClick={onExpandAll}>
            All changes
          </button>
        )
      }
    >
      {onSource && (
        <>
          <fieldset className={styles.sources} aria-label="Changes source">
            <Button aria-pressed={source === 'local'} onClick={() => onSource('local')}>
              Local changes
            </Button>
            {hasPullRequest && (
              <Button
                aria-pressed={source === 'pull-request'}
                onClick={() => onSource('pull-request')}
              >
                Pull request changes
              </Button>
            )}
          </fieldset>
          <p className={styles.empty}>
            {source === 'local'
              ? 'Includes uncommitted and unpushed work.'
              : 'Only changes pushed to the PR.'}
          </p>
          {source === 'pull-request' && (
            <Button onClick={refresh}>
              {changes?.repos.some((r) => r.unavailable) ? 'Retry' : 'Refresh'}
            </Button>
          )}
        </>
      )}
      {!changes ? (
        <Loading label="Loading changes…" />
      ) : changes.repos.length === 0 ? (
        <p className={styles.empty}>
          Local changes are unavailable. The worktree may have been removed.
        </p>
      ) : changes.files === 0 && changes.repos.every((r) => !r.unavailable) ? (
        <p className={styles.empty}>
          {source === 'pull-request' ? 'No changes in the pull request.' : 'No changes yet'}
        </p>
      ) : (
        <ChangeList changes={changes} selected={selected} onOpen={onOpen} drafts={drafts} />
      )}
    </DetailsSection>
  )
}

export function ChangeList({
  changes,
  selected,
  onOpen,
  drafts,
  since,
}: {
  since?: SignOffChanges | undefined
  changes: TaskChanges
  selected?: ChangedFile | undefined
  onOpen: (file: ChangedFile) => void
  drafts?: DraftCount | undefined
}) {
  const actions = useActionMenu(
    JSON.stringify(changes.repos.map((repo) => [repo.name, repo.files.map((file) => file.path)])),
  )
  const named = changes.repos.length > 1
  const dots = changes.repos.some((r) => r.files.some((f) => f.uncommitted))
  return (
    <div className={styles.repos}>
      {actions.menu}
      {changes.repos.map((repo) => (
        <div key={repo.name} className={styles.repo}>
          {(named || repo.unavailable !== undefined || repo.files.length > 0) && (
            <div className={styles.repoRow}>
              <span className={styles.repoName}>{repo.name}</span>
              <DiffCounts added={repo.added} removed={repo.removed} />
              {dots && <span className={styles.dot} />}
            </div>
          )}
          {repo.unavailable !== undefined && <p className={styles.error}>{repo.unavailable}</p>}
          <ul className={styles.files} aria-label={repo.name}>
            {repo.files.map((file) => {
              const entry = { ...file, repo: repo.name, baseBranch: repo.baseBranch }
              const { name, folder } = splitPath(file.path)
              const count = drafts?.(entry) ?? 0
              const current = selected?.repo === repo.name && selected.path === file.path
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    data-nav-item
                    {...contextMenu((at) =>
                      actions.open(at, `${repo.name} / ${file.path}`, [
                        { label: 'View changes', action: () => onOpen(entry) },
                        {
                          label: 'Copy path',
                          action: () => navigator.clipboard.writeText(file.path),
                        },
                      ]),
                    )}
                    className={`${styles.file} ${current ? styles.current : ''}`}
                    aria-current={current || undefined}
                    title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                    onClick={() => onOpen(entry)}
                  >
                    <span className={styles.name}>{name}</span>
                    {folder !== '' && <span className={styles.folder}>{folder}</span>}
                    <span className={styles.spacer} />
                    {since?.repos.some(
                      (r) => r.name === repo.name && r.files.some((f) => f.path === file.path),
                    ) && <span className={styles.binary}>Changed since approval</span>}
                    {count > 0 && <span className={styles.drafts}>{count}</span>}
                    {file.binary ? (
                      <span className={styles.binary}>binary</span>
                    ) : file.committed && file.added + file.removed === 0 ? (
                      <span
                        className={styles.binary}
                        title="Committed, then undone in uncommitted work"
                      >
                        undone
                      </span>
                    ) : (
                      <DiffCounts added={file.added} removed={file.removed} />
                    )}
                    {file.uncommitted ? (
                      <span
                        className={`${styles.dot} ${styles.uncommitted}`}
                        title="Uncommitted work"
                      >
                        <span className={styles.hidden}>Uncommitted</span>
                      </span>
                    ) : (
                      dots && <span className={styles.dot} />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
