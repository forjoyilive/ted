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
import { pullRequestCiModes } from '@ted/protocol/task'
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { moveRow, protectedFolderNote, type RepoRow, shortPath } from '../add-factory.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { Button } from '../components/Button.tsx'
import { FactoryIconPicker } from '../components/FactoryIconPicker.tsx'
import { Help } from '../components/Help.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { Skeleton } from '../components/Loading.tsx'
import { Select } from '../components/Select.tsx'
import { SettingsSearch } from '../components/SettingsSearch.tsx'
import { useEventValue } from '../data.ts'
import {
  cleanupHasProblem,
  editedFields,
  missingCopies,
  type RepoField,
  remoteFor,
  type SettingsDraft,
  settingsChanges,
  settingsDraft,
  unsavedChanges,
  unsavedSections,
  unsavedSummary,
} from '../factory-settings.ts'
import type { NavigationAction } from '../navigation.ts'
import { usePendingAction } from '../pending-action.ts'
import { ciFoundText, pullRequestCiLabels } from '../pull-request-ci.ts'
import { ago, useNow } from '../requests.ts'
import { openSetting, useShownSetting } from '../setting-focus.ts'
import { type FactorySectionId, factorySections, type SettingId } from '../settings-search.ts'
import { readableError, ted } from '../ted.ts'
import { RepoRowView } from './AddFactoryDialog.tsx'
import { AgentFilesSection } from './AgentFilesSection.tsx'
import { AsanaIntakeSection } from './AsanaIntakeSection.tsx'
import styles from './FactorySettings.module.css'
import {
  AgentsSection,
  ChecksSection,
  CleanupSection,
  InvalidNotice,
  NotesSection,
  NotificationsSection,
  PermissionsSection,
  Toggle,
  WorkflowSection,
} from './FactorySettingsSections.tsx'
import { GitHubIntakeSection } from './GitHubIntakeSection.tsx'
import { LinearIntakeSection } from './LinearIntakeSection.tsx'
import { SaveSettingsDialog } from './SaveSettingsDialog.tsx'
import { usePopover } from './TaskList.tsx'
import views from './views.module.css'

const onMac = navigator.userAgent.includes('Mac')

const machine = navigator.userAgent.includes('Mac') ? 'this Mac' : 'this computer'
const appKindLabels = {
  web: 'web',
  command: 'command',
  'ios-simulator': 'iOS simulator',
  'android-emulator': 'Android emulator',
}
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
  dispatch: (action: NavigationAction) => void
  section?: FactorySectionId | undefined
}

const repoSections: ReadonlySet<FactorySectionId> = new Set([
  'repos',
  'workflow',
  'checks',
  'cleanup',
  'agents',
  'permissions',
  'notes',
])

