import type { Factory, RepoToConfirm, Task } from '@ted/protocol'
import { useState } from 'react'
import { Button } from '../components/Button.tsx'
import { readableError, ted } from '../ted.ts'
import styles from './ReposField.module.css'

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function showsRepos(factory: Factory | undefined): boolean {
  return (factory?.repos.length ?? 0) > 1
}

export function ReposField({ task, factory }: { task: Task; factory: Factory }) {
  const [error, setError] = useState<string>()
  const [asking, setAsking] = useState<{ set: string[]; confirm: RepoToConfirm[] }>()
  const [busy, setBusy] = useState(false)
  const locked = task.archived !== undefined || task.stage === 'done'
  const chosen = (repo: string) => task.chosenRepos.some((r) => same(r, repo))

  const save = async (set: string[], confirm = false) => {
    setError(undefined)
    setBusy(true)
    try {
      const result = await ted.setTaskRepos(task.id, { set, confirm })
      setAsking(result.confirm ? { set, confirm: result.confirm } : undefined)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (repo: string) => {
    const next = factory.repos
      .map((r) => r.repo)
      .filter((r) => (same(r, repo) ? !chosen(r) : chosen(r)))
    void save(next)
  }

  return (
    <div className={styles.field}>
      <ul className={styles.list} aria-label="Repos">
        {factory.repos.map((r) => (
          <li key={r.repo}>
            <label className={styles.option} title={r.repo}>
              <input
                type="checkbox"
                checked={chosen(r.repo)}
                disabled={locked || busy || asking !== undefined}
                onChange={() => toggle(r.repo)}
              />
              {r.name}
            </label>
          </li>
        ))}
      </ul>
      {asking && (
        <div className={styles.confirm} role="alertdialog" aria-label="Remove repo">
          {asking.confirm.map(({ name, commits }) => (
            <p key={name}>
              {`${name}’s worktree has ${commits} ${commits === 1 ? 'commit' : 'commits'} that would be lost. Remove it anyway?`}
            </p>
          ))}
          <div className={styles.actions}>
            <Button size="small" onClick={() => save(asking.set, true)}>
              Remove
            </Button>
            <Button size="small" variant="quiet" onClick={() => setAsking(undefined)}>
              Keep
            </Button>
          </div>
        </div>
      )}
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
