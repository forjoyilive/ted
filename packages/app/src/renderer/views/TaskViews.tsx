import type { Factory, RepoSetup, Task } from '@ted/protocol'
import type { ReactNode } from 'react'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { PlusIcon } from '../components/icons.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import { stageName, stageOrder } from '../list-view.ts'
import { ted } from '../ted.ts'
import setupStyles from './SetupPanel.module.css'
import styles from './views.module.css'

export { stageName, stageOrder }

export function factoryName(factories: readonly Factory[], factoryId: string): string {
  return factories.find((f) => f.id === factoryId)?.name ?? 'No Factory'
}

interface TaskViewProps {
  title: string
  tasks: readonly Task[]
  factories: readonly Factory[]
  onOpen: (task: Task) => void
  onNewTask: () => void
  banners?: ReactNode
  capLine?: string | undefined
}

function ViewHeader({
  title,
  capLine,
  onNewTask,
}: {
  title: string
  capLine?: string | undefined
  onNewTask: () => void
}) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <span className={styles.headerSpacer} />
      {capLine !== undefined && <span className={styles.capLine}>{capLine}</span>}
      <Button size="small" variant="quiet" onClick={onNewTask}>
        <PlusIcon />
        New Task
      </Button>
    </header>
  )
}

export function Board({
  title,
  tasks,
  onOpen,
  onOpenTask,
  onNewTask,
  banners,
  capLine,
  factory,
}: TaskViewProps & { onOpenTask: (ref: string) => void; factory?: Factory | undefined }) {
  const stages: string[] = [
    ...stageOrder,
    ...new Set(tasks.map((t) => t.stage).filter((s) => !stageOrder.includes(s))),
  ]

  return (
    <section className={styles.pane} aria-label={title}>
      <ViewHeader title={title} capLine={capLine} onNewTask={onNewTask} />
      {banners}
      {factory?.setup && <SetupPanel factory={factory} setup={factory.setup} />}
      <div className={styles.board}>
        {stages.map((stage) => {
          const inStage = tasks.filter((t) => t.stage === stage)
          return (
            <section key={stage} className={styles.column} aria-label={stageName(stage)}>
              <h2 className={styles.columnTitle}>
                {stageName(stage)}
                <span className={styles.columnCount}>{inStage.length}</span>
              </h2>
              {inStage.map((task) => (
                <div key={task.id} className={styles.card}>
                  <span className={styles.cardId}>
                    <PriorityIcon priority={task.priority} />
                    {task.displayId}
                    <span className={styles.cardRuns}>
                      <RunIcons runs={task.runs} stacked />
                    </span>
                  </span>
                  <button type="button" className={styles.cardTitle} onClick={() => onOpen(task)}>
                    {task.title}
                  </button>
                  <TaskStatusChips task={task} onOpenTask={onOpenTask} />
                  {task.activity !== undefined && (
                    <span className={styles.cardActivity}>{task.activity}</span>
                  )}
                </div>
              ))}
            </section>
          )
        })}
      </div>
    </section>
  )
}

function SetupPanel({ factory, setup }: { factory: Factory; setup: RepoSetup[] }) {
  return (
    <section className={setupStyles.panel} aria-label={`Setting up ${factory.name}`}>
      <h2 className={setupStyles.heading}>
        Setting up {factory.name}
        <Help>
          TED clones each repo into its own folder. New Tasks wait in Queued until every clone is
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
              <Button size="small" onClick={() => void ted.runFix({ fix: 'gh-setup-git' })}>
                Fix
              </Button>
            )}
            <Button size="small" onClick={() => void ted.retryClone(factoryId)}>
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
