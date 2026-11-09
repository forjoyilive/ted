import type { Task, TaskRepo } from '@ted/protocol'
import { useState } from 'react'
import { ted } from './ted.ts'

export function CodeSection({ task }: { task: Task }) {
  const repos = task.repos.filter((repo) => !repo.removed)
  return (
    <section aria-label="Code">
      <h3>Code</h3>
      {repos.length === 0 ? (
        <p>{task.repos.length === 0 ? 'No worktree yet' : 'Worktree removed'}</p>
      ) : (
        <ul>
          {repos.map((repo) => (
            <RepoRow key={repo.name} task={task} repo={repo} />
          ))}
        </ul>
      )}
    </section>
  )
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
    <li>
      <span>{repo.name}</span> <code>{repo.branch}</code>{' '}
      <button type="button" title="Copy path" onClick={() => void copyPath()}>
        {repo.worktree}
      </button>
      {copied && <span> Copied</span>}
      {repo.setup && repo.setup.state !== 'passed' && (
        <p>
          {setupLabel[repo.setup.state]}{' '}
          <button type="button" onClick={() => void ted.setupLog(task.id, repo.name).then(setLog)}>
            Setup log
          </button>
        </p>
      )}
      {log !== undefined && <pre>{log}</pre>}
    </li>
  )
}
