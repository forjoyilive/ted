import type { GitHubSetupChoice, GitHubSetupPlan, GitHubSetupStep } from '@ted/protocol'
import {
  branchNameProblem,
  filesToCommit,
  gitHubNameProblem,
  setupSteps,
} from '@ted/protocol/github-setup'
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Select } from '../components/Select.tsx'
import { stepLabel, suggestedRepoName } from '../github-setup.ts'
import { ted } from '../ted.ts'
import { plural } from '../words.ts'
import rows from './AddFactoryDialog.module.css'
import styles from './GitHubSetupForm.module.css'

interface GitHubSetupFormProps {
  folder: string
  onDone: () => void
  onCancel: () => void
}

type NameCheck = { key: string; available: boolean } | { key: string; error: string }

interface Running {
  steps: GitHubSetupStep[]
  choice: GitHubSetupChoice
  done: number
  error?: string
}

export function GitHubSetupForm({ folder, onDone, onCancel }: GitHubSetupFormProps) {
  const id = useId()
  const [plan, setPlan] = useState<GitHubSetupPlan>()
  const [loadError, setLoadError] = useState<string>()
  const [owner, setOwner] = useState('')
  const [name, setName] = useState(() => suggestedRepoName(folder))
  const [description, setDescription] = useState('')
  const [branch, setBranch] = useState('main')
  const [branchEdited, setBranchEdited] = useState(false)
  const [leaveOut, setLeaveOut] = useState(true)
  const [nameCheck, setNameCheck] = useState<NameCheck>()
  const [running, setRunning] = useState<Running>()

  const load = useCallback(async () => {
    setLoadError(undefined)
    try {
      const loaded = await ted.planGitHubRepo({ folder })
      setPlan(loaded)
      setOwner((current) =>
        current !== '' && loaded.owners.includes(current) ? current : (loaded.owners[0] ?? ''),
      )
      if (!branchEdited && loaded.branch !== undefined) setBranch(loaded.branch)
    } catch (failure) {
      setLoadError(readableError(failure))
    }
  }, [folder, branchEdited])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the plan loads once per folder; Check again reloads it
  useEffect(() => {
    void load()
  }, [folder])

  const nameError = gitHubNameProblem(name)
  const checkKey = `${owner}/${name}`
  useEffect(() => {
    if (owner === '' || nameError !== undefined) return
    const timer = setTimeout(() => {
      ted.checkGitHubName({ owner, name }).then(
        ({ available }) => setNameCheck({ key: checkKey, available }),
        (failure: unknown) => setNameCheck({ key: checkKey, error: readableError(failure) }),
      )
    }, 400)
    return () => clearTimeout(timer)
  }, [owner, name, nameError, checkKey])

  const checked = nameCheck?.key === checkKey ? nameCheck : undefined
  const taken = checked !== undefined && 'available' in checked && !checked.available
  const branchError = branchNameProblem(branch)
  const leaveOutPaths = plan && leaveOut ? plan.leaveOut.map((c) => c.path) : []
  const choice: GitHubSetupChoice = {
    owner,
    name,
    description: description.trim(),
    branch,
    leaveOut: leaveOutPaths,
  }

  async function run(from: Running) {
    if (!plan) return
    let done = from.done
    setRunning({ ...from, done })
    for (const step of from.steps.slice(done)) {
      try {
        await ted.runGitHubSetupStep({ ...from.choice, folder: plan.folder, step })
      } catch (failure) {
        setRunning({ ...from, done, error: readableError(failure) })
        return
      }
      done++
      setRunning({ ...from, done })
    }
    onDone()
  }

  async function changeChoice() {
    setRunning(undefined)
    await load()
  }

  const signedOut = plan !== undefined && !plan.signedIn
  const locked = running !== undefined || signedOut || plan === undefined
  const ready =
    plan !== undefined &&
    !signedOut &&
    owner !== '' &&
    nameError === undefined &&
    branchError === undefined &&
    checked !== undefined &&
    'available' in checked &&
    checked.available

  return (
    <section className={styles.setup} aria-label="New GitHub repo">
      <div className={styles.head}>
        <h3 className={styles.heading}>New GitHub repo</h3>
        <span className={styles.private}>Private</span>
      </div>

      {loadError !== undefined && (
        <div className={styles.problem}>
          <span className={rows.problem}>
            <span aria-hidden>✕</span> {loadError}
          </span>
          <span className={rows.spacer} />
          <Button size="small" onClick={() => load()}>
            Check again
          </Button>
        </div>
      )}
      {signedOut && (
        <div className={styles.problem}>
          <span className={rows.problem}>
            <span aria-hidden>✕</span> The GitHub CLI isn’t signed in to github.com.
          </span>
          <span className={rows.spacer} />
          <Button size="small" onClick={() => ted.runFix({ fix: 'gh-login', host: 'github.com' })}>
            Sign in
          </Button>
          <Button size="small" onClick={() => load()}>
            Check again
          </Button>
        </div>
      )}
      {plan === undefined && loadError === undefined && (
        <p className={rows.checking}>○ Reading the folder…</p>
      )}

      <div className={styles.grid}>
        <label className={styles.label} htmlFor={`${id}-name`}>
          Owner and name
        </label>
        <div className={styles.ownerName}>
          <Select
            aria-label="Owner"
            value={owner}
            disabled={locked}
            onChange={(event) => setOwner(event.target.value)}
          >
            {(plan?.owners ?? []).map((o, i) => (
              <option key={o} value={o}>
                {i === 0 ? `${o} (you)` : o}
              </option>
            ))}
          </Select>
          <span className={styles.slash}>/</span>
          <input
            id={`${id}-name`}
            className={`${rows.input} ${styles.mono} ${(nameError && name !== '') || taken ? rows.invalid : ''}`}
            value={name}
            disabled={locked}
            aria-invalid={nameError !== undefined || taken}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {!locked && name !== '' && nameError !== undefined && (
          <span className={`${styles.fieldNote} ${rows.keyError}`}>{nameError}</span>
        )}
        {!locked && taken && (
          <span className={`${styles.fieldNote} ${rows.keyError}`}>
            {owner}/{name} already exists. Choose another name.
          </span>
        )}
        {!locked && checked !== undefined && 'error' in checked && (
          <span className={`${styles.fieldNote} ${rows.keyError}`}>{checked.error}</span>
        )}
        <label className={styles.label} htmlFor={`${id}-description`}>
          Description
        </label>
        <input
          id={`${id}-description`}
          className={rows.input}
          placeholder="Optional"
          maxLength={350}
          value={description}
          disabled={locked}
          onChange={(event) => setDescription(event.target.value)}
        />
        <label className={styles.label} htmlFor={`${id}-branch`}>
          Default branch
        </label>
        <input
          id={`${id}-branch`}
          className={`${rows.input} ${styles.mono} ${styles.branch} ${branchError ? rows.invalid : ''}`}
          value={branch}
          disabled={locked}
          onChange={(event) => {
            setBranch(event.target.value)
            setBranchEdited(true)
          }}
        />
        {!locked && branchError !== undefined && (
          <span className={`${styles.fieldNote} ${rows.keyError}`}>{branchError}</span>
        )}
      </div>

      {plan !== undefined && running === undefined && (
        <>
          {plan.leaveOut.length > 0 && (
            <div className={styles.warn}>
              <span>⚠ This folder has no .gitignore, so these would be committed too:</span>
              <ul className={styles.list}>
                {plan.leaveOut.map((c) => (
                  <li key={c.path}>
                    <code>{c.path}</code>{' '}
                    {c.secret ? '· may hold passwords or keys' : `· ${plural(c.files, 'file')}`}
                  </li>
                ))}
              </ul>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={leaveOut}
                  onChange={(event) => setLeaveOut(event.target.checked)}
                />
                Leave them out (Ted writes a .gitignore for them)
              </label>
            </div>
          )}
          {plan.otherRemote !== undefined && (
            <div className={styles.warn}>
              <span>
                ⚠ This folder’s {plan.otherRemote.name} points at{' '}
                <code>{plan.otherRemote.url}</code>, which isn’t GitHub.
              </span>
              <span className={styles.warnBody}>
                Ted leaves {plan.otherRemote.name} as it is and adds the GitHub repo as a second
                remote named {plan.remoteName}. Ted clones from {plan.remoteName}; your own pushes
                and pulls keep going where they went before.
              </span>
            </div>
          )}
          {plan.uncommitted > 0 && (
            <p className={rows.note}>
              <span aria-hidden>ⓘ</span> {plural(plan.uncommitted, 'uncommitted change')} stay in
              the folder and aren’t pushed. Only commits already on {plan.branch ?? 'this branch'}{' '}
              go to GitHub.
            </p>
          )}
          {plan.signedIn && (
            <div className={styles.plan}>
              <h4 className={styles.planHeading}>When you click Create repo, Ted will:</h4>
              <ol className={styles.steps}>
                {setupSteps(plan, choice).map((step) => (
                  <li key={step}>{stepLabel(step, plan, choice)}</li>
                ))}
              </ol>
              {!plan.commits && filesToCommit(plan, leaveOutPaths) === 0 && (
                <p className={rows.problem}>The folder has no files to commit.</p>
              )}
            </div>
          )}
          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() => run({ steps: setupSteps(plan, choice), choice, done: 0 })}
            >
              Create repo
            </Button>
            <Button variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {plan !== undefined && running !== undefined && (
        <>
          <ol className={styles.progress} aria-label="Progress">
            {running.steps.map((step, i) => (
              <li key={step} className={styles.step}>
                <span className={styles.mark} aria-hidden>
                  {i < running.done ? (
                    <span className={rows.ok}>✓</span>
                  ) : i === running.done && running.error === undefined ? (
                    <span className={styles.spinner} />
                  ) : i === running.done ? (
                    <span className={rows.problem}>✕</span>
                  ) : (
                    <span className={rows.checking}>○</span>
                  )}
                </span>
                <span>{stepLabel(step, plan, running.choice)}</span>
              </li>
            ))}
          </ol>
          {running.error !== undefined && (
            <>
              <p className={rows.problem} role="alert">
                {running.error}
              </p>
              <p className={rows.detail}>
                {running.done > 0 ? 'The steps marked ✓ are done and stay done. ' : ''}Try again
                picks up from the step that failed.
              </p>
              <div className={styles.actions}>
                <Button
                  variant="primary"
                  onClick={() => {
                    const { error: _, ...rest } = running
                    void run(rest)
                  }}
                >
                  Try again
                </Button>
                <Button onClick={() => changeChoice()}>Change owner or name</Button>
                <Button variant="quiet" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

function readableError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
