import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { executionIds } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createBanners } from '../src/banners.ts'
import { createSandbox } from '../src/sandbox.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { createTaskExecution } from '../src/tasks/execution.ts'
import { createLocalLifecycle } from '../src/tasks/local-lifecycle.ts'
import { makeOriginRepo } from './helpers.ts'
import { observe } from './support/execution-observations.ts'

let home: string
let store: TedStore
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-lifecycle-'))
  store = await openStore({ directory: path.join(home, 'store') })
  await mkdir(path.join(home, 'worktrees'), { recursive: true })
})
afterEach(async () => {
  await store.close()
  await rm(home, { recursive: true, force: true })
})

function backend(program?: string) {
  return createLocalLifecycle({
    store,
    banners: createBanners({ store }),
    reposDir: path.join(home, 'repos'),
    worktreesDir: path.join(home, 'worktrees'),
    logsDir: path.join(home, 'logs'),
    sandbox: createSandbox({ tedHome: home, env: () => process.env, ...(program && { program }) }),
    env: () => process.env,
  })
}

test('worktree handles survive adapter reconstruction and reject foreign or unknown references', async () => {
  const task = await store.createTask({ title: 'Bound handles' })
  const ref = await createTaskExecution(store).local(task.id)
  let local = backend()
  const handle = local.worktree(ref, { name: 'widgets', repo: 'acme/widgets' })
  expect(handle).not.toHaveProperty('path')
  expect(handle).not.toHaveProperty('worktree')
  store.startTask({
    taskId: task.id,
    stage: 'work',
    branch: 'ted/handles',
    worktree: path.join(home, 'worktrees', task.displayId, 'widgets'),
    entry: { layers: [], order: [{ stage: 'work', enabled: true }] },
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  await store.persisted()
  await store.close()
  store = await openStore({ directory: path.join(home, 'store') })
  local = backend()
  expect(backend().worktree(ref, { name: 'widgets', repo: 'acme/widgets' })).toEqual(handle)
  expect(backend().localPath(handle)).toBe(path.join(home, 'worktrees', task.displayId, 'widgets'))
  expect(() => local.localPath({ ...handle, generation: 2 })).toThrow()
  expect(() => local.localPath({ ...handle, machineId: executionIds.machine('foreign') })).toThrow()
  expect(() => local.localPath({ ...handle, id: executionIds.handle('unknown') })).toThrow()
  const other = await store.createTask({ title: 'Other Task' })
  const otherRef = await createTaskExecution(store).local(other.id)
  expect(() => local.localPath({ ...handle, ...otherRef })).toThrow()
  expect(() => local.worktree(ref, { name: '../escape', repo: 'acme/widgets' })).toThrow()
})

test('local clone, create, copy and removal use handles and refuse a linked Task folder', async () => {
  const origin = await makeOriginRepo(path.join(home, 'source'))
  const factory = store.addFactory({
    key: 'LC',
    name: 'widgets',
    repo: 'acme/widgets',
    cloneUrl: origin,
    defaultBranch: 'main',
  })
  const task = await store.createTask({ title: 'Lifecycle', factoryId: factory.id })
  const ref = await createTaskExecution(store).local(task.id)
  const entry = {
    name: 'widgets',
    repo: factory.repo,
    cloneUrl: origin,
    primary: true,
    env: {},
    copy: ['.env', '../outside'],
  }
  const folder = path.join(home, 'local')
  await mkdir(folder)
  await writeFile(path.join(folder, '.env'), 'LOCAL=present\n')
  store.setLocalFolder(factory.repo, folder)
  const local = backend(path.join(home, 'no-sandbox'))
  const clone = await local.prepare(ref, factory, entry)
  expect(clone.kind).toBe('clone')
  await expect(
    local.create({ ...clone, generation: 2 }, entry, 'ted/refused', true),
  ).rejects.toThrow()
  await expect(
    local.create({ ...clone, id: executionIds.handle('unknown') }, entry, 'ted/refused', true),
  ).rejects.toThrow()
  const made = await local.create(clone, entry, 'ted/lifecycle', true)
  expect(made.copied).toEqual(['.env'])
  expect(made.skipped).toContainEqual({ path: '../outside', reason: 'outside' })
  const file = local.localPath(made.handle)
  expect(await readFile(path.join(file, '.env'), 'utf8')).toBe('LOCAL=present\n')
  const refused = await local.command(made.handle, {
    kind: 'setup',
    command: { run: 'touch stub-refused', timeoutMs: 5000 },
    env: {},
  })
  expect(refused.outcome).toBe('failed')
  expect(refused.problem).toContain('TED didn’t run setup:')
  await expect(readFile(path.join(file, 'stub-refused'))).rejects.toThrow()
  expect(store.listBanners().some((b) => b.problem === 'sandbox-unavailable')).toBe(true)
  await local.remove(made.handle)
  await expect(readFile(path.join(file, '.env'))).rejects.toThrow()
  const taskFolder = path.join(home, 'worktrees', task.displayId)
  await rm(taskFolder, { recursive: true })
  await symlink(folder, taskFolder)
  await expect(local.create(clone, entry, 'ted/escape', true)).rejects.toThrow('plain')
  await expect(readFile(path.join(folder, 'widgets', '.env'))).rejects.toThrow()
  await observe('lifecycle-handles', {
    opaque: true,
    assignmentBound: true,
    restartBindings: true,
    copyAndContainment: true,
    missingSandboxRefused: true,
  })
})

test('final cleanup refuses a linked sandbox root and leaves the sibling folder intact', async () => {
  const task = await store.createTask({ title: 'Confined cleanup' })
  const ref = await createTaskExecution(store).local(task.id)
  await rm(path.join(home, 'worktrees'), { recursive: true })
  await backend().cleanFolders(ref)
  const sibling = path.join(home, 'sibling')
  const victim = path.join(sibling, task.displayId, 'keep')
  await mkdir(path.dirname(victim), { recursive: true })
  await writeFile(victim, 'untouched')
  await symlink(sibling, path.join(home, 'sandbox'))
  await expect(backend().cleanFolders(ref)).rejects.toThrow('plain')
  expect(await readFile(victim, 'utf8')).toBe('untouched')
})
