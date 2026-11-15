import { agentStageIds, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { openStore, type TedStore, tasksBuiltInProcess } from '../src/store/index.ts'
import { appClient, makeTempHome, stubClaudePath } from './helpers.ts'

const perFactory = 75
const doneTasks = 100
const backlogTasks = 20
const tasksAsking = 30
const runsPerDoneTask = 6
const messagesPerRun = 4
const commentsPerTask = 10
const automationTasks = 40

let home: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined
let seeded: Awaited<ReturnType<typeof seed>>

async function seed(store: TedStore, cwd: string) {
  const repos = (name: string) => [{ repo: `acme/${name}`, name, cloneUrl: `/x/${name}.git` }]
  const factories = ['NB', 'MS'].map((key) => {
    const factory = store.createFactory({
      key,
      name: key,
      repos: repos(key.toLowerCase()),
      defaultBranch: 'main',
    })
    store.factoryCloned(factory.id)
    return factory
  })
  const [notebook, site] = factories
  if (!notebook || !site) throw new Error('no Factories')
  const automation = store.automations.create(
    {
      factoryId: notebook.id,
      name: 'Nightly triage',
      prompt: '',
      schedule: { kind: 'daily', at: '09:00' },
      timeZone: 'UTC',
      agent: 'claude',
      on: false,
    },
    '2026-01-01T00:00:00.000Z',
  )

  const ids: string[] = []
  for (let i = 0; i < perFactory * factories.length; i++) {
    const factory: typeof notebook = i % 2 === 0 ? notebook : site
    let created: { automationId: string; firingId: string } | undefined
    if (factory === notebook && ids.length < automationTasks * 2) {
      const firing = store.automations.fire({
        automationId: automation.id,
        trigger: 'scheduled',
        at: '2026-01-01T09:00:00.000Z',
      })
      store.automations.began(firing.id)
      store.automations.ended(firing.id, { outcome: 'finished' })
      created = { automationId: automation.id, firingId: firing.id }
    }
    const task = await store.createTask({
      title: `Task ${i + 1}`,
      factoryId: factory.id,
      ...(created && { automation: created }),
    })
    ids.push(task.id)
  }

  const done = ids.slice(0, doneTasks)
  const asking = ids.slice(doneTasks, doneTasks + tasksAsking)
  for (const id of done) {
    for (const stage of agentStageIds) store.changeStage(id, stage)
    for (let r = 0; r < runsPerDoneTask; r++) {
      const run = store.startRun({
        id: `${id}-run-${r}`,
        agent: 'claude',
        prompt: '',
        cwd,
        taskId: id,
      })
      for (let m = 0; m < messagesPerRun; m++) {
        store.recordRunMessage({ runId: run.id, text: `Message ${m}`, lead: true })
      }
      store.recordRunOutput(run.id, {
        toOffset: 0,
        state: 'finished',
        ending: { how: 'exited', errorLines: [], at: new Date().toISOString() },
      })
    }
    store.changeStage(id, 'done')
  }
  for (const id of asking) {
    store.changeStage(id, 'intake')
    store.changeStage(id, 'clarify')
  }
  for (const id of ids) {
    const notes = asking.includes(id) ? commentsPerTask - 1 : commentsPerTask
    for (let c = 0; c < notes; c++) {
      store.postComment({ taskId: id, body: `Note ${c}`, author: { kind: 'ted' } })
    }
    if (asking.includes(id)) {
      store.postComment({
        taskId: id,
        body: 'Which page?',
        author: { kind: 'ted' },
        kind: 'question',
      })
    }
  }
  await store.persisted()
  return {
    ids,
    done,
    automationId: automation.id,
    displayId: store.getTask(done[49] ?? '')?.displayId,
  }
}

beforeAll(async () => {
  ;({ home, cleanup } = await makeTempHome())
  const started = performance.now()
  const store = await openStore({ directory: tedPaths(home).store })
  try {
    seeded = await seed(store, home)
  } finally {
    await store.close()
  }
  console.log(`seeded a large home in ${Math.round(performance.now() - started)} ms`)
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
}, 120_000)

afterAll(async () => {
  await daemon?.stop()
  await cleanup()
})

async function quiet(): Promise<void> {
  const deadline = Date.now() + 30_000
  let last = tasksBuiltInProcess()
  let stillSince = Date.now()
  while (Date.now() - stillSince < 500) {
    if (Date.now() > deadline) throw new Error('the daemon kept building Tasks with nothing to do')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const now = tasksBuiltInProcess()
    if (now !== last) {
      last = now
      stillSince = Date.now()
    }
  }
}

async function built<T>(
  name: string,
  read: () => Promise<T>,
): Promise<{ count: number; value: T }> {
  await quiet()
  const before = tasksBuiltInProcess()
  const started = performance.now()
  const value = await read()
  const ms = Math.round(performance.now() - started)
  await quiet()
  const count = tasksBuiltInProcess() - before
  console.log(`${name}: built ${count} Tasks, answered in ${ms} ms`)
  return { count, value }
}

test('hot reads on a large home build only the Tasks they need', async () => {
  if (!daemon) throw new Error('no daemon')
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  const client = appClient(info, daemon.appToken)
  const total = seeded.ids.length
  const doneTask = seeded.done[49] ?? ''

  const all = await built('GET /tasks', () => client.listTasks())
  expect(all.value).toHaveLength(total)
  expect(
    all.count,
    'GET /tasks returns every Task, so it builds every Task. That is intended; don’t lower this.',
  ).toBe(total)

  const checks: { name: string; ceiling: number; why: string; read: () => Promise<unknown> }[] = [
    {
      name: 'GET /slots (slot counting)',
      ceiling: 0,
      why: 'it builds only Tasks that hold or wait for a slot, and none do',
      read: () => client.getSlots(),
    },
    {
      name: 'getTask by display ID (GET /tasks/<display ID>/runs)',
      ceiling: 1,
      why: 'it needs the one Task',
      read: async () => {
        expect(await client.listTaskRuns(seeded.displayId ?? '')).toHaveLength(runsPerDoneTask)
      },
    },
    {
      name: 'getTask by Task ID and one Task’s Runs list (GET /tasks/<id>/runs)',
      ceiling: 1,
      why: 'it needs the one Task',
      read: async () => {
        expect(await client.listTaskRuns(doneTask)).toHaveLength(runsPerDoneTask)
      },
    },
    {
      name: 'the Automations list (GET /automations)',
      ceiling: automationTasks,
      why: 'it needs at most the Tasks its one Automation created',
      read: () => client.listAutomations(),
    },
    {
      name: 'one Automation’s detail (GET /automations/<id>)',
      ceiling: automationTasks,
      why: 'it needs at most the Tasks that Automation created',
      read: async () => {
        expect((await client.getAutomation(seeded.automationId)).history).toHaveLength(
          automationTasks,
        )
      },
    },
    {
      name: 'the Inbox waiting count (GET /inbox/waiting)',
      ceiling: tasksAsking,
      why: 'it needs at most the Tasks with an open request',
      read: async () => {
        expect(await client.listWaiting()).toHaveLength(tasksAsking)
      },
    },
    {
      name: 'the Inbox list (GET /inbox)',
      ceiling: tasksAsking,
      why: 'it needs at most the Tasks with an open request',
      read: () => client.listInbox(),
    },
    {
      name: 'a settings change and the queue pump it wakes (PATCH /settings)',
      ceiling: backlogTasks + tasksAsking,
      why: 'the pump looks at each Backlog Task once, and Autopilot at each Task with an open request',
      read: () => client.updateSettings({ textSize: 110 }),
    },
  ]
  for (const { name, ceiling, why, read } of checks) {
    const { count } = await built(name, read)
    expect
      .soft(count, `${name} built ${count} Tasks, more than the ${ceiling} it needs: ${why}`)
      .toBeLessThanOrEqual(ceiling)
  }
}, 120_000)
