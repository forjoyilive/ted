import type { Backup, DataStatus } from '@ted/protocol'
import { useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { Help } from '../components/Help.tsx'
import { ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import styles from './DataScreen.module.css'

type ProblemStatus = Exclude<DataStatus, { state: 'ready' } | { state: 'opening' }>

const count = (n: number) => n.toLocaleString('en-US')

export const majorMinor = (version: string) => version.split('.').slice(0, 2).join('.')

export function formatBackupDate(iso: string): string {
  return formatDate(iso, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function timeLeft(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined
  if (seconds < 45) return 'less than a minute left'
  if (seconds < 90) return 'about a minute left'
  return `about ${Math.round(seconds / 60)} minutes left`
}

export function DataScreen({ status }: { status: ProblemStatus }) {
  return (
    <main className={styles.screen}>
      <section className={styles.content} aria-live="polite">
        {status.state === 'updating' && <Updating status={status} />}
        {status.state === 'failed' && <Failed status={status} />}
        {status.state === 'needs-newer' && <NeedsNewer status={status} />}
      </section>
    </main>
  )
}

function Updating({ status }: { status: Extract<DataStatus, { state: 'updating' }> }) {
  const share = status.total === 0 ? 0 : Math.min(1, status.done / status.total)
  const left = timeLeft(status.secondsLeft)
  return (
    <>
      <h1 className={styles.title}>Updating Ted’s data…</h1>
      <p className={styles.body}>
        Ted {status.version} is rebuilding its Tasks and comments from the event log. Runs keep
        going in the background.
      </p>
      <div className={styles.progressStack}>
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Updating Ted’s data"
          aria-valuemin={0}
          aria-valuemax={status.total}
          aria-valuenow={status.done}
        >
          <div className={styles.fill} style={{ width: `${share * 100}%` }} />
        </div>
        <p className={styles.caption}>
          {count(status.done)} of {count(status.total)} events{left && ` · ${left}`}
        </p>
      </div>
      <p className={styles.caption}>
        A copy of the data from before the update is in {status.backupsDir}.
      </p>
    </>
  )
}

function Failed({ status }: { status: Extract<DataStatus, { state: 'failed' }> }) {
  const stoppedAt =
    status.done !== undefined && status.total !== undefined
      ? `Rebuild stopped at event ${count(Math.min(status.done + 1, status.total))} of ${count(status.total)}`
      : undefined
  return (
    <>
      <h1 className={styles.title}>Ted couldn’t update its data</h1>
      <p className={styles.body}>
        The update to Ted {status.version} changes how Ted stores Tasks, and rebuilding them stopped
        partway. Nothing was deleted. Runs keep going in the background.
      </p>
      <div className={styles.error}>
        {stoppedAt && <p>{stoppedAt}</p>}
        <p>Error: {status.error}</p>
      </div>
      <div className={styles.actions}>
        {status.restore && <Restore backup={status.restore} primary withVersion />}
        <div className={styles.row}>
          <CopyReport status={status} />
          <ActionButton type="button" className={styles.secondary} onClick={() => ted.quit()}>
            Quit Ted
          </ActionButton>
        </div>
      </div>
    </>
  )
}

function NeedsNewer({ status }: { status: Extract<DataStatus, { state: 'needs-newer' }> }) {
  const needs = status.lastOpenedBy ? majorMinor(status.lastOpenedBy) : undefined
  return (
    <>
      <h1 className={styles.title}>
        {needs ? `This data needs Ted ${needs} or later` : 'This data needs a newer Ted'}
      </h1>
      <p className={styles.body}>
        Ted’s data in {status.dataDir}/{' '}
        {status.lastOpenedBy
          ? `was last opened by Ted ${status.lastOpenedBy}.`
          : 'was written by a newer Ted.'}{' '}
        This is Ted {status.version}, which can’t read it. Runs keep going in the background.
      </p>
      <div className={styles.actions}>
        <div className={styles.row}>
          <ActionButton type="button" className={styles.primary} onClick={() => ted.downloadTed()}>
            {needs ? `Download Ted ${needs}` : 'Download Ted'}
          </ActionButton>
          <CopyReport status={status} />
        </div>
        {status.restore && (
          <div className={styles.later}>
            <Restore backup={status.restore} primary={false} withVersion={false} />
          </div>
        )}
      </div>
    </>
  )
}

function Restore({
  backup,
  primary,
  withVersion,
}: {
  backup: Backup
  primary: boolean
  withVersion: boolean
}) {
  const [restoring, setRestoring] = useState(false)
  const since = formatBackupDate(backup.takenAt)
  const when = withVersion && backup.dataFrom ? `, when Ted ${backup.dataFrom} last ran` : ''
  return (
    <div className={styles.restore}>
      <ActionButton
        type="button"
        className={primary ? styles.primary : styles.secondary}
        disabled={restoring}
        onClick={() => {
          setRestoring(true)
          return ted.restoreBackup({ name: backup.name }).catch(() => setRestoring(false))
        }}
      >
        Restore the backup from before the update
      </ActionButton>
      <div className={styles.loses}>
        <span>
          Loses changes since {since}
          {when}.
        </span>
        <Help>
          Puts Ted’s data back as it was when this backup was taken. Ted saves the current data as
          another backup first.
        </Help>
      </div>
    </div>
  )
}

function CopyReport({ status }: { status: ProblemStatus }) {
  const [copied, setCopied] = useState(false)
  return (
    <ActionButton
      type="button"
      className={styles.secondary}
      onClick={() => {
        return ted.copyText(report(status)).then(() => setCopied(true))
      }}
    >
      {copied ? 'Copied' : 'Copy report'}
    </ActionButton>
  )
}

function report(status: ProblemStatus): string {
  return [`Ted ${status.version}`, JSON.stringify(status, null, 2)].join('\n')
}
