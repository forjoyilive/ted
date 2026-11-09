import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { agentStageIds, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { search } from '../src/search.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { appClient, killRunHosts, makeOriginRepo, makeTempHome, stubClaudePath } from './helpers.ts'

const repo = (name: string) => [{ repo: `acme/${name}`, name, cloneUrl: `/x/${name}.git` }]
const entry = { layers: [], order: agentStageIds.map((stage) => ({ stage, enabled: true })) }

describe('search over the store', () => {
  let dir: string
  let store: TedStore

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ted-search-'))
    store = await openStore({ directory: dir })
  })

  afterEach(async () => {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function twoFactories() {
    const notebook = store.createFactory({
      key: 'NB',
      name: 'Notebook',
      repos: repo('notebook'),
      defaultBranch: 'main',
      showTutorial: false,
    })
    const site = store.createFactory({
      key: 'MS',
      name: 'Marketing site',
      repos: repo('site'),
      defaultBranch: 'main',
      showTutorial: false,
    })
    return { notebook, site }
  }

  test('an exact ID puts that Task first, across Factories', async () => {
    const { notebook, site } = await twoFactories()
    const nb = await store.createTask({ title: 'Mentions MS-1 in passing', factoryId: notebook.id })
    const ms = await store.createTask({ title: 'Sync blog posts', factoryId: site.id })

    const results = search(store, { query: 'ms-1', factoryId: notebook.id })

    expect(results.tasks.map((t) => t.displayId)).toEqual([ms.displayId, nb.displayId])
    expect(results.tasks[0]).toMatchObject({ field: 'id', state: 'open', factoryId: site.id })
  })

  test('finds words in title, every description version, and the brief, ignoring accents', async () => {
    const { notebook } = await twoFactories()
    const original = await store.createTask({
      title: 'Search improvements',
      description: 'Search ignores accents in note titles',
      factoryId: notebook.id,
    })
    store.editTask(original.id, { description: 'Search should fold diacritics' })
    const briefed = await store.createTask({ title: 'Offline editing', factoryId: notebook.id })
    store.writeBrief({ taskId: briefed.id, text: 'Needs a sync rule for accénts before Design.' })
    await store.createTask({ title: 'Unrelated', factoryId: notebook.id })

    const results = search(store, { query: 'accents' })

    expect(results.tasks.map((t) => [t.displayId, t.field])).toEqual([
      [original.displayId, 'original-request'],
      [briefed.displayId, 'brief'],
    ])
    expect(results.tasks[1]?.snippet).toContain('accénts')
  })

  test('finds Comment text from humans, agents and TED, with the Task named', async () => {
    const { notebook } = await twoFactories()
    const task = await store.createTask({ title: 'Offline editing', factoryId: notebook.id })
    store.postComment({
      taskId: task.id,
      body: 'Please keep a local cache',
      author: { kind: 'human' },
    })
    store.postComment({ taskId: task.id, body: 'TED paused: cache full', author: { kind: 'ted' } })
    store.postComment({ taskId: task.id, body: 'Nothing here', author: { kind: 'ted' } })

    const results = search(store, { query: 'CACHE' })

    expect(results.tasks).toEqual([])
    expect(results.comments.map((c) => [c.author.kind, c.snippet, c.displayId])).toEqual([
      ['ted', 'TED paused: cache full', task.displayId],
      ['human', 'Please keep a local cache', task.displayId],
    ])
    expect(results.comments[0]?.taskTitle).toBe('Offline editing')
  })

  test('Done and archived Tasks are labelled and ranked below open ones; current Factory first', async () => {
    const { notebook, site } = await twoFactories()
    const archived = await store.createTask({ title: 'Sync blog posts', factoryId: notebook.id })
    store.archiveTask(archived.id)
    const done = await store.createTask({ title: 'Sync conflict toast', factoryId: notebook.id })
    store.changeStage(done.id, 'done', entry)
    const elsewhere = await store.createTask({ title: 'Sync newsletter', factoryId: site.id })
    const here = await store.createTask({ title: 'Sync notes', factoryId: notebook.id })

    const results = search(store, { query: 'sync', factoryId: notebook.id })

    expect(results.tasks.map((t) => [t.displayId, t.state])).toEqual([
      [here.displayId, 'open'],
      [elsewhere.displayId, 'open'],
      [done.displayId, 'done'],
      [archived.displayId, 'archived'],
    ])
  })

  test('finds Factories by name and returns nothing for an empty query', async () => {
    const { site } = await twoFactories()
    await store.createTask({ title: 'Marketing copy', factoryId: site.id })

    expect(search(store, { query: 'market' }).factories).toEqual([
      { factoryId: site.id, name: 'Marketing site' },
    ])
    expect(search(store, { query: '   ' })).toEqual({
      query: '   ',
      tasks: [],
      comments: [],
      factories: [],
    })
  })
})

describe('GET /search', () => {
  let home: string
  let cleanup: () => Promise<void>
  let scratch: string
  let daemon: RunningDaemon | undefined

  beforeEach(async () => {
    ;({ home, cleanup } = await makeTempHome())
    scratch = await mkdtemp(path.join(tmpdir(), 'ted-search-'))
  })

  afterEach(async () => {
    await daemon?.stop()
    daemon = undefined
    await killRunHosts(home)
    await cleanup()
    await rm(scratch, { recursive: true, force: true })
  })

  test('the app searches through the client; the query and current Factory pass through', async () => {
    const origin = await makeOriginRepo(scratch)
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    const client = appClient(info, daemon.appToken)
    const factory = await client.addFactory({ repo: origin, key: 'NB' })
    const task = await client.createTask({
      title: 'Search ignores accents',
      description: 'Typing é should find e',
      factory: factory.key,
    })

    const results = await client.search('NB-1 accents', factory.id)
    expect(results.tasks.map((t) => t.taskId)).toEqual([task.id])
    expect((await client.search('nb-1')).tasks[0]).toMatchObject({ taskId: task.id, field: 'id' })
  })
})
