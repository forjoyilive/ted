import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { isAlive, waitUntil } from './helpers.ts'
import { createExecutionFixture } from './support/execution-fixture.ts'
import { observe } from './support/execution-observations.ts'

test('isolated processes, homes, ports and cleanup preserve a sibling', async () => {
  const lab = await createExecutionFixture()
  try {
    const a = await lab.machine('controller')
    const b = await lab.machine('executor')
    const pid = a.pid
    if (!pid) throw new Error('missing fixture pid')
    expect(a.pid).not.toBe(b.pid)
    expect(a.port).not.toBe(b.port)
    await a.client.updateSettings({ maxWorkingRuns: 1 })
    expect((await b.client.getSettings()).maxWorkingRuns).not.toBe(1)
    await writeFile(path.join(b.home, 'sentinel'), 'owned by sibling')
    await a.close()
    expect(isAlive(pid)).toBe(false)
    await expect(access(a.root)).rejects.toThrow()
    expect(await readFile(path.join(b.home, 'sentinel'), 'utf8')).toBe('owned by sibling')
    expect(await b.client.getSettings()).toBeDefined()
    await observe('isolation', { processes: 2, distinctPorts: true, siblingPreserved: true })
  } finally {
    await lab.close()
  }
  await expect(access(lab.root)).rejects.toThrow()
})

test('fixture-only sockets expose hold, drop, disconnect and reconnect barriers', async () => {
  const lab = await createExecutionFixture()
  try {
    const machine = await lab.machine('executor')
    const link = await machine.exchange()
    await machine.control({ acknowledgment: 'hold' })
    const held = link.send('held')
    await machine.barrier({ executed: 1, held: 1 })
    expect(link.received).toBe(0)
    await machine.control({ acknowledgment: 'release' })
    expect(await held).toBe('held')
    await machine.control({ acknowledgment: 'drop' })
    const dropped = link.send('dropped')
    const rejected = expect(dropped).rejects.toThrow('disconnected')
    await machine.barrier({ executed: 2, dropped: 1 })
    await link.disconnect()
    await rejected
    await link.connect()
    expect(await link.send('reconnected')).toBe('reconnected')
    expect(await machine.barrier({ executed: 3, acknowledged: 2 })).toMatchObject({
      executed: 3,
      acknowledged: 2,
      dropped: 1,
      held: 0,
    })
    expect(link.received).toBe(2)
    await observe('fault-controls', { executed: 3, acknowledged: 2, dropped: 1 })
  } finally {
    await lab.close()
  }
})

test('owned process kill/restart and timed-out barriers clean up', async () => {
  const lab = await createExecutionFixture()
  try {
    const machine = await lab.machine('executor')
    const pid = machine.pid
    await machine.kill()
    await machine.start()
    expect(machine.pid).not.toBe(pid)
    expect(await machine.client.getSettings()).toBeDefined()
    await expect(machine.barrier({ executed: 99 }, 50)).rejects.toThrow('timed out')
    await observe('process-restart', { exitedPid: pid, restarted: true, boundedTimeout: true })
  } finally {
    await lab.close()
  }
})

test('disk, load, agent readiness and capacity controls affect synthetic Tasks', async () => {
  const lab = await createExecutionFixture()
  try {
    const machine = await lab.machine('controller')
    const factory = await machine.client.addFactory({
      repo: machine.origin,
      key: 'FIX',
    })
    await machine.client.updateSettings({
      maxWorkingRuns: 1,
      adjustRunsToLoad: true,
      maxChecksAtOnce: 1,
    })
    const create = async () =>
      machine.client.createTask({
        factory: factory.key,
        title: JSON.stringify({
          steps: [{ waitFor: path.join(machine.root, 'release-agent') }, { endTurn: true }],
        }),
      })
    await machine.control({ freeBytes: 1e9 })
    await waitUntil(
      async () => (await machine.client.listBanners()).some((b) => b.problem === 'disk-full'),
      'disk hold',
    )
    const first = await create()
    await machine.client.startTask(first.id)
    expect(
      (await machine.client.listTasks()).find((t) => t.id === first.id)?.leadRunId,
    ).toBeUndefined()
    await machine.control({ online: false })
    await waitUntil(
      async () => (await machine.client.listBanners()).some((b) => b.problem === 'offline'),
      'offline hold',
    )
    await machine.control({ online: true })
    await waitUntil(
      async () => !(await machine.client.listBanners()).some((b) => b.problem === 'offline'),
      'online recovery',
    )
    await machine.control({ signedIn: false })
    await waitUntil(
      async () =>
        (await machine.client.listTasks()).find((t) => t.id === first.id)?.status?.kind ===
        'paused',
      'agent pause',
    )
    await machine.control({ freeBytes: 500e9, signedIn: true })
    await waitUntil(
      async () => (await machine.client.listTasks()).find((t) => t.id === first.id)?.leadRunId,
      'first Task start',
      30_000,
    )
    const second = await create()
    await machine.client.startTask(second.id)
    expect(await machine.client.getSlots()).toMatchObject({ limit: 1, working: 1, queued: 1 })
    await machine.control({ load: 99 })
    await machine.client.updateSettings({ maxWorkingRuns: 2 })
    await waitUntil(async () => (await machine.client.getSlots()).heldForLoad, 'load measured')
    await waitUntil(
      async () =>
        (await machine.client.listTasks()).find((t) => t.id === second.id)?.status?.kind ===
        'queued',
      'load hold',
    )
    expect(
      (await machine.client.listTasks()).find((t) => t.id === second.id)?.leadRunId,
    ).toBeUndefined()
    await machine.control({ load: 0 })
    await waitUntil(
      async () => (await machine.client.listTasks()).find((t) => t.id === second.id)?.leadRunId,
      'capacity released',
      30_000,
    )
    const counts = await waitUntil(
      async () => ((await machine.agentStarts()) === 2 ? 2 : undefined),
      'two agent start records',
    )
    expect(counts).toBe(2)
    await observe('machine-controls', {
      starts: counts,
      disk: true,
      load: true,
      readiness: true,
      online: true,
      capacity: true,
    })
  } finally {
    await lab.close()
  }
}, 90_000)

test('startup timeout removes only the failed machine resources', async () => {
  const fixture = await createExecutionFixture()
  try {
    await expect(fixture.machine('executor', 'daemon', 1)).rejects.toThrow('timed out')
    expect(await readdir(fixture.root)).toEqual([])
  } finally {
    await fixture.close()
  }
})
