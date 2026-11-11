import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { commitToOrigin, waitUntil } from './helpers.ts'
import { createExecutionFixture } from './support/execution-fixture.ts'
import { observe } from './support/execution-observations.ts'

test('the process fixture carries copy, setup, stop and archive teardown through the local backend', async () => {
  const fixture = await createExecutionFixture()
  try {
    const machine = await fixture.machine('controller')
    const localFolder = path.join(machine.root, 'local')
    await mkdir(localFolder)
    await writeFile(path.join(localFolder, '.env'), 'fixture-copy\n')
    await commitToOrigin(machine.root, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, merge]',
        'repos:',
        '  - name: widgets',
        '    worktree:',
        '      copy: [".env"]',
        '      setup: "cat .env > stub-setup"',
        '      teardown: "cat stub-setup"',
        '',
      ].join('\n'),
    })
    const factory = await machine.client.addFactory({
      repo: machine.origin,
      key: 'LIF',
      localFolder,
    })
    const task = await machine.client.createTask({
      factory: factory.key,
      title: JSON.stringify({ steps: [{ run: ['cat', 'stub-setup'] }, { endTurn: true }] }),
    })
    await machine.client.startTask(task.id)
    const started = await waitUntil(
      async () => {
        const current = (await machine.client.listTasks()).find((t) => t.id === task.id)
        return current?.leadRunId ? current : undefined
      },
      'fixture lifecycle setup before Lead',
      30_000,
    )
    const repo = started.repos[0]
    if (!repo || !started.leadRunId) throw new Error('missing worktree or Lead')
    expect(repo.setup?.state).toBe('passed')
    expect(await readFile(path.join(repo.worktree, 'stub-setup'), 'utf8')).toBe('fixture-copy\n')
    await waitUntil(async () => (await machine.agentStarts()) === 1, 'one fixture agent start')
    const conversation = await waitUntil(async () => {
      const shown = await machine.client.getRun(started.leadRunId ?? '')
      return shown.conversation.some((c) => c.line.includes('fixture-copy'))
        ? shown.conversation
        : undefined
    }, 'Lead observes copied setup output')
    expect(conversation.length).toBeGreaterThan(0)
    await machine.client.stopTask(task.id)
    expect((await stat(repo.worktree)).isDirectory()).toBe(true)
    await machine.client.archiveTask(task.id, {})
    const archived = await waitUntil(
      async () => {
        const current = (await machine.client.listTasks()).find((t) => t.id === task.id)
        return current?.repos[0]?.removed ? current : undefined
      },
      'fixture lifecycle archive cleanup',
      30_000,
    )
    expect(archived.repos[0]?.removed?.teardown?.outcome).toBe('passed')
    expect(
      await readFile(
        path.join(machine.home, 'logs', 'worktrees', 'LIF-1-widgets-teardown.log'),
        'utf8',
      ),
    ).toContain('fixture-copy')
    await expect(stat(repo.worktree)).rejects.toThrow()
    const deleting = await machine.client.createTask({
      factory: factory.key,
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
    })
    await machine.client.startTask(deleting.id)
    const deletingRepo = await waitUntil(
      async () => {
        const current = (await machine.client.listTasks()).find((t) => t.id === deleting.id)
        return current?.leadRunId && current.repos[0]?.setup?.state === 'passed'
          ? current.repos[0]
          : undefined
      },
      'setup before deletion',
      30_000,
    )
    await machine.client.deleteTask(deleting.id)
    expect((await machine.client.listTasks()).some((t) => t.id === deleting.id)).toBe(false)
    await expect(stat(deletingRepo.worktree)).rejects.toThrow()
    await expect(stat(path.join(machine.home, 'sandbox', deleting.displayId))).rejects.toThrow()
    await observe('lifecycle-process', {
      copyBeforeSetupBeforeLead: true,
      stopRetainsWorktree: true,
      archiveTeardownBeforeRemoval: true,
      deleteRemovesWorktreeAndSandbox: true,
    })
  } finally {
    await fixture.close()
  }
}, 60_000)
