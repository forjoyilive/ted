import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  type Comment,
  DaemonClient,
  type PeerMessage,
  type PeerPage,
  readDaemonInfo,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let scratch: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-peer-http-'))
})
afterEach(async () => {
  await daemon?.stop()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})
async function setup() {
  const origin = await makeOriginRepo(scratch)
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const app = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await app.call(method, route, body)
    if (response.status >= 300) throw new Error(`${route}: ${JSON.stringify(response)}`)
    return response.body as T
  }
  await ok('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  async function start(name: string) {
    const task = await ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: JSON.stringify({
        steps: [{ say: name }, { waitFor: path.join(scratch, name) }, { endTurn: true }],
      }),
    })
    await ok('POST', `/tasks/${task.id}/start`)
    const current = await waitUntil(async () => {
      const tasks = await ok<Task[]>('GET', '/tasks')
      return tasks.find((t) => t.id === task.id && t.leadRunId !== undefined)
    }, 'Task Lead to start')
    const runId = current.leadRunId
    if (!runId) throw new Error('Lead missing')
    const token = tokens.issue(runId)
    return { task: current, runId, token, run: api(daemon?.port ?? 0, token) }
  }
  const sender = await start('sender')
  const recipient = await start('recipient')
  return { ok, app, sender, recipient }
}

test('Run routes and CLI expose peers; explicit messages deliver only at a working Lead boundary', async () => {
  const { ok, app, sender, recipient } = await setup()
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('daemon info missing')
  const client = new DaemonClient({ ...info, token: sender.token })
  expect((await client.peers()).tasks.map((t) => t.id)).toContain(recipient.task.id)
  expect((await client.peer(recipient.task.id)).task.id).toBe(recipient.task.id)
  const page = await client.peers()
  expect((await client.watchPeers(page.cursor, 0)).cursor).toBe(page.cursor)
  const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
  const cli = (args: string[]) =>
    promisify(execFile)(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        TED_HOME: home,
        TED_RUN_CAPABILITY: sender.token,
        TED_RUN: sender.runId,
        TED_TASK: sender.task.displayId,
      },
    })
  const listed: PeerPage = JSON.parse((await cli(['peers'])).stdout)
  expect(listed.tasks.map((t) => t.id)).toContain(recipient.task.id)
  const sent: PeerMessage = JSON.parse(
    (
      await cli([
        'peers',
        'send',
        recipient.task.displayId,
        '--operation',
        'cli-message',
        'Please coordinate the protocol changes',
      ])
    ).stdout,
  )
  expect(sent.delivered).toBeUndefined()
  expect((await cli(['peers', 'show', recipient.task.displayId])).stdout).toContain(
    recipient.task.id,
  )
  expect(
    (await cli(['peers', 'watch', '--cursor', page.cursor, '--timeout', '0'])).stdout,
  ).toContain('cursor')
  await expect(cli(['peers', 'watch', '--timeout', '26'])).rejects.toThrow('timeout')
  const recipientClient = new DaemonClient({ ...info, token: recipient.token })
  expect((await recipientClient.peerInbox()).messages[0]?.id).toBe(sent.id)
  expect((await recipient.run.call('POST', `/runs/${recipient.runId}/boundary`)).status).toBe(200)
  expect((await recipientClient.peerInbox()).messages[0]?.delivered?.runId).toBe(recipient.runId)
  const notes = await ok<Comment[]>('GET', `/tasks/${recipient.task.id}/comments`)
  expect(notes.filter((c) => c.id === sent.id)).toHaveLength(1)
  expect(notes.find((c) => c.id === sent.id)?.author).toEqual({ kind: 'run', runId: sender.runId })
  expect((await app.call('GET', '/peers')).status).toBe(403)
})

test('messages to stopped Tasks survive sender deletion and deliver once on normal resume', async () => {
  const { ok, sender, recipient } = await setup()
  await ok('POST', `/tasks/${recipient.task.id}/stop`)
  const before = await ok<unknown[]>('GET', `/tasks/${recipient.task.id}/runs`)
  const response = await sender.run.call('POST', `/peers/tasks/${recipient.task.id}/messages`, {
    operation: 'stopped',
    text: 'Coordinate after you resume.',
  })
  expect(response.status).toBe(201)
  const sent = response.body as PeerMessage
  expect(
    (await ok<Comment[]>('GET', `/tasks/${recipient.task.id}/comments`)).find(
      (c) => c.id === sent.id,
    )?.delivered,
  ).toBeUndefined()
  expect((await ok<unknown[]>('GET', `/tasks/${recipient.task.id}/runs`)).length).toBe(
    before.length,
  )
  await ok('POST', `/tasks/${sender.task.id}/delete`, {})
  await writeFile(path.join(scratch, 'recipient'), '')
  await ok('POST', `/tasks/${recipient.task.id}/resume`, {})
  await waitUntil(
    async () =>
      (await ok<Comment[]>('GET', `/tasks/${recipient.task.id}/comments`)).find(
        (c) => c.id === sent.id,
      )?.delivered,
    'pending peer note delivered to replacement Lead',
  )
  const notes = await ok<Comment[]>('GET', `/tasks/${recipient.task.id}/comments`)
  expect(notes.filter((c) => c.id === sent.id)).toHaveLength(1)
  const resumed = (await ok<Task[]>('GET', '/tasks')).find((t) => t.id === recipient.task.id)
  if (!resumed?.leadRunId) throw new Error('resumed Lead missing')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const resumedClient = api(daemon?.port ?? 0, tokens.issue(resumed.leadRunId))
  expect((await resumedClient.call('POST', `/runs/${resumed.leadRunId}/boundary`)).body).toEqual({
    delivered: 0,
  })
})

test('peer notes leave human requests unanswered and do not wake an idle Lead', async () => {
  const { ok, sender, recipient } = await setup()
  const asked = await recipient.run.call('POST', `/tasks/${recipient.task.id}/comments`, {
    body: 'Please choose the interface',
    choices: ['Approve', 'Change it'],
  })
  expect(asked.status).toBe(201)
  const request = asked.body as Comment
  const sent = await sender.run.call('POST', `/peers/tasks/${recipient.task.id}/messages`, {
    operation: 'gated',
    text: 'I can adapt to either interface.',
  })
  expect(sent.status).toBe(201)
  const message = sent.body as PeerMessage
  const boundary = await recipient.run.call('POST', `/runs/${recipient.runId}/boundary`)
  expect(boundary.body).toEqual({ delivered: 0 })
  const notes = await ok<Comment[]>('GET', `/tasks/${recipient.task.id}/comments`)
  expect(notes.find((c) => c.id === request.id)?.answer).toBeUndefined()
  expect(notes.find((c) => c.id === message.id)?.delivered).toBeUndefined()
  await writeFile(path.join(scratch, 'recipient'), '')
  await waitUntil(async () => {
    const task = (await ok<Task[]>('GET', '/tasks')).find((t) => t.id === recipient.task.id)
    return task?.runs.find((r) => r.id === recipient.runId)?.state === 'idle'
  }, 'recipient to become idle')
  const again = await recipient.run.call('POST', `/runs/${recipient.runId}/boundary`)
  expect(again.body).toEqual({ delivered: 0 })
  expect(
    (await ok<Comment[]>('GET', `/tasks/${recipient.task.id}/comments`)).find(
      (c) => c.id === message.id,
    )?.delivered,
  ).toBeUndefined()
})
