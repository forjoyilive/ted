import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { agentStageIds, type RunChat, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { searchConversations } from '../src/conversation-search.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { search } from '../src/search.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import {
  appClient,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

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
    })
    const site = store.createFactory({
      key: 'MS',
      name: 'Marketing site',
      repos: repo('site'),
      defaultBranch: 'main',
    })
    store.factoryCloned(notebook.id)
    store.factoryCloned(site.id)
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
    const tasks = store.listTasks()
    const builds = store.taskBuilds()
    expect(search(store, { query: 'CACHE' }, tasks)).toEqual(results)
    expect(store.taskBuilds()).toBe(builds)

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
      conversations: [],
      tasks: [],
      comments: [],
      factories: [],
      plans: [],
      automations: [],
    })
  })

  test('Conversation search covers reachable owners and historical Runs, caps results and excludes generated text', async () => {
    const { notebook, site } = await twoFactories()
    const task = await store.createTask({ title: 'Old task', factoryId: notebook.id })
    store.archiveTask(task.id)
    const old = store.startRun({
      id: 'old',
      agent: 'claude',
      prompt: '',
      cwd: dir,
      taskId: task.id,
    })
    const sub = store.startRun({
      id: 'sub',
      agent: 'codex',
      prompt: '',
      cwd: dir,
      taskId: task.id,
      parentRunId: old.id,
      name: 'Reviewer',
    })
    const plan = store.plans.start({
      factoryId: site.id,
      title: 'A plan',
      message: '',
      agent: 'claude',
    })
    store.startRun({ id: plan.id, agent: 'claude', prompt: '', cwd: dir })
    const automation = store.automations.create(
      {
        factoryId: notebook.id,
        name: 'Scheduled check',
        prompt: '',
        schedule: { kind: 'daily', at: '09:00' },
        timeZone: 'UTC',
        agent: 'claude',
        on: false,
      },
      '2026-01-01',
    )
    const firing = store.automations.fire({
      automationId: automation.id,
      trigger: 'scheduled',
      at: '2026-01-01',
    })
    store.startRun({ id: firing.id, agent: 'claude', prompt: '', cwd: dir })
    store.startRun({ id: 'coordinator', agent: 'claude', prompt: '', cwd: dir })
    store.coordinators.save({
      factoryId: notebook.id,
      runId: 'coordinator',
      runIds: ['coordinator'],
      lead: { agent: 'claude' },
      phase: 'ready',
      opening: '',
      receipts: [],
      taskIds: [],
    })
    store.startRun({ id: 'unowned', agent: 'claude', prompt: '', cwd: dir })
    const gone = await store.createTask({ title: 'Deleted', factoryId: notebook.id })
    store.startRun({ id: 'gone', agent: 'claude', prompt: '', cwd: dir, taskId: gone.id })
    store.deleteTask(gone.id)
    const read: string[] = []
    const conversations = {
      chat: async (runId: string): Promise<RunChat> => {
        read.push(runId)
        return {
          run: {
            id: runId,
            name: runId,
            role: 'run',
            agent: 'claude',
            state: 'finished',
            current: false,
            startedAt: '2026-01-01',
          },
          items: [
            { kind: 'instructions', id: 'instructions', text: 'generatedneedle', lines: 1 },
            { kind: 'prompt', id: 'prompt', text: 'generatedneedle', lines: 1 },
            { kind: 'ted', id: 'ted', text: 'generatedneedle', title: 'generated' },
            ...[1, 2, 3].map((n) => ({
              kind: 'agent' as const,
              id: `a${n}`,
              text: 'A café match',
              at: `2026-01-0${n}`,
            })),
          ],
        }
      },
    }
    expect(await searchConversations(store, conversations, { query: '  ' })).toEqual([])
    expect(read).toEqual([])
    const found = await searchConversations(store, conversations, {
      query: 'cafe MATCH',
      factoryId: notebook.id,
    })
    expect(found).toHaveLength(10)
    expect(new Set(found.map((hit) => hit.source))).toEqual(
      new Set(['task', 'plan', 'automation', 'coordinator']),
    )
    expect(found.filter((hit) => hit.runId === old.id).map((hit) => hit.itemId)).toEqual([
      'a3',
      'a2',
    ])
    expect(found.some((hit) => hit.runId === sub.id)).toBe(true)
    expect(found.slice(0, 8).every((hit) => hit.factoryId === notebook.id)).toBe(true)
    expect(read).not.toContain('unowned')
    expect(read).not.toContain('gone')
    expect(await searchConversations(store, conversations, { query: 'generatedneedle' })).toEqual(
      [],
    )
  })

  test('finds planning chats by title, open ones first, then this Factory’s, newest first', async () => {
    const { notebook, site } = await twoFactories()
    const chat = (factoryId: string, title: string) =>
      store.plans.start({ factoryId, title, message: 'Plan it', agent: 'claude' })
    const old = chat(site.id, 'Offline editing, first try')
    store.plans.ended(old.id, { outcome: 'finished' })
    const there = chat(notebook.id, 'Offline sync')
    const here = chat(site.id, 'Offline mode')
    chat(site.id, 'Unrelated plan')

    expect(search(store, { query: 'offline', factoryId: site.id }).plans).toEqual([
      { planId: here.id, factoryId: site.id, title: 'Offline mode', ended: false },
      { planId: there.id, factoryId: notebook.id, title: 'Offline sync', ended: false },
      { planId: old.id, factoryId: site.id, title: 'Offline editing, first try', ended: true },
    ])
  })

  test('finds Automations by name, this Factory’s first and those that are on before off', async () => {
    const { notebook, site } = await twoFactories()
    const automation = (factoryId: string, on: boolean) =>
      store.automations.create(
        {
          factoryId,
          name: 'Sentry crash intake',
          prompt: 'Look',
          schedule: { kind: 'daily', at: '09:00' },
          timeZone: 'UTC',
          agent: 'claude',
          on,
        },
        new Date().toISOString(),
      )
    const off = automation(notebook.id, false)
    const here = automation(site.id, true)

    expect(search(store, { query: 'sentry', factoryId: site.id }).automations).toEqual([
      { automationId: here.id, factoryId: site.id, name: 'Sentry crash intake', on: true },
      { automationId: off.id, factoryId: notebook.id, name: 'Sentry crash intake', on: false },
    ])
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

  test.each(['claude', 'codex'] as const)(
    'finds %s Conversation messages through the HTTP API',
    async (agent) => {
      const origin = await makeOriginRepo(scratch)
      await commitToOrigin(scratch, {
        '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
      })
      daemon = await startDaemon({
        home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
      })
      const info = await readDaemonInfo(home)
      if (!info) throw new Error('no daemon.json')
      const client = appClient(info, daemon.appToken)
      const factory = await client.addFactory({ repo: origin, key: 'NB' })
      const toolSteps =
        agent === 'claude'
          ? [
              {
                emit: {
                  type: 'assistant',
                  message: {
                    role: 'assistant',
                    content: [
                      {
                        type: 'tool_use',
                        id: 'search-tool',
                        name: 'Bash',
                        input: { command: 'inputneedle', description: 'Inspect' },
                      },
                    ],
                  },
                },
              },
              {
                emit: {
                  type: 'user',
                  message: {
                    role: 'user',
                    content: [
                      { type: 'tool_result', tool_use_id: 'search-tool', content: 'outputneedle' },
                    ],
                  },
                },
              },
            ]
          : [
              {
                notify: 'item/completed',
                params: {
                  item: {
                    type: 'commandExecution',
                    id: 'search-tool',
                    command: 'inputneedle',
                    aggregatedOutput: 'outputneedle',
                    exitCode: 0,
                  },
                },
              },
            ]
      const task = await client.createTask({
        title: JSON.stringify({
          steps: [...toolSteps, { say: 'uniquematch café' }, { endTurn: true }],
        }),
        factory: factory.key,
      })
      await client.setTaskLead(task.id, { agent })
      await client.startTask(task.id)
      const hit = await waitUntil(
        async () => (await client.search('uniquematch cafe')).conversations?.[0],
        'the Conversation match',
      )
      expect(hit).toMatchObject({
        factoryId: factory.id,
        source: 'task',
        ref: task.displayId,
        kind: 'agent',
        snippet: 'uniquematch café',
      })
      const chat = await client.getRunChat(hit.runId)
      expect(chat.items.find((item) => item.id === hit.itemId)).toMatchObject({
        kind: 'agent',
        text: 'uniquematch café',
      })
      await client.sendRunMessage(hit.runId, 'humanonlyneedle')
      expect((await client.search('humanonlyneedle')).conversations[0]).toMatchObject({
        kind: 'human',
        runId: hit.runId,
      })
      expect((await client.search('inputneedle')).conversations[0]).toMatchObject({
        kind: 'tool',
        runId: hit.runId,
      })
      expect((await client.search('outputneedle')).conversations[0]).toMatchObject({
        kind: 'tool',
        runId: hit.runId,
      })
      expect((await client.search('Working in TED')).conversations).toEqual([])
      await client.stopTask(task.id)
      const logPath = path.join(home, 'runs', hit.runId, 'host.log')
      const log = await readFile(logPath, 'utf8')
      const lines = log.trimEnd().split('\n')
      const lastMessage = lines.findLastIndex((line) => {
        const record = JSON.parse(line) as { t: string; line?: string }
        return record.t === 'out' && record.line?.includes('uniquematch café')
      })
      expect(lastMessage).toBeGreaterThan(0)
      await writeFile(logPath, `${lines.slice(lastMessage).join('\n')}\n`)
      expect((await client.search('uniquematch')).conversations[0]).toMatchObject({
        runId: hit.runId,
        kind: 'agent',
      })
      await unlink(logPath)
      expect((await client.search('uniquematch')).conversations).toEqual([])
      expect((await client.search('humanonlyneedle')).conversations[0]?.kind).toBe('human')
    },
  )

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
    const token = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const response = await rawRequest(daemon.port, {
      method: 'GET',
      path: '/search?q=accents',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(403)
  })
})
