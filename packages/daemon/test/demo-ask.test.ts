import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { type Comment, DaemonClient, readDaemonInfo, tedVersion } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import { askDemo } from '../src/dev/ask.ts'
import { demoEnvironment, prepareDemo, until } from '../src/dev/demo.ts'
import { demoVersion, markDemo } from '../src/dev/home.ts'
import { runCli } from '../src/health/cli.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { killRunHosts, stopDaemonIn } from './helpers.ts'

const original = { ...process.env }
let home: string | undefined
let daemon: RunningDaemon | undefined

afterEach(async ({ task }) => {
  if (home) {
    if (task.result?.state === 'fail') {
      const kept = path.resolve('node_modules/.cache/ted-test-captures', path.basename(home))
      await cp(path.join(home, 'logs'), kept, { recursive: true }).catch(() => undefined)
      console.error(`demo-ask kept the failed test home’s logs in ${kept}`)
    }
    await daemon?.stop()
    daemon = undefined
    await stopDaemonIn(home)
    await killRunHosts(home)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, original)
})

async function newDemoHome(): Promise<string> {
  const parent = path.resolve('node_modules/.cache/ted-home')
  await mkdir(parent, { recursive: true })
  const folder = await mkdtemp(path.join(parent, 'demo-ask-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, demoEnvironment(folder))
  return folder
}

async function openRequest(client: DaemonClient, taskId: string, kind: Comment['kind']) {
  return until(
    async () => (await client.listComments(taskId)).find((c) => c.kind === kind && !c.answer),
    `an open ${kind}`,
    60_000,
  )
}

async function note(client: DaemonClient, taskId: string, text: string) {
  return until(
    async () =>
      (await client.listComments(taskId)).find((c) => c.kind === 'note' && c.body.includes(text)),
    `a note saying ${text}`,
    60_000,
  )
}

test('ted dev ask posts new demo requests and the Task Lead carries on after each answer', async () => {
  home = await newDemoHome()
  await prepareDemo(home)
  await markDemo(home, { version: demoVersion, complete: true })
  await expect(askDemo(home, 'question')).rejects.toThrow('Open the demo first')

  const claudeBin = path.join(home, 'bin', 'stub-claude.mjs')
  daemon = await startDaemon({ home, version: tedVersion, checkAgentsOnStart: true, claudeBin })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('The demo daemon did not publish its connection.')
  const client = new DaemonClient(info, '', { appKey: daemon.appToken })
  await client.addFactory({ repo: path.join(home, 'origins', 'journal.git'), key: 'FN' })
  await until(async () => (await client.listFactories()).every((f) => f.cloned), 'Factory clone')
  const task = await client.createTask({
    factory: 'FN',
    title: 'Try the phone checklist',
    start: false,
  })
  const { revision } = await client.taskGates(task.id)
  await client.setTaskGates(task.id, { overrides: { clarify: true }, revision })
  await client.startTask(task.id)
  const leadWaiting = async () => {
    const lead = async () => {
      const current = (await client.listTasks()).find((t) => t.id === task.id)
      const run = current?.leadRunId ? (await client.getRun(current.leadRunId)).run : undefined
      return { stage: current?.stage, status: current?.status, run: run?.state }
    }
    try {
      await until(async () => (await lead()).run === 'idle', 'a waiting Task Lead', 60_000)
    } catch {
      const claude = (await client.agentHealth()).find((h) => h.agent === 'claude')
      const auth = await runCli(claudeBin, ['auth', 'status'], {
        env: { ...process.env, TED_HOME: home },
        cwd: home ?? '',
      })
      throw new Error(
        `No waiting Task Lead. Last seen: ${JSON.stringify(await lead())}; Claude health: ${JSON.stringify(claude)}; auth status from the test: ${JSON.stringify(auth)}`,
      )
    }
  }
  await leadWaiting()

  const asked = { timeoutMs: 120_000, task: task.displayId }
  expect((await askDemo(home, 'question', asked)).task.id).toBe(task.id)
  const question = await openRequest(client, task.id, 'question')
  const choice = question.choices?.[0] ?? ''
  await client.answerRequest(question.id, { action: 'answer', choice })
  await note(client, task.id, `with “${choice}”`)

  await leadWaiting()
  await askDemo(home, 'permission', asked)
  const permission = await openRequest(client, task.id, 'permission')
  await client.answerRequest(permission.id, { action: 'approve' })
  await note(client, task.id, 'You allowed')

  await leadWaiting()
  await askDemo(home, 'sign-off', asked)
  const signoff = await openRequest(client, task.id, 'signoff')
  await client.answerRequest(signoff.id, { action: 'approve' })
  await until(
    async () => (await client.listTasks()).find((t) => t.id === task.id)?.stage === 'design',
    'the Task to move to Design',
    60_000,
  )
}, 300_000)
