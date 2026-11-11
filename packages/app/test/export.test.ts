import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { startDaemon } from '../../daemon/src/index.ts'
import { api, makeOriginRepo } from '../../daemon/test/helpers.ts'
import { saveFactoryExport } from '../src/export.ts'

test('save flow uses a trusted suggested filename, cancels quietly, and writes the chosen snapshot', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-app-export-'))
  const daemon = await startDaemon({ home, version: 'test' })
  try {
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('No daemon info')
    const client = new DaemonClient(info, '', { appKey: daemon.appToken })
    const origin = await makeOriginRepo(home)
    const added = await api(daemon.port, { appKey: daemon.appToken }).call(
      'POST',
      '/dev/factories',
      { repo: origin, key: 'NB' },
    )
    expect(added.status).toBe(201)
    await client.createTask({ title: 'Keep this Task', factory: 'NB' })
    const [factory] = await client.listFactories()
    if (!factory) throw new Error('No Factory')
    const choose = vi.fn(async () => undefined)
    expect(await saveFactoryExport(client, factory.id, 'json', choose)).toEqual({ canceled: true })
    expect(choose).toHaveBeenCalledWith(
      expect.stringMatching(/^NB-\d{4}-\d{2}-\d{2}\.json$/),
      'json',
    )
    const destination = path.join(home, 'export.md')
    expect(
      await saveFactoryExport(client, factory.id, 'markdown', async () => destination),
    ).toEqual({ canceled: false, path: destination, tasks: 1 })
    expect(await readFile(destination, 'utf8')).toContain('Keep this Task')
    await expect(
      saveFactoryExport(client, factory.id, 'markdown', async () => destination),
    ).rejects.toThrow('already exists')
    await expect(saveFactoryExport(client, factory.id, 'invalid', choose)).rejects.toThrow(
      'format must',
    )
    await expect(saveFactoryExport(client, 'missing', 'json', choose)).rejects.toThrow(
      'no longer exists',
    )
    expect(choose).toHaveBeenCalledTimes(1)
  } finally {
    await daemon.stop()
    await rm(home, { recursive: true, force: true })
  }
})