export function FactorySettings({
  factory,
  section = 'general',
  banners,
  onOpenFactory,
  onOpenGitHubSettings,
  onRemoveFactory,
  onOpenTask,
  dispatch,
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
  const loading = useRef(0)
  const driftWhileLoading = useRef<number | undefined>(undefined)
  const shown = useRef<{ clean: boolean; version: string | undefined }>({
    clean: true,
    version: undefined,
  })
  const read = useCallback(
    (refresh: 'background' | 'never') => async () => {
      loading.current++
      try {
        return await ted.factorySettings(factory.id, { refresh })
      } finally {
        loading.current--
      }
    },
    [factory.id],
  )
  const {
    value: view,
    refresh,
    update,
  } = useEventValue<FactorySettingsView | undefined>({
    initial: undefined,
    key: factory.id,
    load: read('background'),
    event: (event) => {
      if (event.type === 'check-try-updated' && event.checkTry.factoryId === factory.id) {
        return (current) =>
          current && {
            ...current,
            tries: [...current.tries.filter((t) => t.name !== event.checkTry.name), event.checkTry],
          }
      }
      if (event.type === 'factory-settings-changed' && event.factoryId === factory.id) {
        return 'reload'
      }
      if (event.type === 'drift-changed') {
        const count = event.drift.factories[factory.id] ?? 0
        if (loading.current > 0) driftWhileLoading.current = count
        else if (count !== driftRef.current) return 'reload'
      }
      return undefined
    },
    changed: (loaded) => {
      setLoadError(undefined)
      if (!loaded) return
      if (started.current && (!shown.current.clean || loaded.version === shown.current.version)) {
        return
      }
      started.current = true
      restart(loaded)
    },
    error: (failure) => setLoadError(readableError(failure)),
  })
  const load = useCallback(() => refresh(read('never')), [refresh, read])
  driftRef.current = view?.stages.filter((s) => s.drift !== undefined).length ?? 0
  const drifted = driftRef.current
  useEffect(() => {
    const seen = driftWhileLoading.current
    if (!view || loading.current > 0) return
    driftWhileLoading.current = undefined
    if (seen !== undefined && seen !== drifted) void refresh()
  }, [view, drifted, refresh])
  const tries = view?.tries ?? []
  const { value: home } = useEventValue<string | undefined>({
    initial: undefined,
    load: ted.homeFolder,
    event: () => undefined,
  })

  const loaded = useMemo(() => base?.draft.repos ?? [], [base])
  const unsaved = useMemo(
    () => (base && draft ? unsavedChanges(draft, base.draft) : { count: 0, files: [] }),
    [draft, base],
  )
  const count = unsaved.count
  const stepProblem = draft !== undefined && cleanupHasProblem(draft.cleanup)
  shown.current = { clean: count === 0, version: base?.version }
  const openCleanup = useCallback(
    () =>
      openSetting(
        {
          id: 'factory.cleanup',
          name: 'Cleanup',
          where: '',
          target: { kind: 'factory', factoryId: factory.id, section: 'cleanup' },
        },
        dispatch,
      ),
    [factory.id, dispatch],
  )
  const onDraft = useCallback((change: (current: SettingsDraft) => SettingsDraft) => {
    if (mergeBusy.current) return
    setDraft((current) => (current ? change(current) : current))
  }, [])
  const onMode = useCallback(
    (permissions: FactorySettingsView['permissions']) =>
      update((current) => current && { ...current, permissions }),
    [update],
  )
  const setRepos = useCallback(
    (change: (repos: RepoSettingsInput[]) => RepoSettingsInput[]) =>
      onDraft((current) => ({ ...current, repos: change(current.repos) })),
    [onDraft],
  )
  const updateRepo = useCallback(
    (index: number, change: (repo: RepoSettingsInput) => RepoSettingsInput) =>
      setRepos((current) => current.map((repo, i) => (i === index ? change(repo) : repo))),
    [setRepos],
  )
  const removeRepo = useCallback(
    (was: string) =>
      onDraft((current) => ({
        ...current,
        repos: current.repos.filter((r) => r.was !== was),
        checks: current.checks.filter((c) => c.repo !== was),
      })),
    [onDraft],
  )
  const undoRemove = useCallback(
    (was: string) =>
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
      }),
    [onDraft, loaded, base],
  )
  const setFolder = useCallback(
    async (repo: RepoSettingsView, folder: string | undefined) => {
      if (folder === undefined) await ted.clearRepoLocalFolder(factory.id, repo.was)
      else await ted.setRepoLocalFolder(factory.id, repo.was, folder)
      await load()
    },
    [factory.id, load],
  )
  const newRepoFolder = useCallback((name: string, folder: string) => {
    pendingFolders.current.set(name, folder)
  }, [])

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
    let foldersSet = false
    for (const [name, folder] of pendingFolders.current) {
      if (next.repos.some((r) => r.name === name)) {
        await ted.setRepoLocalFolder(factory.id, name, folder).catch(() => undefined)
        foldersSet = true
      }
    }
    pendingFolders.current.clear()
    restart(foldersSet ? ((await load()) ?? next) : next)
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

  useShownSetting(scroller, 'factory')
  const edited = useMemo(
    () => (base && draft ? unsavedSections(draft, base.draft) : new Set<FactorySectionId>()),
    [draft, base],
  )
  const inRepo = repoSections.has(section)

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
          onClick={() => {
            setSetupError(undefined)
            return ted
              .newSetupTask(factory.id)
              .then(onOpenTask, (error: unknown) => setSetupError(readableError(error)))
          }}
        >
          New setup Task
        </Button>
      </header>
      {banners}
      <div className={styles.page}>
        <nav className={styles.nav} aria-label="Factory settings">
          <SettingsSearch factory={factory} dispatch={dispatch}>
            {factorySections.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={styles.navItem}
                onClick={() => {
                  if (scroller.current) scroller.current.scrollTop = 0
                  dispatch({
                    type: 'open',
                    screen: {
                      kind: 'factory',
                      factoryId: factory.id,
                      view: 'settings',
                      section: id,
                    },
                  })
                }}
                {...(id === section && { 'aria-current': 'page' as const })}
              >
                <span className={styles.navLabel}>{label}</span>
                {edited.has(id) && (
                  <span className={styles.unsavedDot} role="img" aria-label="Unsaved changes" />
                )}
                {id === 'workflow' && drifted > 0 && (
                  <span className={styles.navCount} title="Inherited Stage files that changed">
                    {drifted}
                  </span>
                )}
              </button>
            ))}
          </SettingsSearch>
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
                onMerge={() => mergeSaved()}
                onDismiss={() => {
                  setSaved(undefined)
                  setMergeError(undefined)
                }}
              />
            )}
            <fieldset className={styles.settingsFields} disabled={merging}>
              <legend className={styles.visuallyHidden}>Factory settings</legend>
              {inRepo && view && (
                <div className={`${styles.repoGuide} ${styles.wideSection}`}>
                  <strong>How repo settings are saved</strong>
                  <p>
                    Edit settings marked “In the repo”, then choose{' '}
                    <strong>Review and save…</strong>. Ted creates a pull request: a proposed change
                    to your repo. The changes must merge before Ted can use them.
                  </p>
                </div>
              )}
              {inRepo && view?.invalid && <InvalidNotice invalid={view.invalid} />}
              {section === 'general' && <GeneralSection factory={factory} />}
              {section === 'intake' && <IntakeSection key={factory.id} factoryId={factory.id} />}
              {inRepo && !view && !loadError && (
                <div className={styles.wideSection}>
                  <Skeleton shape="settings" label="Loading Factory settings…" />
                </div>
              )}
              {inRepo && loadError !== undefined && (
                <p className={styles.loadError} role="alert">
                  {loadError}
                </p>
              )}
              {section === 'repos' && view && draft && base && (
                <ReposSection
                  disabled={merging}
                  view={view}
                  draft={draft.repos}
                  loaded={loaded}
                  home={home}
                  onRepo={updateRepo}
                  onDraft={setRepos}
                  onFolder={setFolder}
                  onNewRepoFolder={newRepoFolder}
                  onRemoveRepo={removeRepo}
                  onUndoRemove={undoRemove}
                  factoryId={factory.id}
                  onOpenFactory={onOpenFactory}
                  onOpenGitHubSettings={onOpenGitHubSettings}
                />
              )}
              {view && draft && base && (
                <>
                  {section === 'workflow' && (
                    <WorkflowSection
                      view={view}
                      draft={draft}
                      loaded={base.draft}
                      onDraft={onDraft}
                      onOpenCleanup={openCleanup}
                    />
                  )}
                  {section === 'checks' && (
                    <ChecksSection view={view} draft={draft} tries={tries} onDraft={onDraft} />
                  )}
                  {section === 'cleanup' && <CleanupSection draft={draft} onDraft={onDraft} />}
                  {section === 'agent-files' && (
                    <section
                      className={`${styles.section} ${styles.wideSection}`}
                      aria-labelledby="agent-files"
                    >
                      <SectionHeading
                        id="agent-files"
                        setting="factory.agent-files"
                        title="Agents"
                        where="repo"
                        help="The Agents you can start chats with in this Factory, saved in .ted/agents.yaml and .ted/agents/. Override copies an inherited Agent into .ted/ for this Factory. Saving opens a settings pull request."
                      />
                      <AgentFilesSection
                        layer="factory"
                        folder=".ted/"
                        factoryId={factory.id}
                        rows={view.agentFiles}
                        draft={draft.agentFiles}
                        loaded={base.draft.agentFiles}
                        kept={draft.keepAgentFiles}
                        newSetting="factory.agent-files.new"
                        onDraft={(change) =>
                          onDraft((d) => ({ ...d, agentFiles: change(d.agentFiles) }))
                        }
                        onKeep={(id) =>
                          onDraft((d) =>
                            d.keepAgentFiles.includes(id)
                              ? d
                              : { ...d, keepAgentFiles: [...d.keepAgentFiles, id] },
                          )
                        }
                      />
                    </section>
                  )}
                  {section === 'agents' && (
                    <AgentsSection
                      view={view}
                      draft={draft}
                      loaded={base.draft}
                      onDraft={onDraft}
                    />
                  )}
                  {section === 'permissions' && (
                    <PermissionsSection
                      view={view}
                      draft={draft}
                      loaded={base.draft}
                      onDraft={onDraft}
                      onMode={onMode}
                    />
                  )}
                  {section === 'notes' && (
                    <NotesSection draft={draft} loaded={base.draft} onDraft={onDraft} />
                  )}
                </>
              )}
              {section === 'notifications' && <NotificationsSection factoryId={factory.id} />}
              {section === 'danger-zone' && <DangerZoneSection onRemove={onRemoveFactory} />}
            </fieldset>
          </div>
        </div>
      </div>
      {count > 0 && view && (
        <footer className={styles.saveBar}>
          <span className={styles.unsavedDot} aria-hidden />
          <div>
            <span>{unsavedSummary(unsaved)}</span>
            <p className={styles.saveHint}>
              {stepProblem
                ? 'A Cleanup step needs fixing before you can save.'
                : 'Review your changes before creating a pull request.'}
            </p>
          </div>
          <span className={views.headerSpacer} />
          <Button onClick={() => restart(view)}>Discard</Button>
          <Button variant="primary" disabled={stepProblem} onClick={() => setReviewing(true)}>
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
            return afterSave(result)
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
            <Button variant="primary" disabled={merging || hasEdits} onClick={onMerge}>
              {merging ? 'Merging…' : 'Merge pull request'}
            </Button>
          )}
          <Button onClick={() => ted.openOnGitHub(url)}>Open on GitHub</Button>
        </div>
      </div>
      <ActionButton
        type="button"
        className={styles.iconButton}
        aria-label="Dismiss"
        disabled={merging}
        onClick={onDismiss}
      >
        <CloseIcon size={12} />
      </ActionButton>
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
  setting,
  title,
  help,
  where,
}: {
  id: string
  setting: SettingId
  title: string
  help?: ReactNode
  where: 'machine' | 'repo'
}) {
  return (
    <div className={styles.sectionHeading} data-setting={setting}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {help !== undefined && <Help>{help}</Help>}
      <Chip where={where} />
    </div>
  )
}

