import type { Factory, RepoSetup } from '@ted/protocol'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { ted } from '../ted.ts'
import setupStyles from './SetupPanel.module.css'

export function factoryName(factories: readonly Factory[], factoryId: string): string {
  return factories.find((f) => f.id === factoryId)?.name ?? 'No Factory'
}

export function SetupPanel({ factory, setup }: { factory: Factory; setup: RepoSetup[] }) {
  return (
    <section className={setupStyles.panel} aria-label={`Setting up ${factory.name}`}>
      <h2 className={setupStyles.heading}>
        Setting up {factory.name}
        <Help>
          Ted clones each repo into its own folder. New Tasks wait in Queued until every clone is
          done.
        </Help>
      </h2>
      {setup.map((repo) => (
        <SetupRow key={repo.repo} factoryId={factory.id} repo={repo} />
      ))}
    </section>
  )
}

function SetupRow({ factoryId, repo }: { factoryId: string; repo: RepoSetup }) {
  const failed = repo.state === 'failed'
  return (
    <div className={`${setupStyles.row} ${failed ? setupStyles.failed : ''}`}>
      <div className={setupStyles.line}>
        <span className={setupStyles.repo}>{repo.repo}</span>
        <span className={setupStyles.spacer} />
        <SetupState repo={repo} />
        {failed && (
          <>
            {repo.suggestSetupGit && (
              <Button size="small" onClick={() => ted.runFix({ fix: 'gh-setup-git' })}>
                Fix
              </Button>
            )}
            <Button size="small" onClick={() => ted.retryClone(factoryId)}>
              Retry
            </Button>
          </>
        )}
      </div>
      {repo.state === 'cloning' && repo.percent !== undefined && (
        <>
          <div
            className={setupStyles.bar}
            role="progressbar"
            aria-label={`Cloning ${repo.repo}`}
            aria-valuenow={repo.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className={setupStyles.fill} style={{ width: `${repo.percent}%` }} />
          </div>
          {repo.detail !== undefined && <span className={setupStyles.detail}>{repo.detail}</span>}
        </>
      )}
    </div>
  )
}

function SetupState({ repo }: { repo: RepoSetup }) {
  switch (repo.state) {
    case 'waiting':
      return <span className={setupStyles.muted}>Waiting…</span>
    case 'cloning':
      return (
        <span className={setupStyles.muted}>
          Cloning…{repo.percent !== undefined ? ` ${repo.percent}%` : ''}
        </span>
      )
    case 'fetching':
      return <span className={setupStyles.muted}>Fetching…</span>
    case 'cloned':
      return <span className={setupStyles.ok}>✓ Cloned</span>
    case 'shared':
      return (
        <span className={setupStyles.ok}>
          ✓ Already cloned for {repo.sharedWith} · {repo.detail ?? 'fetched'}
        </span>
      )
    case 'failed':
      return (
        <span className={setupStyles.error}>
          ✕ Clone failed: {repo.error ?? 'unknown error'}
          {repo.suggestSetupGit && (
            <Help>
              Git couldn’t sign in to GitHub over HTTPS. Fix runs gh auth setup-git in your terminal
              so git uses your GitHub CLI login.
            </Help>
          )}
        </span>
      )
  }
}
