import type { StorageSummary, StoredBackup } from '@ted/protocol'
import { runOutputDayLimits } from '@ted/protocol/settings'
import { formatBytes, storageKeptForMs } from '@ted/protocol/storage'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { Skeleton } from '../components/Loading.tsx'
import { useConnection } from '../data.ts'
import { ago, useNow } from '../requests.ts'
import { ted } from '../ted.ts'
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

function runOutputOptions(current: number) {
  const { min, max } = runOutputDayLimits
  return [...new Set([...runOutputChoices, current])]
    .filter((days) => days >= min && days <= max)
    .sort((a, b) => a - b)
    .map((days) => ({ value: days, label: plural(days, 'day') }))
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

export function StoragePage({ settings, dispatch }: SettingsPageProps) {
  const { epoch } = useConnection()
  const [storage, setStorage] = useState<StorageSummary | undefined>(shownAgain)
  const [error, setError] = useState<string>()
  const [removing, setRemoving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow()

  const load = useCallback(async (refresh = false) => {
    try {
      setStorage(await ted.getStorage({ refresh }))
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => {
    void epoch
    void load()
  }, [epoch, load])

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
          <SettingsGroup setting="app.storage.space">
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
