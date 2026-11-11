import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readDaemonInfo, type Task } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openStore } from '../src/store/index.ts'
import {
  api,
  assistantTexts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  spawnDaemonProcess,
  stubClaudePath,
  testAppToken,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let child: ChildProcess | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-interval-recovery-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start() {
  await rm(path.join(home, 'daemon.json'), { force: true })
  child = spawnDaemonProcess([], { ...process.env, TED_HOME: home, TED_CLAUDE_BIN: stubClaudePath })
  const info = await waitUntil(() => readDaemonInfo(home), 'daemon.json')
  const client = api(info.port, { appKey: testAppToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await client.call(method, route, body)
    if (response.status >= 300)
      throw new Error(`${method} ${route}: ${JSON.stringify(response.body)}`)
    return response.body as T
  }
  return { ...client, ok }
}

async function shutdown(client: Awaited<ReturnType<typeof start>>) {
  await client.ok('POST', '/shutdown')
  if (child?.exitCode === null) await once(child, 'exit')
  child = undefined
}

test('a recovered live Task Run is reconciled after host catch-up while downtime stays unknown', async () => {
  let client = await start()
  await client.ok('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const release = path.join(scratch, 'release')
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [
        { say: 'before restart' },
        { waitFor: release },
        { say: 'after restart' },
        { waitFor: path.join(scratch, 'hold') },
      ],
    }),
    factory: 'NB',
    start: true,
  })
  const runId = await waitUntil(
    async () => (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.leadRunId,
    'the Task Lead Run',
  )
  await waitUntil(
    async () =>
      assistantTexts((await client.getRun(runId)).conversation).includes('before restart') ||
      undefined,
    'output before restart',
  )
  const killed = child
  killed?.kill('SIGKILL')
  if (killed) await once(killed, 'exit')
  child = undefined
  client = await start()
  await writeFile(release, '')
  await waitUntil(
    async () =>
      assistantTexts((await client.getRun(runId)).conversation).includes('after restart') ||
      undefined,
    'output after restart',
  )
  await shutdown(client)
  const store = await openStore({ directory: path.join(home, 'store') })
  try {
    const history = store.taskIntervalHistory(task.id)
    expect(history.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'run-working', state: 'unknown', source: 'daemon-gap' }),
      ]),
    )
    expect(
      history.intervals.flatMap((i) => (i.reason === 'run-working' ? i.contributors : [])),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: runId, startSource: 'v1.RunStateObserved' }),
      ]),
    )
  } finally {
    await store.close()
  }
})
