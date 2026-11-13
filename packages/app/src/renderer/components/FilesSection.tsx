import type { Task, TaskFileRef, TaskFiles } from '@ted/protocol'
import { useEffect, useMemo } from 'react'
import { Button } from './Button.tsx'
import { contextMenu, useActionMenu } from './ContextMenu.tsx'
import { DetailsSection } from './DetailsSection.tsx'
import styles from './FilesSection.module.css'
import { Skeleton } from './Loading.tsx'

interface Folder {
  folders: Map<string, Folder>
  files: string[]
}
function folder(): Folder {
  return { folders: new Map(), files: [] }
}
function fileTree(paths: string[]): Folder {
  const root = folder()
  for (const path of paths) {
    const parts = path.split('/')
    const name = parts.pop()
    if (name === undefined) continue
    let current = root
    for (const part of parts) {
      let next = current.folders.get(part)
      if (!next) {
        next = folder()
        current.folders.set(part, next)
      }
      current = next
    }
    current.files.push(name)
  }
  return root
}

function Tree({
  tree,
  repo,
  prefix = '',
  selected,
  onOpen,
}: {
  tree: Folder
  repo: string
  prefix?: string
  selected: TaskFileRef | undefined
  onOpen: (file: TaskFileRef) => void
}) {
  const actions = useActionMenu(`${repo}:${prefix}:${tree.files.join('\0')}`)
  return (
    <>
      {actions.menu}
      <ul className={styles.tree}>
        {[...tree.folders]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, child]) => {
            const path = `${prefix}${name}/`
            return (
              <li key={path}>
                <details
                  open={
                    selected?.repo === repo && selected.path.startsWith(path) ? true : undefined
                  }
                >
                  <summary data-nav-item>{name}</summary>
                  <Tree
                    tree={child}
                    repo={repo}
                    prefix={path}
                    selected={selected}
                    onOpen={onOpen}
                  />
                </details>
              </li>
            )
          })}
        {tree.files.map((name) => {
          const path = `${prefix}${name}`
          const current = selected?.repo === repo && selected.path === path
          return (
            <li key={path}>
              <button
                type="button"
                data-nav-item
                {...contextMenu((at) =>
                  actions.open(at, `${repo} / ${path}`, [
                    { label: 'View file', action: () => onOpen({ repo, path }) },
                    { label: 'Copy path', action: () => navigator.clipboard.writeText(path) },
                  ]),
                )}
                className={styles.file}
                aria-current={current || undefined}
                title={path}
                onClick={() => onOpen({ repo, path })}
              >
                {name}
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

export function FileListState({
  files,
  error,
}: {
  files: TaskFiles | undefined
  error: string | undefined
}) {
  return error ? (
    <p role="alert" className={styles.message}>
      {error}
    </p>
  ) : files === undefined ? (
    <Skeleton label="Loading files…" />
  ) : (
    files.repos.map((repo) => (
      <div key={repo.repo}>
        {repo.unavailable && (
          <p role="alert" className={styles.message}>
            {repo.repo}: {repo.unavailable}
          </p>
        )}
        {repo.partial && (
          <p className={styles.message}>
            {repo.repo}: Showing the first 20,000 paths. Some files may be missing.
          </p>
        )}
      </div>
    ))
  )
}

function FilesBody({ task, files, error, selected, onOpen, onBrowse, refresh }: FilesSectionProps) {
  const active = task.repos.some((r) => !r.removed)
  useEffect(() => {
    if (active) onBrowse()
  }, [onBrowse, active])
  const trees = useMemo(() => files?.repos.map((r) => ({ ...r, tree: fileTree(r.paths) })), [files])
  if (!active)
    return (
      <p className={styles.message}>{task.repos.length ? 'Worktree removed' : 'No worktree yet'}</p>
    )
  return (
    <>
      <Button variant="quiet" onClick={refresh}>
        Refresh files
      </Button>
      <FileListState files={files} error={error} />
      <div>
        {trees?.map((repo) => (
          <div key={repo.repo}>
            <p className={styles.repo}>{repo.repo}</p>
            {!repo.unavailable && repo.paths.length === 0 && (
              <p className={styles.message}>No files to show</p>
            )}
            <Tree tree={repo.tree} repo={repo.repo} selected={selected} onOpen={onOpen} />
          </div>
        ))}
      </div>
      <p className={styles.message}>Ignored files hidden</p>
    </>
  )
}

interface FilesSectionProps {
  task: Task
  files: TaskFiles | undefined
  error: string | undefined
  selected: TaskFileRef | undefined
  onOpen: (file: TaskFileRef) => void
  onBrowse: () => void
  refresh: () => void
}

export function FilesSection(props: FilesSectionProps & { onQuickOpen: () => void }) {
  return (
    <DetailsSection
      id="files"
      action={
        <Button
          variant="quiet"
          disabled={!props.task.repos.some((r) => !r.removed)}
          onClick={props.onQuickOpen}
        >
          Quick open
        </Button>
      }
    >
      <FilesBody {...props} />
    </DetailsSection>
  )
}
