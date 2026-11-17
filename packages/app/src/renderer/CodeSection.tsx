import type { Task, TaskRepo } from '@ted/protocol'
import { useState } from 'react'
import { ActionButton } from './components/ActionButton.tsx'
import { DetailsSection } from './components/DetailsSection.tsx'
import { codeSummary } from './details.ts'
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
    <DetailsSection id="code" summary={codeSummary(task)}>
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
    </DetailsSection>
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
        ? 'Couldn’t push the latest commits. Ted tries again when Validate passes.'
        : 'Couldn’t push this branch. Ted tries again when Validate passes.'}
    </p>
  )
  if (pr) {
    return (
      <>
        <p className={styles.pullRequest}>
          <ActionButton
            type="button"
            className={styles.link}
            title={pr.url}
            onClick={() => ted.openPullRequest(task.id, repo.name)}
          >
            {`Pull request #${pr.number}`}
          </ActionButton>{' '}
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
    return openInEditor({ taskId: task.id, repo: repo.name }).catch((error: unknown) =>
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
          <ActionButton
            type="button"
            className={styles.link}
            title="Open your login shell in this worktree (⌃`)"
            onClick={() => onOpenShell(repo.name)}
          >
            Shell
          </ActionButton>
          <ActionButton type="button" className={styles.link} onClick={edit}>
            Open in editor
          </ActionButton>
        </span>
      </span>
      {problem !== undefined && (
        <p className={styles.setup} role="alert">
          {problem}
        </p>
      )}
      <dl className={styles.fields}>
        {(repo.pullRequest || repo.pushFailed) && (
          <>
            <dt>Pull request</dt>
            <dd>
              <PullRequestLine task={task} repo={repo} />
            </dd>
          </>
        )}
        <dt>Branch</dt>
        <dd>
          <code className={styles.branch}>{repo.branch}</code>
        </dd>
        <dt>Worktree</dt>
        <dd>
          <ActionButton
            type="button"
            className={styles.path}
            title={copied ? 'Copied' : 'Click to copy'}
            onClick={() => copyPath()}
          >
            {repo.worktree}
          </ActionButton>
        </dd>
      </dl>
      {repo.setup && repo.setup.state !== 'passed' && (
        <p className={styles.setup}>
          {setupLabel[repo.setup.state]}{' '}
          <ActionButton
            type="button"
            className={styles.link}
            onClick={() => ted.setupLog(task.id, repo.name).then(setLog)}
          >
            Setup log
          </ActionButton>
        </p>
      )}
      {log !== undefined && <pre className={styles.log}>{log}</pre>}
    </li>
  )
}
