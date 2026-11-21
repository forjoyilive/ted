import type { StorageSummary, StoredBackup } from '@ted/protocol'
import { archivedTaskDayLimits, runOutputDayLimits } from '@ted/protocol/settings'
import {
  formatBytes,
  type StorageFolderChange,
  type StorageFolderKind,
  type StorageFolderLocation,
  storageKeptForMs,
} from '@ted/protocol/storage'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import dialogStyles from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Skeleton } from '../components/Loading.tsx'
import { useConnection } from '../data.ts'
import { ago, useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import { plural } from '../words.ts'
import { Button, Select, SettingRow, SettingsGroup, SettingsPage } from './controls.tsx'
import { ExportGroup } from './ExportGroup.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './storage.module.css'

const when = {
  format: (at: Date) =>
    formatDate(at, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
}
const day = {
  format: (at: Date) => formatDate(at, { day: 'numeric', month: 'short', year: 'numeric' }),
}

const runOutputChoices = [1, 3, 7, 14, 30, 90, 365]
const archivedChoices = [7, 14, 30, 90, 365]

function runOutputOptions(current: number) {
  const { min, max } = runOutputDayLimits
  return [...new Set([...runOutputChoices, current])]
    .filter((days) => days >= min && days <= max)
    .sort((a, b) => a - b)
    .map((days) => ({ value: days, label: plural(days, 'day') }))
}

function archivedOptions(current: number | null) {
  const { min, max } = archivedTaskDayLimits
  const days = [...new Set([...archivedChoices, ...(current === null ? [] : [current])])]
    .filter((d) => d >= min && d <= max)
    .sort((a, b) => a - b)
  return [{ value: 0, label: 'Never' }, ...days.map((d) => ({ value: d, label: plural(d, 'day') }))]
}

function ArchivedTasksRow({ days }: { days: number | null }) {
  const { epoch } = useConnection()
  const [kept, setKept] = useState(0)
  const [confirm, setConfirm] = useState<{ days: number; due: number }>()
  const [error, setError] = useState<string>()
  const latestChoice = useRef(0)

  useEffect(() => {
    void epoch
    if (days === null) {
      setKept(0)
      return
    }
    let current = true
    ted
      .archiveExpiry(days)
      .then((expiry) => current && setKept(expiry.kept))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [days, epoch])

  const save = async (next: number | null) => {
    setConfirm(undefined)
    try {
      await ted.updateSettings({ deleteArchivedAfterDays: next })
      setError(undefined)
    } catch (failure) {
      setError(readableError(failure))
    }
  }

  const choose = async (value: number) => {
    const choice = ++latestChoice.current
    const next = value === 0 ? null : value
    if (next === null || (days !== null && next >= days)) return save(next)
    try {
      const { due } = await ted.archiveExpiry(next)
      if (choice !== latestChoice.current) return
      if (due === 0) return save(next)
      setConfirm({ days: next, due })
    } catch (failure) {
      if (choice === latestChoice.current) setError(readableError(failure))
    }
  }

  return (
    <>
      <SettingRow setting="app.storage.archived-tasks" labelFor="archived-task-days">
        <Select
          id="archived-task-days"
          value={days ?? 0}
          options={archivedOptions(days)}
          width={110}
          onChange={(value) => void choose(value)}
        />
      </SettingRow>
      {kept > 0 && (
        <p className={styles.archivedNote}>
          {`Kept for now: ${plural(kept, 'archived Task')}, because ${kept === 1 ? 'it has' : 'each has'} Tasks under it, an open pull request or a Task it still blocks.`}
        </p>
      )}
      {error !== undefined && (
        <p className={styles.archivedNote} role="alert">
          {error}
        </p>
      )}
      {confirm && (
        <Dialog onClose={() => setConfirm(undefined)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                {`Delete ${plural(confirm.due, 'archived Task')} now?`}
              </h2>
              <p className={dialogStyles.body}>
                {confirm.due === 1
                  ? `It was archived more than ${plural(confirm.days, 'day')} ago, so Ted deletes it with its comments, Task brief and chats. This can’t be undone.`
                  : `They were archived more than ${plural(confirm.days, 'day')} ago, so Ted deletes them with their comments, Task briefs and chats. This can’t be undone.`}
              </p>
              <div className={dialogStyles.buttons}>
                <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
                <Button danger onClick={() => void save(confirm.days)}>
                  {`Delete ${plural(confirm.due, 'Task')}`}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  )
}

function ArchivedChatsRow({ days }: { days: number | null }) {
  const [confirm, setConfirm] = useState<{ days: number; due: number }>()
  const [error, setError] = useState<string>()
  const latestChoice = useRef(0)

  const save = async (next: number | null) => {
    setConfirm(undefined)
    try {
      await ted.updateSettings({ deleteArchivedChatsAfterDays: next })
      setError(undefined)
    } catch (failure) {
      setError(readableError(failure))
    }
  }

  const choose = async (value: number) => {
    const choice = ++latestChoice.current
    const next = value === 0 ? null : value
    if (next === null || (days !== null && next >= days)) return save(next)
    try {
      const { due } = await ted.chatArchiveExpiry(next)
      if (choice !== latestChoice.current) return
      if (due === 0) return save(next)
      setConfirm({ days: next, due })
    } catch (failure) {
      if (choice === latestChoice.current) setError(readableError(failure))
    }
  }

  return (
    <>
      <SettingRow setting="app.storage.archived-chats" labelFor="archived-chat-days">
        <Select
          id="archived-chat-days"
          value={days ?? 0}
          options={archivedOptions(days)}
          width={110}
          onChange={(value) => void choose(value)}
        />
      </SettingRow>
      {error !== undefined && (
        <p className={styles.archivedNote} role="alert">
          {error}
        </p>
      )}
      {confirm && (
        <Dialog onClose={() => setConfirm(undefined)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                {`Delete ${plural(confirm.due, 'archived chat')} now?`}
              </h2>
              <p className={dialogStyles.body}>
                {confirm.due === 1
                  ? `It was archived more than ${plural(confirm.days, 'day')} ago, so Ted deletes it with its conversation. Tasks it created stay. This can’t be undone.`
                  : `They were archived more than ${plural(confirm.days, 'day')} ago, so Ted deletes them with their conversations. Tasks they created stay. This can’t be undone.`}
              </p>
              <div className={dialogStyles.buttons}>
                <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
                <Button danger onClick={() => void save(confirm.days)}>
                  {`Delete ${plural(confirm.due, 'chat')}`}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  )
}

function backupTitle(backup: StoredBackup): string {
  const at = new Date(backup.takenAt)
  switch (backup.kind) {
    case 'daily':
      return `Daily · ${when.format(at)}`
    case 'pre-update':
      return `Before the update to ${backup.takenBy} · ${day.format(at)}`
    case 'before-restore':
      return `Before a restore · ${when.format(at)}`
  }
}

let lastShown: { storage: StorageSummary; leftAt: number } | undefined

function shownAgain(): StorageSummary | undefined {
  if (!lastShown || Date.now() - lastShown.leftAt > storageKeptForMs) return undefined
  return lastShown.storage
}

const folderLabels = { backups: 'Backups', 'sandbox-caches': 'Sandbox caches' } as const

function FolderLocations({
  folders,
  load,
}: {
  folders: StorageFolderLocation[]
  load: () => Promise<void>
}) {
  const { epoch } = useConnection()
  const [confirmation, setConfirmation] = useState<StorageFolderChange>()
  const [changing, setChanging] = useState<{ kind: StorageFolderKind; epoch: number }>()
  const [error, setError] = useState<{ kind: StorageFolderKind; message: string }>()
  const pending = changing?.epoch === epoch ? changing.kind : undefined

  const choose = async (kind: StorageFolderKind) => {
    try {
      const parent = await ted.chooseFolder(
        `Choose where to keep Ted’s ${folderLabels[kind].toLowerCase()}`,
      )
      if (parent !== undefined) setConfirmation({ kind, parent })
    } catch (failure) {
      setError({ kind, message: readableError(failure) })
    }
  }

  const change = async (request: StorageFolderChange) => {
    setConfirmation(undefined)
    setChanging({ kind: request.kind, epoch })
    setError(undefined)
    try {
      await ted.changeStorageFolder(request)
    } catch (failure) {
      setChanging(undefined)
      setError({ kind: request.kind, message: readableError(failure) })
      await load()
    }
  }

  if (folders.length === 0) return null

  return (
    <>
      <SettingsGroup setting="app.storage.locations">
        {folders.map(({ kind, path, custom, available, problem }) => (
          <SettingRow
            key={kind}
            title={folderLabels[kind]}
            detail={
              <>
                <span className={styles.folderPath}>{path}</span>
                {pending === kind && (
                  <span role="status">
                    {kind === 'backups' ? 'Moving backups…' : 'Changing cache location…'}
                  </span>
                )}
                {!available && (
                  <span role="status">
                    {kind === 'backups'
                      ? 'Folder unavailable. Reconnect the drive to access or create backups, then refresh Storage.'
                      : 'Folder unavailable. Reconnect the drive to start work that uses these caches.'}
                  </span>
                )}
                {(error?.kind === kind || problem) && (
                  <span role="alert">{error?.kind === kind ? error.message : problem}</span>
                )}
              </>
            }
          >
            <Button
              disabled={!available || pending !== undefined}
              onClick={() => void choose(kind)}
            >
              Change location…
            </Button>
            {custom && (
              <Button
                disabled={!available || pending !== undefined}
                onClick={() => setConfirmation({ kind, parent: null })}
              >
                Use default…
              </Button>
            )}
          </SettingRow>
        ))}
      </SettingsGroup>
      {confirmation && (
        <Dialog onClose={() => setConfirmation(undefined)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                {confirmation.kind === 'backups'
                  ? 'Move backups?'
                  : 'Change sandbox cache location?'}
              </h2>
              <p className={dialogStyles.body}>
                {confirmation.kind === 'backups'
                  ? 'Ted’s daemon will restart to move your backups and free space at the current location.'
                  : 'Ted’s daemon will restart and remove the old disposable caches. Ted rebuilds caches as needed, so the first Run may take longer.'}
              </p>
              <p className={styles.folderPath}>
                {confirmation.parent === null
                  ? 'Default location'
                  : `${confirmation.parent}/${confirmation.kind === 'backups' ? 'Ted Backups/Backups' : 'Ted Sandbox Caches'}`}
              </p>
              <div className={dialogStyles.buttons}>
                <Button onClick={() => setConfirmation(undefined)}>Cancel</Button>
                <Button onClick={() => void change(confirmation)}>
                  {confirmation.kind === 'backups'
                    ? 'Restart & move backups'
                    : 'Restart & change location'}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  )
}

export function StoragePage({ settings, dispatch }: SettingsPageProps) {
  const { epoch } = useConnection()
  const [storage, setStorage] = useState<StorageSummary | undefined>(shownAgain)
  const [error, setError] = useState<string>()
  const [folders, setFolders] = useState<StorageFolderLocation[]>([])
  const [removing, setRemoving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow()

  const load = useCallback(async (refresh = false) => {
    try {
      const locations = ted.storageFolders().then(setFolders, () => undefined)
      setStorage(await ted.getStorage({ refresh }))
      await locations
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => {
    void epoch
    void load()
  }, [epoch, load])

  useEffect(() => {
    const update = () => void ted.storageFolders().then(setFolders, () => undefined)
    const timer = setInterval(update, 5000)
    return () => clearInterval(timer)
  }, [])

  const latest = useRef(storage)
  latest.current = storage

  useEffect(
    () => () => {
      if (latest.current) lastShown = { storage: latest.current, leftAt: Date.now() }
      void ted.storageViewed().catch(() => undefined)
    },
    [],
  )

  const refresh = async () => {
    setRefreshing(true)
    try {
      await load(true)
    } finally {
      setRefreshing(false)
    }
  }

  const removeClones = async () => {
    setRemoving(true)
    try {
      await ted.removeUnusedClones()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRemoving(false)
      await load()
    }
  }

  const subtitle = storage
    ? `${formatBytes(storage.usedBytes)} used under ${storage.home} · ${formatBytes(storage.freeBytes)} free${storage.volume === '' ? '' : ` on ${storage.volume}`} · Measured ${ago(storage.measuredAt, now)}`
    : error
      ? undefined
      : 'Measuring…'
  const shown = storage?.categories.filter((c) => c.bytes > 0) ?? []
  const largest = Math.max(1, ...shown.map((c) => c.bytes))

  return (
    <SettingsPage
      title="Storage"
      subtitle={subtitle}
      actions={
        storage && (
          <Button onClick={() => refresh()} disabled={refreshing}>
            {refreshing ? 'Measuring…' : 'Refresh'}
          </Button>
        )
      }
    >
      {error !== undefined && <p className={styles.error}>{error}</p>}
      {!storage && !error && <Skeleton shape="settings" label="Loading storage…" />}
      {storage && (
        <>
          <SettingsGroup
            setting="app.storage.space"
            help={
              folders.some((folder) => folder.custom)
                ? 'Category sizes include files on other drives. The total above measures Ted’s home folder.'
                : undefined
            }
          >
            {shown.map((category) => (
              <div key={category.id} className={styles.usageRow}>
                <span className={styles.usageLabel}>{category.label}</span>
                <span className={styles.track} aria-hidden>
                  <span
                    className={styles.fill}
                    style={{ width: `${Math.max(1, (category.bytes / largest) * 100)}%` }}
                  />
                </span>
                <span className={styles.size}>{formatBytes(category.bytes)}</span>
              </div>
            ))}
          </SettingsGroup>

          <FolderLocations folders={folders} load={load} />

          <SettingsGroup setting="app.storage.store">
            <SettingRow setting="app.storage.store.event-log">
              <span className={styles.size}>{formatBytes(storage.storeFiles.eventLogBytes)}</span>
            </SettingRow>
            <SettingRow setting="app.storage.store.state">
              <span className={styles.size}>{formatBytes(storage.storeFiles.stateBytes)}</span>
            </SettingRow>
            <SettingRow setting="app.storage.store.backups">
              <span className={styles.size}>{formatBytes(storage.storeFiles.backupsBytes)}</span>
            </SettingRow>
          </SettingsGroup>

          {storage.largestWorktrees.length > 0 && (
            <SettingsGroup setting="app.storage.worktrees">
              {storage.largestWorktrees.map((worktree) => (
                <div key={worktree.taskId} className={styles.worktreeRow}>
                  <span className={styles.taskId}>{worktree.displayId}</span>
                  <span className={styles.taskTitle}>{worktree.title}</span>
                  <span className={styles.factory}>{worktree.factoryName}</span>
                  <span className={styles.spacer} />
                  <span className={styles.size}>{formatBytes(worktree.bytes)}</span>
                  <ActionButton
                    type="button"
                    className={styles.link}
                    onClick={() => {
                      dispatch({ type: 'close-settings' })
                      return dispatch({
                        type: 'open-task',
                        taskId: worktree.taskId,
                        factoryId: worktree.factoryId,
                      })
                    }}
                  >
                    Open Task
                  </ActionButton>
                </div>
              ))}
            </SettingsGroup>
          )}

          <SettingsGroup setting="app.storage.clean-up">
            <SettingRow
              setting="app.storage.clean-up.clones"
              detail={
                storage.removableClones.count === 0
                  ? 'None to remove'
                  : `${plural(storage.removableClones.count, 'clone')} · ${formatBytes(storage.removableClones.bytes)}`
              }
            >
              <Button
                onClick={() => removeClones()}
                disabled={removing || storage.removableClones.count === 0}
              >
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            </SettingRow>
            <SettingRow
              setting="app.storage.clean-up.simulators"
              detail={
                storage.simulators.count === 0
                  ? 'No simulators'
                  : `${plural(storage.simulators.count, 'simulator')} · ${formatBytes(storage.simulators.bytes)}`
              }
            >
              <Button onClick={() => undefined} disabled={storage.simulators.count === 0}>
                Erase
              </Button>
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup setting="app.storage.run-output">
            <SettingRow setting="app.storage.run-output.days" labelFor="run-output-days">
              <Select
                id="run-output-days"
                value={settings.runOutputDays}
                options={runOutputOptions(settings.runOutputDays)}
                width={110}
                onChange={(runOutputDays) => ted.updateSettings({ runOutputDays })}
              />
            </SettingRow>
            <ArchivedTasksRow days={settings.deleteArchivedAfterDays} />
            <ArchivedChatsRow days={settings.deleteArchivedChatsAfterDays} />
          </SettingsGroup>

          <ExportGroup />

          <section className={styles.backups} aria-label="Backups">
            <h2 className={styles.backupsLabel} data-setting="app.storage.backups">
              Backups
            </h2>
            <p className={styles.backupsNote}>
              7 daily copies and the last 3 from before updates, in {storage.backupsDir}. To restore
              one, run <code className={styles.code}>ted backup restore &lt;name&gt;</code> in a
              terminal.
            </p>
            {storage.backups.length > 0 && (
              <SettingsGroup>
                {storage.backups.map((backup) => (
                  <SettingRow
                    key={backup.name}
                    title={backupTitle(backup)}
                    detail={`${formatBytes(backup.bytes)} · ${backup.name}`}
                  >
                    <Button onClick={() => ted.showBackupInFolder(backup.name)}>
                      Show in folder
                    </Button>
                  </SettingRow>
                ))}
              </SettingsGroup>
            )}
          </section>
        </>
      )}
    </SettingsPage>
  )
}