function IntakeSection({ factoryId }: { factoryId: string }) {
  return (
    <section className={`${styles.section} ${styles.compactSection}`} aria-labelledby="intake">
      <SectionHeading id="intake" setting="factory.intake" title="Intake" where="machine" />
      <span className={styles.caption}>
        Choose which issues and tasks Automations can bring into this Factory.
      </span>
      <div className={styles.intakeGroups}>
        <GitHubIntakeSection factoryId={factoryId} />
        <LinearIntakeSection factoryId={factoryId} />
        <AsanaIntakeSection factoryId={factoryId} />
      </div>
    </section>
  )
}

const GeneralSection = memo(function GeneralSection({ factory }: { factory: Factory }) {
  const nameId = useId()
  const keyId = useId()
  const iconId = useId()
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
    <section className={`${styles.section} ${styles.compactSection}`} aria-labelledby="general">
      <SectionHeading id="general" setting="factory.general" title="General" where="machine" />
      <div className={styles.field} data-setting="factory.general.icon">
        <span className={styles.label} id={iconId}>
          Icon{' '}
          <Help>
            Shown in the sidebar, the Inbox, ⌘K and Task details. An emoji also starts the Factory’s
            notifications.
          </Help>
        </span>
        <div>
          <FactoryIconPicker
            factory={factory}
            labelledBy={iconId}
            onChange={(icon) => ted.setFactoryIcon(factory.id, icon)}
          />
        </div>
      </div>
      <div className={styles.fieldRow}>
        <div className={styles.field} data-setting="factory.general.name">
          <label className={styles.label} htmlFor={nameId}>
            Name <Help>Shown in the sidebar and the Inbox. Task IDs don’t change.</Help>
          </label>
          <input
            id={nameId}
            className={styles.input}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => saveName()}
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
      <div className={styles.autoStartRow} data-setting="factory.general.auto-start">
        <div className={styles.field}>
          <span className={styles.label}>Start Backlog Tasks automatically</span>
          <span className={styles.caption}>
            Start the next eligible Task when a working-Run slot is free. Uses priority and manual
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
          onChange={(enabled) => saveAutoStart(enabled)}
        />
      </div>
    </section>
  )
})

