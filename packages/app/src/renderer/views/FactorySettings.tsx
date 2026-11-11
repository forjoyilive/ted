import type {
  AppInput,
  CheckInput,
  Factory,
  FactorySettingsView,
  RepoCheck,
  RepoFix,
  RepoRemoval,
  RepoSettingsInput,
  RepoSettingsView,
  RepoSource,
  SaveSettingsResult,
  SettingsMergeMethod,
  Task,
} from '@ted/protocol'
import { appKinds } from '@ted/protocol/factory-settings'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { moveRow, type RepoRow, shortPath } from '../add-factory.ts'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { Skeleton } from '../components/Loading.tsx'
import { useEventValue } from '../data.ts'
import {
  editedFields,
  missingCopies,
  type RepoField,
  remoteFor,
  type SettingsDraft,
  settingsChanges,
  settingsDraft,
  unsavedChanges,
  unsavedSummary,
} from '../factory-settings.ts'
import { readableError, ted } from '../ted.ts'
import { RepoRowView } from './AddFactoryDialog.tsx'
import styles from './FactorySettings.module.css'
import {
  AgentsSection,
  ChecksSection,
  InvalidNotice,
  NotesSection,
  PermissionsSection,
  Toggle,
  WorkflowSection,
} from './FactorySettingsSections.tsx'
import { LinearIntakeSection } from './LinearIntakeSection.tsx'
import { SaveSettingsDialog } from './SaveSettingsDialog.tsx'
import { usePopover } from './TaskList.tsx'
import views from './views.module.css'

const sections = [
  ['linear-intake', 'Linear intake'],
  ['repos', 'Repos'],
  ['workflow', 'Workflow'],
  ['checks', 'Checks'],
  ['agents', 'Agents'],
  ['permissions', 'Permissions'],
  ['notes', 'Factory notes'],
  ['danger-zone', 'Danger zone'],
] as const

const machine = navigator.userAgent.includes('Mac') ? 'this Mac' : 'this computer'
const appKindLabels = { web: 'web', command: 'command', 'ios-simulator': 'iOS simulator' }
const mergeLabels: Record<SettingsMergeMethod, string> = {
  squash: 'Squash',
  merge: 'Merge',
  rebase: 'Rebase',
}

interface FactorySettingsProps {
  factory: Factory
  banners: ReactNode
  onOpenFactory: (factoryId: string) => void
  onOpenGitHubSettings: () => void
  onRemoveFactory: () => void
  onOpenTask: (task: Task) => void
}

