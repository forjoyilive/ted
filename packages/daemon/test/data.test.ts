import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type BackupsSummary,
  type Banner,
  type DataStatus,
  readDaemonInfo,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  editEventlog as editEventlogOf,
  killRunHosts,
  makeTempHome,
  pretendStateSchemaChanged,
  storeDbFiles,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
})

const storeDir = () => path.join(home, 'store', 'ted')

async function start(version: string, statuses: DataStatus[] = []) {
  daemon = await startDaemon({
    home,
    version,
    claudeBin: stubClaudePath,
    onDataStatus: (status) => statuses.push(status),
  })
  return api(daemon.port, { appKey: daemon.appToken })
}

async function stop(): Promise<void> {
  await daemon?.stop()
  daemon = undefined
}

const storeFiles = (dir = storeDir()) => storeDbFiles(dir)
const pretendTheStateSchemaChanged = () => pretendStateSchemaChanged(home)
const editEventlog = (sql: string) => editEventlogOf(home, sql)

async function loggedEvents(): Promise<number> {
  const file = (await storeFiles()).find((f) => f.startsWith('eventlog')) ?? ''
  const db = new DatabaseSync(path.join(storeDir(), file))
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM eventlog').get() as { count: number }
  db.close()
  return count
}

describe('store migrations', () => {
  test('a schema change backs up the store, then rebuilds state from the log with progress', async () => {
    let ted = await start('1.0.0')
    await ted.call('POST', '/tasks', { title: 'Fix login' })
    await ted.call('POST', '/tasks', { title: 'Add dark mode' })
    const before = (await ted.call('GET', '/tasks')).body as Task[]
    await stop()
    const logged = await loggedEvents()
    await pretendTheStateSchemaChanged()

    const statuses: DataStatus[] = []
    ted = await start('1.1.0', statuses)

    const updates = statuses.filter((s) => s.state === 'updating')
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.at(-1)).toMatchObject({ version: '1.1.0', done: logged, total: logged })
    expect(statuses.at(-1)).toEqual({ state: 'ready' })
    expect((await ted.call('GET', '/tasks')).body).toEqual(before)
    expect((await ted.call('GET', '/data-status')).body).toEqual({ state: 'ready' })

    const { backups } = (await ted.call('GET', '/backups')).body as BackupsSummary
    const preUpdate = backups.filter((b) => b.kind === 'pre-update')
    expect(preUpdate).toHaveLength(1)
    expect(preUpdate[0]).toMatchObject({ dataFrom: '1.0.0' })
    const copied = await storeFiles(
      path.join(home, 'backups', preUpdate[0]?.name ?? '', 'store', 'ted'),
    )
    expect(copied.some((f) => f.startsWith('eventlog'))).toBe(true)
    expect(copied.some((f) => f.startsWith('state'))).toBe(false)
    expect(await readdir(path.join(home, 'backups', preUpdate[0]?.name ?? '', 'store'))).toContain(
      'ted-store.json',
    )
    expect((await storeFiles()).some((f) => f.startsWith('stateold'))).toBe(false)
  })

  test('opening without a schema change takes no pre-update backup and shows no progress', async () => {
    let ted = await start('1.0.0')
    await ted.call('POST', '/tasks', { title: 'Fix login' })
    await stop()

    const statuses: DataStatus[] = []
    ted = await start('1.0.1', statuses)

    expect(statuses.some((s) => s.state === 'updating')).toBe(false)
    const { backups } = (await ted.call('GET', '/backups')).body as BackupsSummary
    expect(backups.filter((b) => b.kind === 'pre-update')).toEqual([])
  })

  test('keeps the last three pre-update backups', async () => {
    let ted = await start('1.0.0')
    await ted.call('POST', '/tasks', { title: 'Fix login' })
    for (const version of ['1.1.0', '1.2.0', '1.3.0', '1.4.0']) {
      await stop()
      await pretendTheStateSchemaChanged()
      ted = await start(version)
    }

    const { backups } = (await ted.call('GET', '/backups')).body as BackupsSummary
    expect(backups.filter((b) => b.kind === 'pre-update').map((b) => b.dataFrom)).toEqual([
      '1.3.0',
      '1.2.0',
      '1.1.0',
    ])
  })

  test('a failed rebuild shows the failure, keeps the store closed and offers the backup', async () => {
    let ted = await start('1.0.0')
    await ted.call('POST', '/tasks', { title: 'Fix login' })
    await ted.call('POST', '/tasks', { title: 'Add dark mode' })
    await stop()
    const logged = await loggedEvents()
    await pretendTheStateSchemaChanged()
    await editEventlog(
      `UPDATE eventlog SET argsJson = '{}' WHERE seqNumGlobal = (SELECT MAX(seqNumGlobal) FROM eventlog WHERE name = 'v1.TaskRanked')`,
    )

    ted = await start('1.1.0')

    const status = (await ted.call('GET', '/data-status')).body as DataStatus
    expect(status).toMatchObject({ state: 'failed', version: '1.1.0', total: logged })
    if (status.state !== 'failed') throw new Error('not failed')
    expect(status.error).toBe('v1.TaskRanked: Missing key at ["taskId"]')
    expect(status.restore).toMatchObject({ kind: 'pre-update', dataFrom: '1.0.0' })
    const tasks = await ted.call('GET', '/tasks')
    expect(tasks.status).toBe(503)
    expect(tasks.body.error).toBe('TED couldn’t update its data')
  })

  test('a store written by a newer TED doesn’t open, and restoring its pre-update backup does', async () => {
    let ted = await start('1.0.0')
    await ted.call('POST', '/tasks', { title: 'Fix login' })
    await stop()
    await pretendTheStateSchemaChanged()
    ted = await start('1.4.0')
    await ted.call('PATCH', '/settings', { appearance: 'dark' })
    await stop()
    await editEventlog(
      `UPDATE eventlog SET name = 'v9.FromTheFuture' WHERE name IN ('v1.AppearanceChanged', 'v1.MachineSettingsChanged')`,
    )

    const statuses: DataStatus[] = []
    ted = await start('1.3.2', statuses)

    const status = (await ted.call('GET', '/data-status')).body as DataStatus
    expect(status).toMatchObject({
      state: 'needs-newer',
      version: '1.3.2',
      lastOpenedBy: '1.4.0',
      restore: { kind: 'pre-update', dataFrom: '1.0.0' },
    })
    expect((await ted.call('GET', '/tasks')).status).toBe(503)
    if (status.state !== 'needs-newer' || !status.restore) throw new Error('no backup offered')

    const restored = await ted.call('POST', '/backups/restore', { name: status.restore.name })

    expect(restored.status).toBe(200)
    expect(restored.body).toMatchObject({ restored: status.restore.name, stoppedRuns: 0 })
    expect((await ted.call('GET', '/data-status')).body).toEqual({ state: 'ready' })
    expect(((await ted.call('GET', '/tasks')).body as Task[]).map((t) => t.title)).toEqual([
      'Fix login',
    ])
    expect((await ted.call('GET', '/settings')).body).toMatchObject({ appearance: 'system' })
    const { backups } = (await ted.call('GET', '/backups')).body as BackupsSummary
    expect(backups.find((b) => b.name === restored.body.saved)).toMatchObject({
      kind: 'before-restore',
      dataFrom: '1.4.0',
    })
  })

  test('the app can still be opened and quit while the store stays closed', async () => {
    const ted = await start('1.4.0')
    await ted.call('PATCH', '/settings', { appearance: 'dark' })
    await stop()
    await editEventlog(
      `UPDATE eventlog SET name = 'v9.FromTheFuture' WHERE name IN ('v1.AppearanceChanged', 'v1.MachineSettingsChanged')`,
    )
    let shutdowns = 0
    daemon = await startDaemon({
      home,
      version: '1.3.2',
      claudeBin: stubClaudePath,
      onShutdown: () => shutdowns++,
    })
    const closed = api(daemon.port, { appKey: daemon.appToken })

    expect((await closed.call('GET', '/data-status')).body).toMatchObject({ state: 'needs-newer' })
    expect((await closed.call('POST', '/app/open')).body).toEqual({ opened: false })
    expect((await closed.call('POST', '/shutdown')).status).toBe(200)
    await waitUntil(() => shutdowns === 1 || undefined, 'the shutdown handover')
  })

  test('quitting while the store updates waits for it, then stops the Runs it recovered', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-cwd-'))
    try {
      let ted = await start('1.0.0')
      const run = await ted.startRun([{ waitFor: path.join(cwd, 'never') }], cwd)
      await waitUntil(async () => (await ted.getRun(run.id)).run.state === 'working', 'Run')
      await stop()
      await pretendTheStateSchemaChanged()

      let shutdown: Promise<{ status: number }> | undefined
      let shutdowns = 0
      daemon = await startDaemon({
        home,
        version: '1.1.0',
        claudeBin: stubClaudePath,
        appToken: 'app-token',
        onShutdown: () => shutdowns++,
        onDataStatus: (status) => {
          if (status.state !== 'updating' || shutdown) return
          shutdown = (async () => {
            const info = await readDaemonInfo(home)
            return api(info?.port ?? 0, { appKey: 'app-token' }).call('POST', '/shutdown')
          })()
        },
      })
      ted = api(daemon.port, { appKey: daemon.appToken })

      expect((await shutdown)?.status).toBe(200)
      expect((await ted.getRun(run.id)).run.state).toBe('finished')
      await waitUntil(() => shutdowns === 1 || undefined, 'the shutdown handover')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('restore', () => {
  test('asks to stop running Runs, then stops them, saves current data and restores', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-cwd-'))
    try {
      const ted = await start('1.0.0')
      const backups = (await ted.call('GET', '/backups')).body as BackupsSummary
      const daily = backups.backups.find((b) => b.kind === 'daily')
      if (!daily) throw new Error('no daily backup')
      await ted.call('POST', '/tasks', { title: 'After the backup' })
      const run = await ted.startRun([{ waitFor: path.join(cwd, 'never') }], cwd)
      await waitUntil(async () => (await ted.getRun(run.id)).run.state === 'working', 'Run')

      expect(((await ted.call('GET', '/backups')).body as BackupsSummary).activeRuns).toBe(1)
      const refused = await ted.call('POST', '/backups/restore', { name: daily.name })
      expect(refused.status).toBe(409)
      expect(refused.body.error).toBe('1 Run is running. Stop it to restore.')

      const restored = await ted.call('POST', '/backups/restore', {
        name: daily.name,
        stopRuns: true,
      })

      expect(restored.status).toBe(200)
      expect(restored.body).toMatchObject({ restored: daily.name, stoppedRuns: 1 })
      expect(((await ted.call('GET', '/tasks')).body as Task[]).map((t) => t.title)).toEqual([])
      const after = (await ted.call('GET', '/backups')).body as BackupsSummary
      expect(after.activeRuns).toBe(0)
      expect(after.backups.find((b) => b.name === restored.body.saved)?.kind).toBe('before-restore')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('can restore the oldest before-restore backup, which the restore’s own copy would push out', async () => {
    const ted = await start('1.0.0')
    const daily = ((await ted.call('GET', '/backups')).body as BackupsSummary).backups[0]
    await ted.call('POST', '/tasks', { title: 'Kept in the oldest copy' })
    for (let i = 0; i < 3; i++) {
      const res = await ted.call('POST', '/backups/restore', { name: daily?.name })
      expect(res.status).toBe(200)
    }
    const oldest = ((await ted.call('GET', '/backups')).body as BackupsSummary).backups
      .filter((b) => b.kind === 'before-restore')
      .at(-1)

    const res = await ted.call('POST', '/backups/restore', { name: oldest?.name })

    expect(res.status).toBe(200)
    expect(((await ted.call('GET', '/tasks')).body as Task[]).map((t) => t.title)).toEqual([
      'Kept in the oldest copy',
    ])
  })

  test('fails when the restored data can’t be opened, and keeps the copy of the data before', async () => {
    let ted = await start('1.0.0')
    await ted.call('PATCH', '/settings', { appearance: 'dark' })
    await stop()
    await pretendTheStateSchemaChanged()
    ted = await start('1.0.1')
    const newer = ((await ted.call('GET', '/backups')).body as BackupsSummary).backups.find(
      (b) => b.kind === 'pre-update',
    )
    if (!newer) throw new Error('no pre-update backup')
    await editEventlogOf(
      path.join(home, 'backups', newer.name),
      `UPDATE eventlog SET name = 'v9.FromTheFuture' WHERE name IN ('v1.AppearanceChanged', 'v1.MachineSettingsChanged')`,
    )

    const res = await ted.call('POST', '/backups/restore', { name: newer?.name })

    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(
      new RegExp(
        `^Restored ${newer?.name}, but TED couldn’t open it: This data needs a newer TED\\. Your data from before the restore is in backup before-restore-\\d{8}-\\d{6}\\.$`,
      ),
    )
  })

  test('restores a backup taken before backups left out the state database', async () => {
    let ted = await start('1.0.0')
    await ted.call('POST', '/tasks', { title: 'In the old backup' })
    await stop()
    const old = path.join(home, 'backups', 'pre-update-20200101-090000')
    await cp(path.join(home, 'store'), path.join(old, 'store'), { recursive: true })
    const manifest = { kind: 'pre-update', takenAt: '2020-01-01T09:00:00.000Z', takenBy: '1.0.0' }
    await writeFile(
      path.join(old, 'backup.json'),
      JSON.stringify({ ...manifest, dataFrom: '1.0.0' }),
    )
    expect(
      (await storeFiles(path.join(old, 'store', 'ted'))).some((f) => f.startsWith('state')),
    ).toBe(true)
    ted = await start('1.0.0')
    await ted.call('POST', '/tasks', { title: 'After the old backup' })

    const res = await ted.call('POST', '/backups/restore', { name: 'pre-update-20200101-090000' })

    expect(res.status).toBe(200)
    expect(((await ted.call('GET', '/tasks')).body as Task[]).map((t) => t.title)).toEqual([
      'In the old backup',
    ])
  })

  test('refuses a name that isn’t a backup', async () => {
    const ted = await start('1.0.0')

    for (const name of ['../store', 'daily-nope', '']) {
      const res = await ted.call('POST', '/backups/restore', { name })
      expect(res.status, name).toBe(404)
    }
  })

  test('is closed to Runs', async () => {
    await start('1.0.0')
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = api(daemon?.port ?? 0, runToken)

    expect((await asRun.call('GET', '/backups')).status).toBe(403)
    expect((await asRun.call('POST', '/backups/restore', { name: 'x' })).status).toBe(403)
    expect((await asRun.call('GET', '/data-status')).status).toBe(403)
  })
})

describe('daily backups', () => {
  test('the daemon takes today’s backup when it starts and reports a failure', async () => {
    await writeFile(path.join(home, 'backups'), 'not a folder')
    const ted = await start('1.0.0')

    const banners = (await ted.call('GET', '/banners')).body as Banner[]
    expect(banners).toMatchObject([
      {
        problem: 'daily-backup-failed',
        severity: 'warning',
        text: `Today’s backup failed: ${path.join(home, 'backups')} isn’t a folder`,
        action: { label: 'Open', opens: { kind: 'settings' } },
      },
    ])
    await stop()
    await rm(path.join(home, 'backups'))
    const later = await start('1.0.0')
    expect((await later.call('GET', '/banners')).body).toEqual([])
  })
})
