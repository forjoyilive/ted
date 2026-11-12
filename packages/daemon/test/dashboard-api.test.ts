import { DaemonClient, readDaemonInfo, tedPaths } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { openStore } from '../src/store/index.ts'
import { makeTempHome, rawRequest } from './helpers.ts'

test('read-only Dashboard request uses durable Factory history and validates its range', async () => {
  const { home, cleanup } = await makeTempHome()
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  const store = await openStore({ directory: tedPaths(home).store })
  const now = Date.now()
  let factoryId = ''
  let taskId = ''
  try {
    vi.useFakeTimers({ toFake: ['Date'] })
    const factory = store.createFactory({
      key: 'NB',
      name: 'Widgets',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    factoryId = factory.id
    vi.setSystemTime(now - 36_000_000)
    const task = await store.createTask({ factoryId, title: 'Completed across two repos' })
    taskId = task.id
    store.worktreeCreated(task.id, {
      name: 'a',
      repo: 'acme/a',
      branch: 'task',
      worktree: home,
      copied: [],
      skipped: [],
    })
    store.worktreeCreated(task.id, {
      name: 'b',
      repo: 'acme/b',
      branch: 'task',
      worktree: home,
      copied: [],
      skipped: [],
    })
    vi.setSystemTime(now - 18_000_000)
    store.changeStage(task.id, 'intake', { layers: [], order: [] })
    vi.setSystemTime(now - 3_600_000)
    store.changeStage(task.id, 'done', { layers: [], order: [] })
    store.archiveTask(task.id)
    const other = store.createFactory({
      key: 'ZZ',
      name: 'Other',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    const excluded = await store.createTask({ factoryId: other.id, title: 'Other Factory' })
    store.changeStage(excluded.id, 'done', { layers: [], order: [] })
    await store.persisted()
  } finally {
    vi.useRealTimers()
    await store.close()
  }
  try {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('missing daemon info')
    const client = new DaemonClient(info)
    const result = await client.factoryDashboard(factoryId, '7d')
    expect(result.current.taskIds).toEqual([taskId])
    expect(result.current.created.value).toBe(32_400_000)
    expect(result.current.intake.value).toBe(14_400_000)
    expect(result.tasks).toMatchObject([{ id: taskId, archived: true }])
    expect(await client.factoryDashboard(factoryId, 'all')).toMatchObject({
      previous: null,
      comparison: null,
    })
    const request = (path: string, token = info.token) =>
      rawRequest(daemon?.port ?? 0, { path, headers: { authorization: `Bearer ${token}` } })
    expect((await request(`/factories/${factoryId}/dashboard?range=bad`)).status).toBe(400)
    expect((await request('/factories/missing/dashboard?range=7d')).status).toBe(404)
    expect((await request(`/factories/${factoryId}/dashboard?range=7d`, 'wrong')).status).toBe(401)
  } finally {
    await daemon?.stop()
    await cleanup()
  }
})
