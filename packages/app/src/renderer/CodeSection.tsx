import type { Task, TaskRepo } from '@ted/protocol'
import { useState } from 'react'
import { ted } from './ted.ts'
import styles from './worktree.module.css'

export function CodeSection({ task }: { task: Task }) {
  const repos = task.repos.filter((repo) => !repo.removed)
  return (
    <section className={styles.code} aria-label="Code">
      <h2 className={styles.heading}>Code</h2>
      {repos.length === 0 ? (
        <p className={styles.empty}>
          {task.repos.length === 0 ? 'No worktree yet' : 'Worktree removed'}
        </p>
      ) : (
        <ul className={styles.repos}>
          {repos.map((repo) => (
            <RepoRow key={repo.name} task={task} repo={repo} />
          ))}
        </ul>
      )}
    </section>
  )
}

const pullRequestState = { draft: 'Draft', ready: 'Open', closed: 'Closed' } as const

function PullRequestLine({ task, repo }: { task: Task; repo: TaskRepo }) {
  const pr = repo.pullRequest
  if (pr) {
    return (
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
    )
  }
  if (repo.pushFailed) {
    return (
      <p className={styles.setup} title={repo.pushFailed.message}>
        Couldn’t push this branch. TED tries again when Validate passes.
      </p>
    )
  }
  return null
}

const setupLabel = {
  running: 'Setting up…',
  failed: 'Setup failed',
  'timed-out': 'Setup timed out',
} as const

function RepoRow({ task, repo }: { task: Task; repo: TaskRepo }) {
  const [log, setLog] = useState<string>()
  const [copied, setCopied] = useState(false)

  const copyPath = async () => {
    await navigator.clipboard.writeText(repo.worktree)
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <li className={styles.repo}>
      <span className={styles.repoName}>{repo.name}</span>
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