const DangerZoneSection = memo(function DangerZoneSection({ onRemove }: { onRemove: () => void }) {
  return (
    <section className={`${styles.section} ${styles.compactSection}`} aria-labelledby="danger-zone">
      <SectionHeading
        id="danger-zone"
        setting="factory.danger-zone"
        title="Danger zone"
        where="machine"
      />
      <div className={styles.removeRow} data-setting="factory.danger-zone.remove">
        <span className={styles.label}>
          Remove Factory{' '}
          <Help>
            Stops its Runs and deletes its Tasks and worktrees from {machine}. Its .ted/ folder
            stays in the repo.
          </Help>
        </span>
        <span className={views.headerSpacer} />
        <ActionButton type="button" className={styles.dangerButton} onClick={onRemove}>
          Remove Factory…
        </ActionButton>
      </div>
    </section>
  )
})

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

const ReposSection = memo(function ReposSection({
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
  const edits = useMemo(() => {
    const known = new WeakMap<RepoSettingsInput, Set<RepoField>>()
    return (repo: RepoSettingsInput) => {
      let edited = known.get(repo)
      if (!edited) {
        edited = editedFields(repo, loaded)
        known.set(repo, edited)
      }
      return edited
    }
  }, [loaded])
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
    <section className={`${styles.section} ${styles.wideSection}`} aria-labelledby="repos">
      <SectionHeading
        id="repos"
        setting="factory.repos"
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
            edited={edits(repo)}
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
            onRemove={() => askToRemove(repo)}
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
          <ActionButton type="button" className={styles.link} onClick={() => setAdding(true)}>
            + Add repo
          </ActionButton>
          <Help>
            Adds a repo through the same Save. Afterwards a New setup Task can set up its checks and
            Apps.
          </Help>
        </div>
      )}
    </section>
  )
})

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
  const now = useNow()

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
          <ActionButton
            type="button"
            className={styles.iconButton}
            aria-label={`Don’t add ${repo.repo}`}
            onClick={onRemoveNew}
          >
            <CloseIcon size={12} />
          </ActionButton>
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
        <div className={styles.field} data-setting="factory.repos.base-branch">
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
        <div className={styles.field} data-setting="factory.repos.merge-method">
          <label className={styles.label} htmlFor={`${id}-merge`}>
            Merge method <Edited when={edited.has('mergeMethod')} />
          </label>
          <Select
            fullWidth
            id={`${id}-merge`}
            controlClassName={styles.select}
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
          </Select>
        </div>
      </div>

      <div className={styles.twoColumns} data-setting="factory.repos.pull-request-ci">
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-ci`}>
            Pull request CI{' '}
            <Help>
              Whether Ted waits for CI checks on this repo’s pull requests before it merges. Detect
              decides from the repo when a Task pushes.
            </Help>{' '}
            <Edited when={edited.has('pullRequestCi')} />
          </label>
          <Select
            fullWidth
            id={`${id}-ci`}
            controlClassName={styles.select}
            value={repo.pullRequestCi ?? 'auto'}
            onChange={(event) => {
              const chosen = pullRequestCiModes.find((m) => m === event.target.value) ?? 'auto'
              onChange((r) => {
                const { pullRequestCi: _, ...rest } = r
                return chosen === 'auto' ? rest : { ...rest, pullRequestCi: chosen }
              })
            }}
          >
            {pullRequestCiModes.map((mode) => (
              <option key={mode} value={mode}>
                {pullRequestCiLabels[mode]}
              </option>
            ))}
          </Select>
        </div>
        <p className={`${styles.caption} ${styles.ciFound}`} data-testid="pull-request-ci-found">
          {ciFoundText(shown?.ciFound, repo.pullRequestCi ?? 'auto', (at) => ago(at, now))}
        </p>
      </div>

      <h3 className={styles.groupLabel} data-setting="factory.repos.worktree">
        Worktree
      </h3>
      <div className={styles.twoColumns}>
        <CommandField
          setting="factory.repos.worktree.setup"
          label="Setup command"
          help="Runs once in each new worktree, after copying files, before any Run uses it."
          value={repo.setup}
          defaultTimeout="15m"
          edited={edited.has('setup')}
          onChange={(setup) => onChange((r) => withCommand(r, 'setup', setup))}
        />
        <CommandField
          setting="factory.repos.worktree.teardown"
          label="Teardown command"
          help="Runs before Ted removes a worktree. If it fails, Ted logs it and removes the worktree anyway."
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
  setting,
  label,
  help,
  value,
  placeholder,
  defaultTimeout,
  edited,
  onChange,
}: {
  setting: SettingId
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
  const update = (next: { run: string; timeout?: string | undefined }) => {
    if (next.run === '' && (next.timeout ?? '') === '') return onChange(undefined)
    const setup: NonNullable<RepoSettingsInput['setup']> = { run: next.run }
    if (next.timeout) setup.timeout = next.timeout
    return onChange(setup)
  }
  return (
    <div className={styles.field} data-setting={setting}>
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
    <div className={styles.block} data-setting="factory.repos.env">
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
            <ActionButton
              type="button"
              className={styles.iconButton}
              aria-label={`Remove ${variable.name || 'this variable'}`}
              onClick={() => {
                rows.removed(index)
                return onChange(env.filter((_, i) => i !== index))
              }}
            >
              <CloseIcon size={12} />
            </ActionButton>
          </div>
        ))}
        <ActionButton
          type="button"
          className={`${styles.link} ${styles.tableAdd}`}
          onClick={() => onChange([...env, { name: '', value: '' }])}
        >
          + Add variable
        </ActionButton>
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
    <div className={styles.block} data-setting="factory.repos.copy">
      <span className={styles.label}>
        Files to copy from the local folder{' '}
        <Help>Untracked files such as .env, copied into each new worktree. Paths or globs.</Help>{' '}
        <Edited when={edited} />
      </span>
      <div className={styles.chips}>
        {copy.map((file) => (
          <span className={styles.fileChip} key={file}>
            {file}
            <ActionButton
              type="button"
              className={styles.chipRemove}
              aria-label={`Don’t copy ${file}`}
              onClick={() => onChange(copy.filter((f) => f !== file))}
            >
              <CloseIcon size={10} />
            </ActionButton>
          </span>
        ))}
        {adding === undefined ? (
          <ActionButton type="button" className={styles.link} onClick={() => setAdding('')}>
            + Add
          </ActionButton>
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
  const folderNote = folder && protectedFolderNote(folder.path, home, onMac)
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
        <Button onClick={() => choose()}>{missing ? 'Locate…' : 'Choose…'}</Button>
        {folder && <Button onClick={() => act(undefined)}>Clear</Button>}
      </div>
      {missing && (
        <p className={styles.folderWarning}>
          <span aria-hidden>▲</span> Folder not found. {missingCopies(copy)}
        </p>
      )}
      {folderNote !== undefined && <p className={styles.caption}>{folderNote}</p>}
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
      <h3 className={styles.groupLabel} data-setting="factory.repos.apps">
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
              <ActionButton type="button" className={styles.link} onClick={() => setEditing(index)}>
                Edit
              </ActionButton>
            </div>
          ),
        )}
      </div>
      <ActionButton
        type="button"
        className={styles.link}
        onClick={() => {
          onChange([...apps, { name: '', kind: 'web', run: '' }])
          setEditing(apps.length)
        }}
      >
        + Add App
      </ActionButton>
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
          <Select
            fullWidth
            id={`${id}-kind`}
            controlClassName={styles.select}
            value={app.kind}
            onChange={(event) => {
              const kind = appKinds.find((k) => k === event.target.value) ?? 'web'
              const { url: _, device: __, ...rest } = app
              const device = kind === app.kind ? app.device : undefined
              const kept = device === undefined ? rest : { ...rest, device }
              onChange(kind === 'web' ? { ...app, kind } : { ...kept, kind })
            }}
          >
            {appKinds.map((kind) => (
              <option key={kind} value={kind}>
                {appKindLabels[kind]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-run`}>
          Run command{' '}
          <Help>
            {app.kind === 'ios-simulator'
              ? 'Ted passes the Task’s simulator as $TED_SIMULATOR_UDID. Build with xcodebuild -derivedDataPath "$TED_DERIVED_DATA" -packageCachePath "$TED_SWIFTPM_CACHE" so the build stays in the Task’s own folders.'
              : app.kind === 'android-emulator'
                ? 'Ted passes the Task’s emulator as $ANDROID_SERIAL and $TED_EMULATOR_SERIAL, and points $GRADLE_USER_HOME at the Task’s own cache folder.'
                : 'Ted passes a free port as $PORT.'}
          </Help>
        </label>
        <input
          id={`${id}-run`}
          className={`${styles.input} ${styles.mono}`}
          value={app.run}
          onChange={(event) => onChange({ ...app, run: event.target.value })}
        />
      </div>
      {(app.kind === 'ios-simulator' || app.kind === 'android-emulator') && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-device`}>
            Device{' '}
            <Help>
              {app.kind === 'android-emulator'
                ? 'The name of an Android virtual device from Android Studio’s Device Manager. Ted makes its own copy for each Task, with the same system image and hardware.'
                : 'The name of an iOS simulator in Xcode, such as iPhone 16. Ted makes its own copy for each Task.'}
            </Help>
          </label>
          <input
            id={`${id}-device`}
            className={`${styles.input} ${styles.mono}`}
            placeholder={app.kind === 'android-emulator' ? 'Pixel_8_API_35' : 'iPhone 16'}
            value={app.device ?? ''}
            onChange={(event) => {
              const { device: _, ...rest } = app
              onChange(event.target.value === '' ? rest : { ...app, device: event.target.value })
            }}
          />
        </div>
      )}
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
        <ActionButton type="button" className={styles.dangerLink} onClick={onRemove}>
          Remove App
        </ActionButton>
        <span className={views.headerSpacer} />
        <Button onClick={onDone}>Done</Button>
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
  const activity = usePendingAction(`repo-menu:${repo}`)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = usePopover(open, close)
  return (
    <div ref={ref} className={styles.menuAnchor}>
      <ActionButton
        type="button"
        className={styles.iconButton}
        aria-label={`More for ${repo}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </ActionButton>
      {open && (
        <div className={styles.menu} role="menu" aria-label={repo}>
          <ActionButton
            type="button"
            role="menuitem"
            disabled={activity.pending}
            className={styles.menuItem}
            onClick={() => {
              return activity.run(() => ted.openOnGitHub(`https://github.com/${repo}`))?.then(close)
            }}
          >
            Open on GitHub
          </ActionButton>
          <ActionButton
            type="button"
            role="menuitem"
            disabled={activity.pending}
            className={`${styles.menuItem} ${styles.menuDanger}`}
            onClick={() => {
              close()
              return onRemove()
            }}
          >
            Remove from Factory…
          </ActionButton>
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
    else if (chosen.kind === 'choose-folder') return chooseFolder()
    else if (row.source) return check(row.source)
  }

  async function chooseFolder() {
    const folder = await ted.chooseFolder('Choose the repo’s folder')
    if (folder !== undefined) await check({ folder })
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
          if (text !== '') check({ remote: text })
        }}
        onChooseFolder={() => chooseFolder()}
        onName={(name) => setRow((r) => ({ ...r, name, nameEdited: true }))}
        onRemove={onCancel}
        onFix={fix}
      />
      <div className={styles.addActions}>
        <span className={views.headerSpacer} />
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() => {
            const repo = row.check?.repo
            if (!ready || repo === undefined) return
            return onAdd(
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
