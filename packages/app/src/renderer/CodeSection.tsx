import type { Task, TaskRepo } from '@ted/protocol'
import { useState } from 'react'
import { openInEditor } from './editor.ts'
import { readableError, ted } from './ted.ts'
import styles from './worktree.module.css'

export function CodeSection({
  task,
  onOpenShell,
}: {
  task: Task
  onOpenShell: (repo: string) => void
}) {
  const repos = task.repos.filter((repo) => !repo.removed)
  return (
    <section className={styles.code} aria-label="Code">
      <h2 className={styles.heading}>Code</h2>
      {repos.length === 0 ? (
        <>
          <p className={styles.empty}>
            {task.repos.length === 0 ? 'No worktree yet' : 'Worktree removed'}
          </p>
          {task.repos
            .filter((repo) => repo.pullRequest !== undefined)
            .map((repo) => (
              <PullRequestLine key={repo.name} task={task} repo={repo} />
            ))}
        </>
      ) : (
        <ul className={styles.repos}>
          {repos.map((repo) => (
            <RepoRow key={repo.name} task={task} repo={repo} onOpenShell={onOpenShell} />
          ))}
        </ul>
      )}
    </section>
  )
}

const pullRequestState = {
  draft: 'Draft',
  ready: 'Open',
  merged: 'Merged',
  closed: 'Closed',
} as const

function PullRequestLine({ task, repo }: { task: Task; repo: TaskRepo }) {
  const pr = repo.pullRequest
  const failed = repo.pushFailed && (
    <p className={styles.setup} title={repo.pushFailed.message}>
      {pr
        ? 'Couldn’t push the latest commits. TED tries again when Validate passes.'
        : 'Couldn’t push this branch. TED tries again when Validate passes.'}
    </p>
  )
  if (pr) {
    return (
      <>
        <p className={styles.pullRequest}>
          <button
            type="button"
            className={styles.link}
            title={pr.url}
            onClick={() => void ted.openPullRequest(task.id, repo.name)}
          >
            {`Pull request #${pr.number}`}
          </button>{' '}
          <span className={styles.prState}>{pullRequestState[pr.state]}</span>
        </p>
        {failed}
      </>
    )
  }
  return failed || null
}

const setupLabel = {
  running: 'Setting up…',
  failed: 'Setup failed',
  'timed-out': 'Setup timed out',
} as const

function RepoRow({
  task,
  repo,
  onOpenShell,
}: {
  task: Task
  repo: TaskRepo
  onOpenShell: (repo: string) => void
}) {
  const [log, setLog] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [problem, setProblem] = useState<string>()

  const edit = () => {
    setProblem(undefined)
    openInEditor({ taskId: task.id, repo: repo.name }).catch((error: unknown) =>
      setProblem(readableError(error)),
    )
  }

  const copyPath = async () => {
    await navigator.clipboard.writeText(repo.worktree)
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <li className={styles.repo}>
      <span className={styles.repoLine}>
        <span className={styles.repoName}>{repo.name}</span>
        <span className={styles.repoActions}>
          <button
            type="button"
            className={styles.link}
            title="Open your login shell in this worktree (⌃`)"
            onClick={() => onOpenShell(repo.name)}
          >
            Shell
          </button>
          <button type="button" className={styles.link} onClick={edit}>
            Open in editor
          </button>
        </span>
      </span>
      {problem !== undefined && (
        <p className={styles.setup} role="alert">
          {problem}
        </p>
      )}
      <PullRequestLine task={task} repo={repo} />
      <code className={styles.branch}>{repo.branch}</code>
      <button
        type="button"
        className={styles.path}
        title={copied ? 'Copied' : 'Click to copy'}
        onClick={() => void copyPath()}
      >
        {repo.worktree}
      </button>
      {repo.setup && repo.setup.state !== 'passed' && (
        <p className={styles.setup}>
          {setupLabel[repo.setup.state]}{' '}
          <button
            type="button"
            className={styles.link}
            onClick={() => void ted.setupLog(task.id, repo.name).then(setLog)}
          >
            Setup log
          </button>
        </p>
      )}
      {log !== undefined && <pre className={styles.log}>{log}</pre>}
    </li>
  )
}