export function FactorySettings({
  factory,
  banners,
  onOpenFactory,
  onOpenGitHubSettings,
  onRemoveFactory,
  onOpenTask,
}: FactorySettingsProps) {
  const [loadError, setLoadError] = useState<string>()
  const [draft, setDraft] = useState<SettingsDraft>()
  const [base, setBase] = useState<{ draft: SettingsDraft; version: string }>()
  const [reviewing, setReviewing] = useState(false)
  const [saved, setSaved] = useState<SaveSettingsResult>()
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string>()
  const mergeBusy = useRef(false)
  const [setupError, setSetupError] = useState<string>()
  const pendingFolders = useRef(new Map<string, string>())
  const scroller = useRef<HTMLDivElement>(null)
  const started = useRef(false)
  const savedNotice = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!saved) return
    savedNotice.current?.focus({ preventScroll: true })
    if (scroller.current) scroller.current.scrollTop = 0
  }, [saved])

  const restart = useCallback((from: FactorySettingsView) => {
    setBase({ draft: settingsDraft(from), version: from.version })
    setDraft(settingsDraft(from))
  }, [])

  const driftRef = useRef(0)
  const { value: view, refresh: load } = useEventValue<FactorySettingsView | undefined>({
    initial: undefined,
    key: factory.id,
    load: () => ted.factorySettings(factory.id),
    event: (event) => {
      if (event.type === 'check-try-updated' && event.checkTry.factoryId === factory.id) {
        return (current) =>
          current && {
            ...current,
            tries: [...current.tries.filter((t) => t.name !== event.checkTry.name), event.checkTry],
          }
      }
      if (
        event.type === 'drift-changed' &&
        (event.drift.factories[factory.id] ?? 0) !== driftRef.current
      )
        return 'reload'
      return undefined
    },
    changed: (loaded) => {
      setLoadError(undefined)
      if (!loaded || started.current) return
      started.current = true
      restart(loaded)
    },
    error: (failure) => setLoadError(readableError(failure)),
  })
  driftRef.current = view?.stages.filter((s) => s.drift !== undefined).length ?? 0
  const drifted = driftRef.current
  const tries = view?.tries ?? []
  const { value: home } = useEventValue<string | undefined>({
    initial: undefined,
    load: ted.homeFolder,
    event: () => undefined,
  })

  const loaded = base?.draft.repos ?? []
  const unsaved = base && draft ? unsavedChanges(draft, base.draft) : { count: 0, files: [] }
  const count = unsaved.count
  const onDraft = (change: (current: SettingsDraft) => SettingsDraft) => {
    if (mergeBusy.current) return
    setDraft((current) => (current ? change(current) : current))
  }
  const setRepos = (change: (repos: RepoSettingsInput[]) => RepoSettingsInput[]) =>
    onDraft((current) => ({ ...current, repos: change(current.repos) }))
  const updateRepo = (index: number, change: (repo: RepoSettingsInput) => RepoSettingsInput) =>
    setRepos((current) => current.map((repo, i) => (i === index ? change(repo) : repo)))
  const removeRepo = (was: string) =>
    onDraft((current) => ({
      ...current,
      repos: current.repos.filter((r) => r.was !== was),
      checks: current.checks.filter((c) => c.repo !== was),
    }))
  const undoRemove = (was: string) =>
    onDraft((current) => {
      const index = loaded.findIndex((r) => r.was === was)
      const repo = loaded[index]
      if (!repo) return current
      const repos = [...current.repos]
      repos.splice(Math.min(Math.max(index, 1), repos.length), 0, repo)
      const checks: CheckInput[] = [
        ...current.checks,
        ...(base?.draft.checks ?? []).filter(
          (c) => c.repo === was && !current.checks.some((d) => d.was === c.was),
        ),
      ]
      return { ...current, repos, checks }
    })

  async function afterSave(result: SaveSettingsResult) {
    const next = await load()
    if (!next) {
      setSaved(result)
      return
    }
    if (!result.merged) {
      restart(next)
      setSaved(result)
      return
    }
    for (const [name, folder] of pendingFolders.current) {
      if (next.repos.some((r) => r.name === name)) {
        await ted.setRepoLocalFolder(factory.id, name, folder).catch(() => undefined)
      }
    }
    pendingFolders.current.clear()
    restart((await load()) ?? next)
    setSaved(result)
  }

  async function mergeSaved() {
    if (!saved?.receipt || count > 0 || mergeBusy.current) return
    mergeBusy.current = true
    setMerging(true)
    setMergeError(undefined)
    try {
      const result = await ted.mergeFactorySettings(factory.id, { receipt: saved.receipt })
      if (result.merged) await afterSave(result)
      else setSaved(result)
    } catch (failure) {
      setMergeError(readableError(failure))
    } finally {
      mergeBusy.current = false
      setMerging(false)
    }
  }

  const scrollTo = (id: string) =>
    scroller.current?.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' })

  return (
    <section className={views.pane} aria-label={`${factory.name} settings`}>
      <header className={views.header}>
        <h1 className={views.title}>
          {factory.name}
          <span className={styles.crumbSlash}>/</span>
          <span className={styles.crumb}>Settings</span>
        </h1>
        <span className={views.headerSpacer} />
        {setupError !== undefined && (
          <span className={styles.setupError} role="alert">
            {setupError}
          </span>
        )}
        <Button
          size="small"
          onClick={() => {
            setSetupError(undefined)
            ted
              .newSetupTask(factory.id)
              .then(onOpenTask, (error: unknown) => setSetupError(readableError(error)))
          }}
        >
          New setup Task
        </Button>
      </header>
      {banners}
      <div className={styles.page}>
        <nav className={styles.nav} aria-label="Jump to a section">
          <button type="button" className={styles.navItem} onClick={() => scrollTo('general')}>
            General
          </button>
          {sections.map(([id, label]) => (
            <button key={id} type="button" className={styles.navItem} onClick={() => scrollTo(id)}>
              {label}
              {id === 'workflow' && drifted > 0 && (
                <span className={styles.navCount} title="Inherited Stage files that changed">
                  {drifted}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className={styles.scroller} ref={scroller}>
          <div className={styles.column}>
            {saved && (
              <SavedNotice
                notice={savedNotice}
                result={saved}
                merging={merging}
                hasEdits={count > 0}
                error={mergeError}
                onMerge={() => void mergeSaved()}
                onDismiss={() => {
                  setSaved(undefined)
                  setMergeError(undefined)
                }}
              />
            )}
            <fieldset className={styles.settingsFields} disabled={merging}>
              <legend className={styles.visuallyHidden}>Factory settings</legend>
              {view && (
                <div className={styles.repoGuide}>
                  <strong>How repo settings are saved</strong>
                  <p>
                    Edit settings marked “In the repo”, then choose{' '}
                    <strong>Review and save…</strong>. TED creates a pull request: a proposed change
                    to your repo. The changes must merge before TED can use them.
                  </p>
                </div>
              )}
              {!view && !loadError && (
                <Skeleton shape="settings" label="Loading Factory settings…" />
              )}
              {view?.invalid && <InvalidNotice invalid={view.invalid} />}
              <GeneralSection factory={factory} />
              <LinearIntakeSection key={factory.id} factoryId={factory.id} />
              {loadError !== undefined && (
                <p className={styles.loadError} role="alert">
                  {loadError}
                </p>
              )}
              {view && draft && base && (
                <ReposSection
                  disabled={merging}
                  view={view}
                  draft={draft.repos}
                  loaded={loaded}
                  home={home}
                  onRepo={updateRepo}
                  onDraft={setRepos}
                  onFolder={async (repo, folder) => {
                    if (folder === undefined) await ted.clearRepoLocalFolder(factory.id, repo.was)
                    else await ted.setRepoLocalFolder(factory.id, repo.was, folder)
                    await load()
                  }}
                  onNewRepoFolder={(name, folder) => pendingFolders.current.set(name, folder)}
                  onRemoveRepo={removeRepo}
                  onUndoRemove={undoRemove}
                  factoryId={factory.id}
                  onOpenFactory={onOpenFactory}
                  onOpenGitHubSettings={onOpenGitHubSettings}
                />
              )}
              {view && draft && base && (
                <>
                  <WorkflowSection
                    view={view}
                    draft={draft}
                    loaded={base.draft}
                    onDraft={onDraft}
                  />
                  <ChecksSection view={view} draft={draft} tries={tries} onDraft={onDraft} />
                  <AgentsSection view={view} draft={draft} loaded={base.draft} onDraft={onDraft} />
                  <PermissionsSection
                    view={view}
                    draft={draft}
                    loaded={base.draft}
                    onDraft={onDraft}
                  />
                  <NotesSection draft={draft} loaded={base.draft} onDraft={onDraft} />
                </>
              )}
              <DangerZoneSection onRemove={onRemoveFactory} />
            </fieldset>
          </div>
        </div>
      </div>
      {count > 0 && view && (
        <footer className={styles.saveBar}>
          <span className={styles.unsavedDot} aria-hidden />
          <div>
            <span>{unsavedSummary(unsaved)}</span>
            <p className={styles.saveHint}>Review your changes before creating a pull request.</p>
          </div>
          <span className={views.headerSpacer} />
          <Button size="small" onClick={() => restart(view)}>
            Discard
          </Button>
          <Button size="small" variant="primary" onClick={() => setReviewing(true)}>
            Review and save…
          </Button>
        </footer>
      )}
      {reviewing && view && base && draft && (
        <SaveSettingsDialog
          factoryId={factory.id}
          factoryName={factory.name}
          view={{ ...view, version: base.version }}
          changes={settingsChanges(draft, base.draft)}
          onClose={() => setReviewing(false)}
          onSaved={(result) => {
            setReviewing(false)
            void afterSave(result)
          }}
        />
      )}
    </section>
  )
}

function SavedNotice({
  notice,
  result,
  onDismiss,
  onMerge,
  merging,
  hasEdits,
  error,
}: {
  notice: RefObject<HTMLDivElement | null>
  result: SaveSettingsResult
  onDismiss: () => void
  onMerge: () => void
  merging: boolean
  hasEdits: boolean
  error: string | undefined
}) {
  const { number, url } = result.pullRequest
  return (
    <div
      ref={notice}
      tabIndex={-1}
      className={result.merged ? styles.savedNotice : styles.openNotice}
      role="status"
    >
      <div className={styles.noticeText}>
        <strong>
          {result.merged
            ? `Pull request #${number} merged. Settings saved to the repo.`
            : `Pull request #${number} ${result.receipt ? 'is open' : 'has not merged'}. These changes are not in use yet.`}
        </strong>
        <p>
          {result.merged
            ? 'Tasks use updated Workflow settings when they next enter a Stage.'
            : result.receipt
              ? 'Merge it here when it’s ready, or open it on GitHub to review it.'
              : 'Open it on GitHub to review its status.'}
        </p>
        {!result.merged && result.reason && <p>{result.reason}</p>}
        {!result.merged && result.receipt && hasEdits && (
          <p>Save or discard your new edits before merging this pull request.</p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className={styles.noticeActions}>
          {!result.merged && result.receipt && (
            <Button size="small" variant="primary" disabled={merging || hasEdits} onClick={onMerge}>
              {merging ? 'Merging…' : 'Merge pull request'}
            </Button>
          )}
          <Button size="small" onClick={() => void ted.openOnGitHub(url)}>
            Open on GitHub
          </Button>
        </div>
      </div>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Dismiss"
        disabled={merging}
        onClick={onDismiss}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  )
}

function Chip({ where }: { where: 'machine' | 'repo' }) {
  return where === 'machine' ? (
    <span className={styles.machineChip}>Saved on {machine}</span>
  ) : (
    <span className={styles.repoChip}>In the repo</span>
  )
}

function SectionHeading({
  id,
  title,
  help,
  where,
}: {
  id: string
  title: string
  help?: ReactNode
  where: 'machine' | 'repo'
}) {
  return (
    <div className={styles.sectionHeading}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {help !== undefined && <Help>{help}</Help>}
      <Chip where={where} />
    </div>
  )
}

function GeneralSection({ factory }: { factory: Factory }) {
  const nameId = useId()
  const keyId = useId()
  const [autoStartBacklog, setAutoStartBacklog] = useState(factory.autoStartBacklog)
  const [savingAutoStart, setSavingAutoStart] = useState(false)
  const [autoStartError, setAutoStartError] = useState<string>()
  useEffect(() => setAutoStartBacklog(factory.autoStartBacklog), [factory.autoStartBacklog])
  async function saveAutoStart(enabled: boolean) {
    setSavingAutoStart(true)
    setAutoStartError(undefined)
    try {
      const saved = await ted.setFactoryAutoStartBacklog(factory.id, enabled)
      setAutoStartBacklog(saved.autoStartBacklog)
    } catch (failure) {
      setAutoStartError(readableError(failure))
    } finally {
      setSavingAutoStart(false)
    }
  }
  const [name, setName] = useState(factory.name)
  const [error, setError] = useState<string>()
  useEffect(() => setName(factory.name), [factory.name])

  async function saveName() {
    const trimmed = name.trim()
    if (trimmed === factory.name) return
    try {
      await ted.renameFactory(factory.id, trimmed)
      setError(undefined)
    } catch (failure) {
      setError(readableError(failure))
      setName(factory.name)
    }
  }

  return (
    <section className={styles.section} aria-labelledby="general">
      <SectionHeading id="general" title="General" where="machine" />
      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={nameId}>
            Name <Help>Shown in the sidebar and the Inbox. Task IDs don’t change.</Help>
          </label>
          <input
            id={nameId}
            className={styles.input}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setName(factory.name)
            }}
          />
          {error !== undefined && <span className={styles.fieldError}>{error}</span>}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={keyId}>
            Key <Help>Can’t be changed. Task IDs look like {factory.key}-1.</Help>
          </label>
          <input
            id={keyId}
            className={`${styles.input} ${styles.mono}`}
            value={factory.key}
            readOnly
          />
        </div>
      </div>
      <div className={styles.autoStartRow}>
        <div className={styles.field}>
          <span className={styles.label}>Start Backlog Tasks automatically</span>
          <span className={styles.caption}>
            Start the next eligible Task when a working-Run slot is free. Uses Priority and manual
            order, skips blocked Tasks, and gives Queued work precedence.
          </span>
          <span className={styles.caption}>
            Takes effect immediately. Turning this off leaves started Tasks running.
          </span>
          {autoStartError !== undefined && (
            <span className={styles.fieldError} role="alert">
              {autoStartError}
            </span>
          )}
        </div>
        <Toggle
          label="Start Backlog Tasks automatically"
          checked={autoStartBacklog}
          disabled={savingAutoStart}
          onChange={(enabled) => void saveAutoStart(enabled)}
        />
      </div>
    </section>
  )
}

function DangerZoneSection({ onRemove }: { onRemove: () => void }) {
  return (
    <section className={styles.section} aria-labelledby="danger-zone">
      <SectionHeading id="danger-zone" title="Danger zone" where="machine" />
      <div className={styles.removeRow}>
        <span className={styles.label}>
          Remove Factory{' '}
          <Help>
            Stops its Runs and deletes its Tasks and worktrees from {machine}. Its .ted/ folder
            stays in the repo.
          </Help>
        </span>
        <span className={views.headerSpacer} />
        <button type="button" className={styles.dangerButton} onClick={onRemove}>
          Remove Factory…
        </button>
      </div>
    </section>
  )
}

interface ReposSectionProps {
  disabled: boolean
  view: FactorySettingsView
  draft: RepoSettingsInput[]
  loaded: RepoSettingsInput[]
  home: string | undefined
  onRepo: (index: number, change: (repo: RepoSettingsInput) => RepoSettingsInput) => void
  onDraft: (change: (repos: RepoSettingsInput[]) => RepoSettingsInput[]) => void
  onFolder: (repo: RepoSettingsView, folder: string | undefined) => Promise<void>
  onNewRepoFolder: (name: string, folder: string) => void
  onRemoveRepo: (was: string) => void
  onUndoRemove: (was: string) => void
  factoryId: string
  onOpenFactory: (factoryId: string) => void
  onOpenGitHubSettings: () => void
}

function ReposSection({
  disabled,
  view,
  draft,
  loaded,
  home,
  onRepo,
  onDraft,
  onFolder,
  onNewRepoFolder,
  onRemoveRepo,
  onUndoRemove,
  factoryId,
  onOpenFactory,
  onOpenGitHubSettings,
}: ReposSectionProps) {
  const [dragging, setDragging] = useState<number>()
  const [adding, setAdding] = useState(false)
  const [refused, setRefused] = useState<RepoRemoval>()
  const [removeError, setRemoveError] = useState<string>()
  const removed = loaded.filter((r) => r.was !== undefined && !draft.some((d) => d.was === r.was))
  async function askToRemove(repo: RepoSettingsInput) {
    const was = repo.was
    if (was === undefined) return
    setRemoveError(undefined)
    try {
      const check = await ted.repoRemoval(factoryId, was)
      if (check.openTasks.length > 0) setRefused(check)
      else onRemoveRepo(was)
    } catch (failure) {
      setRemoveError(readableError(failure))
    }
  }
  return (
    <section className={styles.section} aria-labelledby="repos">
      <SectionHeading
        id="repos"
        title="Repos"
        where="repo"
        help="Saved in .ted/workflow.yaml on the primary repo’s default branch. Changes go through a pull request."
      />
      {draft.map((repo, index) => {
        const shown = view.repos.find((r) => r.was === repo.was)
        return (
          <RepoCard
            key={repo.was ?? `new-${repo.repo}`}
            repo={repo}
            index={index}
            shown={shown}
            edited={editedFields(repo, loaded)}
            home={home}
            disabled={disabled}
            dragging={dragging}
            onDragStart={() => setDragging(index)}
            onDragEnd={() => setDragging(undefined)}
            onDrop={() => {
              if (dragging !== undefined) onDraft((current) => moveRow(current, dragging, index))
              setDragging(undefined)
            }}
            onChange={(change) => onRepo(index, change)}
            onRemoveNew={() => onDraft((current) => current.filter((_, i) => i !== index))}
            onRemove={() => void askToRemove(repo)}
            onFolder={shown ? (folder) => onFolder(shown, folder) : undefined}
          />
        )
      })}
      {removed.map((repo) => (
        <article
          key={`removed-${repo.was}`}
          className={`${styles.card} ${styles.removedCard}`}
          aria-label={repo.repo}
        >
          <div className={styles.cardHead}>
            <span className={styles.repoName}>{repo.repo}</span>
            <span className={styles.removedChip}>Removed when you save</span>
            <span className={views.headerSpacer} />
            <Button size="small" onClick={() => repo.was !== undefined && onUndoRemove(repo.was)}>
              Undo
            </Button>
          </div>
        </article>
      ))}
      {removeError !== undefined && (
        <p className={styles.loadError} role="alert">
          {removeError}
        </p>
      )}
      {refused && <RepoInUseDialog removal={refused} onClose={() => setRefused(undefined)} />}
      {adding ? (
        <AddRepo
          taken={draft}
          home={home}
          onCancel={() => setAdding(false)}
          onAdd={(repo, folder) => {
            onDraft((current) => [...current, repo])
            if (folder !== undefined) onNewRepoFolder(repo.name, folder)
            setAdding(false)
          }}
          onOpenFactory={onOpenFactory}
          onOpenGitHubSettings={onOpenGitHubSettings}
        />
      ) : (
        <div className={styles.addRepoLine}>
          <button type="button" className={styles.link} onClick={() => setAdding(true)}>
            + Add repo
          </button>
          <Help>
            Adds a repo through the same Save. Afterwards a New setup Task can set up its Checks and
            Apps.
          </Help>
        </div>
      )}
    </section>
  )
}

interface RepoCardProps {
  disabled: boolean
  repo: RepoSettingsInput
  index: number
  shown: RepoSettingsView | undefined
  edited: Set<RepoField>
  home: string | undefined
  dragging: number | undefined
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: () => void
  onChange: (change: (repo: RepoSettingsInput) => RepoSettingsInput) => void
  onRemoveNew: () => void
  onRemove: () => void
  onFolder: ((folder: string | undefined) => Promise<void>) | undefined
}

function Edited({ when }: { when: boolean }) {
  return when ? <span className={styles.edited}>Edited</span> : null
}

function RepoCard({
  disabled,
  repo,
  index,
  shown,
  edited,
  home,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onChange,
  onRemoveNew,
  onRemove,
  onFolder,
}: RepoCardProps) {
  const id = useId()
  const primary = index === 0
  const isNew = repo.was === undefined
  const canDrop = !disabled && !primary && dragging !== undefined && dragging !== index
  const set = (fields: Partial<RepoSettingsInput>) => onChange((r) => ({ ...r, ...fields }))

  return (
    <article
      className={styles.card}
      aria-label={repo.repo}
      onDragOver={(event) => {
        if (canDrop) event.preventDefault()
      }}
      onDrop={(event) => {
        if (!canDrop) return
        event.preventDefault()
        onDrop()
      }}
    >
      <div className={styles.cardHead}>
        {primary ? (
          <span className={styles.primaryChip}>Primary</span>
        ) : (
          <span
            className={styles.handle}
            draggable={!disabled}
            role="img"
            aria-label="Drag to reorder"
            onDragStart={(event) => {
              if (disabled) {
                event.preventDefault()
                return
              }
              event.dataTransfer.effectAllowed = 'move'
              onDragStart()
            }}
            onDragEnd={onDragEnd}
          >
            ⠿
          </span>
        )}
        <span className={styles.repoName}>{repo.repo}</span>
        {primary && <span className={styles.caption}>Can’t be removed or moved</span>}
        {isNew && <span className={styles.newChip}>Added when you save</span>}
        <span className={views.headerSpacer} />
        {isNew ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Don’t add ${repo.repo}`}
            onClick={onRemoveNew}
          >
            <CloseIcon size={12} />
          </button>
        ) : (
          !primary && <RepoMenu repo={repo.repo} onRemove={onRemove} />
        )}
      </div>

      <div className={styles.threeColumns}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-name`}>
            Name <Edited when={edited.has('name')} />
          </label>
          <input
            id={`${id}-name`}
            className={`${styles.input} ${styles.mono}`}
            value={repo.name}
            onChange={(event) => set({ name: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-base`}>
            Base branch <Edited when={edited.has('baseBranch')} />
          </label>
          <input
            id={`${id}-base`}
            className={`${styles.input} ${styles.mono}`}
            placeholder="main (GitHub default)"
            value={repo.baseBranch ?? ''}
            onChange={(event) => set({ baseBranch: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-merge`}>
            Merge method <Edited when={edited.has('mergeMethod')} />
          </label>
          <select
            id={`${id}-merge`}
            className={styles.select}
            value={repo.mergeMethod ?? 'squash'}
            onChange={(event) => {
              const chosen = event.target.value as SettingsMergeMethod
              const before = shown?.mergeMethod
              onChange((r) => {
                const { mergeMethod: _, ...rest } = r
                return chosen === 'squash' && before === undefined
                  ? rest
                  : { ...rest, mergeMethod: chosen }
              })
            }}
          >
            {Object.entries(mergeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <h3 className={styles.groupLabel}>Worktree</h3>
      <div className={styles.twoColumns}>
        <CommandField
          label="Setup command"
          help="Runs once in each new worktree, after copying files, before any Run uses it."
          value={repo.setup}
          defaultTimeout="15m"
          edited={edited.has('setup')}
          onChange={(setup) => onChange((r) => withCommand(r, 'setup', setup))}
        />
        <CommandField
          label="Teardown command"
          help="Runs before TED removes a worktree. If it fails, TED logs it and removes the worktree anyway."
          value={repo.teardown}
          placeholder="None"
          edited={edited.has('teardown')}
          onChange={(teardown) => onChange((r) => withCommand(r, 'teardown', teardown))}
        />
      </div>

      <EnvTable env={repo.env} edited={edited.has('env')} onChange={(env) => set({ env })} />
      <CopyList copy={repo.copy} edited={edited.has('copy')} onChange={(copy) => set({ copy })} />

      {!isNew && onFolder && (
        <LocalFolder folder={shown?.localFolder} copy={repo.copy} home={home} onFolder={onFolder} />
      )}

      <Apps apps={repo.apps} edited={edited.has('apps')} onChange={(apps) => set({ apps })} />
    </article>
  )
}

let rowCounter = 0

function useRowKeys(length: number) {
  const keys = useRef<string[]>([])
  while (keys.current.length < length) keys.current.push(`row-${rowCounter++}`)
  if (keys.current.length > length) keys.current.length = length
  return {
    keys: keys.current,
    removed: (index: number) => void keys.current.splice(index, 1),
  }
}

function withCommand(
  repo: RepoSettingsInput,
  key: 'setup' | 'teardown',
  command: RepoSettingsInput['setup'],
): RepoSettingsInput {
  const { [key]: _, ...rest } = repo
  return command === undefined ? rest : { ...rest, [key]: command }
}

function CommandField({
  label,
  help,
  value,
  placeholder,
  defaultTimeout,
  edited,
  onChange,
}: {
  label: string
  help: string
  value: RepoSettingsInput['setup']
  placeholder?: string
  defaultTimeout?: string
  edited: boolean
  onChange: (value: RepoSettingsInput['setup']) => void
}) {
  const id = useId()
  const run = value?.run ?? ''
  const timeout = value?.timeout
  const update = (next: { run: string; timeout?: string | undefined }) =>
    onChange(
      next.run === '' && (next.timeout ?? '') === ''
        ? undefined
        : { run: next.run, ...(next.timeout ? { timeout: next.timeout } : {}) },
    )
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label} <Help>{help}</Help> <Edited when={edited} />
      </label>
      <input
        id={id}
        className={`${styles.input} ${styles.mono}`}
        placeholder={placeholder}
        value={run}
        onChange={(event) => update({ run: event.target.value, timeout })}
      />
      {(defaultTimeout !== undefined || timeout !== undefined) && run !== '' && (
        <span className={styles.timeout}>
          <label htmlFor={`${id}-timeout`}>Timeout</label>
          <input
            id={`${id}-timeout`}
            className={styles.timeoutInput}
            placeholder={defaultTimeout ?? '15m'}
            value={timeout ?? ''}
            onChange={(event) => update({ run, timeout: event.target.value })}
          />
          <Help>A duration such as 30s, 15m or 1h.</Help>
        </span>
      )}
    </div>
  )
}

function EnvTable({
  env,
  edited,
  onChange,
}: {
  env: RepoSettingsInput['env']
  edited: boolean
  onChange: (env: RepoSettingsInput['env']) => void
}) {
  const rows = useRowKeys(env.length)
  const set = (index: number, field: 'name' | 'value', text: string) =>
    onChange(env.map((v, i) => (i === index ? { ...v, [field]: text } : v)))
  return (
    <div className={styles.block}>
      <span className={styles.label}>
        Environment variables{' '}
        <Help>Committed to the repo, so no secrets. Put secrets in a file to copy.</Help>{' '}
        <Edited when={edited} />
      </span>
      <div className={styles.table}>
        {env.map((variable, index) => (
          <div className={styles.envRow} key={rows.keys[index]}>
            <input
              aria-label="Variable name"
              className={`${styles.cellInput} ${styles.mono}`}
              placeholder="NAME"
              value={variable.name}
              onChange={(event) => set(index, 'name', event.target.value)}
            />
            <input
              aria-label={`Value of ${variable.name || 'the variable'}`}
              className={`${styles.cellInput} ${styles.mono}`}
              placeholder="value"
              value={variable.value}
              onChange={(event) => set(index, 'value', event.target.value)}
            />
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`Remove ${variable.name || 'this variable'}`}
              onClick={() => {
                rows.removed(index)
                onChange(env.filter((_, i) => i !== index))
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`${styles.link} ${styles.tableAdd}`}
          onClick={() => onChange([...env, { name: '', value: '' }])}
        >
          + Add variable
        </button>
      </div>
    </div>
  )
}

function CopyList({
  copy,
  edited,
  onChange,
}: {
  copy: string[]
  edited: boolean
  onChange: (copy: string[]) => void
}) {
  const [adding, setAdding] = useState<string>()
  const commit = () => {
    const file = adding?.trim() ?? ''
    if (file !== '' && !copy.includes(file)) onChange([...copy, file])
    setAdding(undefined)
  }
  return (
    <div className={styles.block}>
      <span className={styles.label}>
        Files to copy from the local folder{' '}
        <Help>Untracked files such as .env, copied into each new worktree. Paths or globs.</Help>{' '}
        <Edited when={edited} />
      </span>
      <div className={styles.chips}>
        {copy.map((file) => (
          <span className={styles.fileChip} key={file}>
            {file}
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={`Don’t copy ${file}`}
              onClick={() => onChange(copy.filter((f) => f !== file))}
            >
              <CloseIcon size={10} />
            </button>
          </span>
        ))}
        {adding === undefined ? (
          <button type="button" className={styles.link} onClick={() => setAdding('')}>
            + Add
          </button>
        ) : (
          <input
            aria-label="File to copy"
            className={`${styles.chipInput} ${styles.mono}`}
            placeholder=".env"
            value={adding}
            ref={(input) => input?.focus()}
            onChange={(event) => setAdding(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
              if (event.key === 'Escape') setAdding(undefined)
            }}
          />
        )}
      </div>
    </div>
  )
}

function LocalFolder({
  folder,
  copy,
  home,
  onFolder,
}: {
  folder: RepoSettingsView['localFolder']
  copy: string[]
  home: string | undefined
  onFolder: (folder: string | undefined) => Promise<void>
}) {
  const [error, setError] = useState<string>()
  const missing = folder !== undefined && !folder.found
  const act = async (next: string | undefined) => {
    try {
      await onFolder(next)
      setError(undefined)
    } catch (failure) {
      setError(readableError(failure))
    }
  }
  const choose = async () => {
    const chosen = await ted.chooseFolder('Choose the repo’s local folder')
    if (chosen !== undefined) await act(chosen)
  }
  return (
    <div className={missing ? styles.folderMissing : styles.folderBox}>
      <div className={styles.folderHead}>
        <span className={styles.folderTitle}>Local folder</span>
        <Chip where="machine" />
      </div>
      <div className={styles.folderLine}>
        <span className={folder ? styles.folderPath : styles.caption}>
          {folder
            ? shortPath(folder.path, home)
            : 'None. Files to copy come from this folder on this machine.'}
        </span>
        <span className={views.headerSpacer} />
        <Button size="small" onClick={() => void choose()}>
          {missing ? 'Locate…' : 'Choose…'}
        </Button>
        {folder && (
          <Button size="small" onClick={() => void act(undefined)}>
            Clear
          </Button>
        )}
      </div>
      {missing && (
        <p className={styles.folderWarning}>
          <span aria-hidden>▲</span> Folder not found. {missingCopies(copy)}
        </p>
      )}
      {folder?.found &&
        folder.copies.map((file) => (
          <p key={file.path} className={file.found ? styles.found : styles.notFound}>
            {file.found ? `✓ ${file.path} found` : `${file.path} isn’t in this folder`}
          </p>
        ))}
      {error !== undefined && <p className={styles.fieldError}>{error}</p>}
    </div>
  )
}

function Apps({
  apps,
  edited,
  onChange,
}: {
  apps: AppInput[]
  edited: boolean
  onChange: (apps: AppInput[]) => void
}) {
  const [editing, setEditing] = useState<number>()
  const rows = useRowKeys(apps.length)
  return (
    <div className={styles.block}>
      <h3 className={styles.groupLabel}>
        Apps <Edited when={edited} />
      </h3>
      <div className={styles.apps}>
        {apps.map((app, index) =>
          editing === index ? (
            <AppEditor
              key={rows.keys[index]}
              app={app}
              onChange={(next) => onChange(apps.map((a, i) => (i === index ? next : a)))}
              onRemove={() => {
                rows.removed(index)
                onChange(apps.filter((_, i) => i !== index))
                setEditing(undefined)
              }}
              onDone={() => setEditing(undefined)}
            />
          ) : (
            <div className={styles.appRow} key={rows.keys[index]}>
              <span className={styles.appName}>{app.name || 'Unnamed App'}</span>
              <span className={styles.appKind}>{appKindLabels[app.kind]}</span>
              <span className={styles.appRun}>{app.run}</span>
              <button type="button" className={styles.link} onClick={() => setEditing(index)}>
                Edit
              </button>
            </div>
          ),
        )}
      </div>
      <button
        type="button"
        className={styles.link}
        onClick={() => {
          onChange([...apps, { name: '', kind: 'web', run: '' }])
          setEditing(apps.length)
        }}
      >
        + Add App
      </button>
    </div>
  )
}

function AppEditor({
  app,
  onChange,
  onRemove,
  onDone,
}: {
  app: AppInput
  onChange: (app: AppInput) => void
  onRemove: () => void
  onDone: () => void
}) {
  const id = useId()
  return (
    <fieldset className={styles.appEditor} aria-label={`App ${app.name}`}>
      <div className={styles.appFields}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-name`}>
            Name
          </label>
          <input
            id={`${id}-name`}
            className={styles.input}
            value={app.name}
            onChange={(event) => onChange({ ...app, name: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-kind`}>
            Kind
          </label>
          <select
            id={`${id}-kind`}
            className={styles.select}
            value={app.kind}
            onChange={(event) => {
              const kind = appKinds.find((k) => k === event.target.value) ?? 'web'
              const { url: _, ...rest } = app
              onChange(kind === 'web' ? { ...app, kind } : { ...rest, kind })
            }}
          >
            {appKinds.map((kind) => (
              <option key={kind} value={kind}>
                {appKindLabels[kind]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-run`}>
          Run command <Help>TED passes a free port as $PORT.</Help>
        </label>
        <input
          id={`${id}-run`}
          className={`${styles.input} ${styles.mono}`}
          value={app.run}
          onChange={(event) => onChange({ ...app, run: event.target.value })}
        />
      </div>
      {app.kind === 'web' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-url`}>
            URL
          </label>
          <input
            id={`${id}-url`}
            className={`${styles.input} ${styles.mono}`}
            placeholder="http://localhost:$PORT"
            value={app.url ?? ''}
            onChange={(event) => {
              const { url: _, ...rest } = app
              onChange(event.target.value === '' ? rest : { ...app, url: event.target.value })
            }}
          />
        </div>
      )}
      <div className={styles.appActions}>
        <button type="button" className={styles.dangerLink} onClick={onRemove}>
          Remove App
        </button>
        <span className={views.headerSpacer} />
        <Button size="small" onClick={onDone}>
          Done
        </Button>
      </div>
    </fieldset>
  )
}

function RepoInUseDialog({ removal, onClose }: { removal: RepoRemoval; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const one = removal.openTasks.length === 1
  return (
    <dialog
      ref={dialog}
      className={styles.inUseDialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <h2 id={headingId} className={styles.inUseHeading}>
        {`${removal.repo} can’t be removed yet`}
      </h2>
      <p className={styles.inUseBody}>
        {`${one ? 'An open Task has' : `${removal.openTasks.length} open Tasks have`} ${removal.repo} in ${one ? 'its' : 'their'} Repos field. Remove the repo from ${one ? 'it' : 'them'}, or finish or archive ${one ? 'it' : 'them'}, first.`}
      </p>
      <ul className={styles.inUseList}>
        {removal.openTasks.map((task) => (
          <li key={task.id} className={styles.inUseRow}>
            <span className={styles.inUseId}>{task.displayId}</span>
            <span className={styles.inUseTitle}>{task.title}</span>
          </li>
        ))}
      </ul>
      <div className={styles.inUseButtons}>
        <Button variant="primary" onClick={onClose}>
          OK
        </Button>
      </div>
    </dialog>
  )
}

function RepoMenu({ repo, onRemove }: { repo: string; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = usePopover(open, close)
  return (
    <div ref={ref} className={styles.menuAnchor}>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={`More for ${repo}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label={repo}>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              close()
              void ted.openOnGitHub(`https://github.com/${repo}`)
            }}
          >
            Open on GitHub
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.menuDanger}`}
            onClick={() => {
              close()
              onRemove()
            }}
          >
            Remove from Factory…
          </button>
        </div>
      )}
    </div>
  )
}

let nextRow = 0

function AddRepo({
  taken,
  home,
  onCancel,
  onAdd,
  onOpenFactory,
  onOpenGitHubSettings,
}: {
  taken: readonly RepoSettingsInput[]
  home: string | undefined
  onCancel: () => void
  onAdd: (repo: RepoSettingsInput, folder: string | undefined) => void
  onOpenFactory: (factoryId: string) => void
  onOpenGitHubSettings: () => void
}) {
  const [row, setRow] = useState<RepoRow>(() => ({
    id: `add-${nextRow++}`,
    text: '',
    name: '',
    nameEdited: false,
    checking: false,
  }))
  const ticket = useRef(0)
  const others: RepoRow[] = taken.map((repo, i) => ({
    id: `taken-${i}`,
    source: { remote: repo.repo },
    text: repo.repo,
    name: repo.name,
    nameEdited: true,
    checking: false,
    check: { ok: true, notes: [], repo: repo.repo, name: repo.name },
  }))

  async function check(source: RepoSource) {
    const mine = ++ticket.current
    setRow((r) => {
      const { check: _, ...rest } = r
      return { ...rest, source, checking: true }
    })
    let result: RepoCheck
    try {
      result = await ted.checkRepo({ source, primary: false })
    } catch (failure) {
      result = {
        ok: false,
        notes: [],
        problem: { kind: 'failed', text: readableError(failure), fixes: [{ kind: 'check-again' }] },
      }
    }
    if (ticket.current !== mine) return
    if (result.ok && taken.some((t) => t.repo.toLowerCase() === result.repo?.toLowerCase())) {
      result = {
        ...result,
        ok: false,
        problem: { kind: 'invalid', text: `${result.repo} is already in this Factory.`, fixes: [] },
      }
    }
    setRow((r) => ({
      ...r,
      check: result,
      checking: false,
      name: r.nameEdited ? r.name : (result.name ?? r.name),
    }))
  }

  const fix = (chosen: RepoFix) => {
    if (chosen.kind === 'open-factory') onOpenFactory(chosen.factoryId)
    else if (chosen.kind === 'github-settings') onOpenGitHubSettings()
    else if (chosen.kind === 'choose-folder') void chooseFolder()
    else if (row.source) void check(row.source)
  }

  async function chooseFolder() {
    const folder = await ted.chooseFolder('Choose the repo’s folder')
    if (folder !== undefined) void check({ folder })
  }

  const rows = [...others, row]
  const nameTaken = taken.some((t) => t.name === row.name)
  const ready =
    row.check?.ok === true && !row.checking && /^[a-z0-9-]+$/.test(row.name) && !nameTaken
  const folder =
    row.source && 'folder' in row.source ? (row.check?.folder ?? row.source.folder) : undefined

  return (
    <div className={styles.addRepo}>
      <RepoRowView
        row={row}
        rows={rows}
        index={rows.length - 1}
        home={home}
        dragging={undefined}
        onDragStart={() => undefined}
        onDragEnd={() => undefined}
        onDrop={() => undefined}
        onText={(text) => setRow((r) => ({ ...r, text }))}
        onSubmitRemote={() => {
          const text = row.text.trim()
          if (text !== '') void check({ remote: text })
        }}
        onChooseFolder={() => void chooseFolder()}
        onName={(name) => setRow((r) => ({ ...r, name, nameEdited: true }))}
        onRemove={onCancel}
        onFix={fix}
      />
      <div className={styles.addActions}>
        <span className={views.headerSpacer} />
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="primary"
          disabled={!ready}
          onClick={() => {
            const repo = row.check?.repo
            if (!ready || repo === undefined) return
            onAdd(
              {
                repo,
                remote: remoteFor(
                  repo,
                  row.source && 'remote' in row.source ? row.source.remote : undefined,
                ),
                name: row.name,
                env: [],
                copy: [],
                apps: [],
              },
              folder,
            )
          }}
        >
          Add repo
        </Button>
      </div>
    </div>
  )
}
