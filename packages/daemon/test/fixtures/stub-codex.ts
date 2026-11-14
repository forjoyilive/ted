#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { readStubJson } from './stub-json.ts'

type Step =
  | { say: string }
  | { lines: number; everyMs: number }
  | { waitFor: string }
  | { run: string[] }
  | { approval: 'command'; command?: string; cwd?: string; extra?: Record<string, unknown> }
  | { approval: 'fileChange'; changes?: { path: string; diff: string }[] }
  | { approval: 'permissions'; permissions: Record<string, unknown> }
  | { legacyApproval: unknown[]; extra?: Record<string, unknown> }
  | { endTurn: true }
  | { exit: number }
  | { authError: true }
  | { notify: string; params: Record<string, unknown> }
  | { tool: true }

interface Message {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

const argv = process.argv.slice(2)

function stubHealth(): {
  version?: string
  signedIn?: boolean
  account?: 'chatgpt' | 'apiKey'
  rateLimits?: Record<string, unknown>
  rateLimitsDelayMs?: number
  rateLimitsError?: boolean
  rateLimitsHang?: boolean
  resumeSteps?: Step[]
  turnStartDelayMs?: number
  turnStartWaitFor?: string
} {
  return readStubJson(path.join(process.env.TED_HOME ?? '', 'stub-codex.json'))
}

function healthReply(): { text: string; code: number } | undefined {
  const health = stubHealth()
  if (argv[0] === '--version')
    return { text: `codex-cli ${health.version ?? '0.160.0'}\n`, code: 0 }
  if (argv[0] === 'login' && argv[1] === 'status') {
    return health.signedIn === false
      ? { text: 'Not logged in\n', code: 1 }
      : { text: 'Logged in using ChatGPT\n', code: 0 }
  }
  return undefined
}

const reply = healthReply()
if (reply) {
  process.stdout.write(reply.text, () => process.exit(reply.code))
  await new Promise(() => {})
}
writeFileSync('stub-record.json', JSON.stringify({ argv, env: process.env, pid: process.pid }))
appendFileSync('stub-starts.jsonl', `${JSON.stringify({ argv, pid: process.pid })}\n`)

const send = (message: Message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method: string, params: Record<string, unknown>) => send({ method, params })

let threadId = ''
let threadModel = ''
let resumed = false

const models = [
  { model: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
  { model: 'gpt-6-mini', efforts: ['low', 'medium'], isDefault: false },
].map(({ model, efforts, isDefault }) => ({
  id: model,
  model,
  isDefault,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
}))
let initialized = false
let turnActive = false
let interrupted = false
let turnNumber = 0
let nextItem = 0
let nextRequest = 1000
const answers = new Map<number, (message: Message) => void>()

const say = (text: string) =>
  notify('item/completed', {
    threadId,
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: randomUUID(), text },
  })

const status = (status: Record<string, unknown>) =>
  notify('thread/status/changed', { threadId, status })

async function runStep(step: Step, turn = turnNumber): Promise<void> {
  const stopped = () => interrupted || turn !== turnNumber
  if ('tool' in step) {
    const item = { type: 'commandExecution', id: `cmd-${++nextItem}`, command: `step ${nextItem}` }
    notify('item/started', { threadId, turnId: 'turn-1', item: { ...item, status: 'inProgress' } })
    notify('item/completed', {
      threadId,
      turnId: 'turn-1',
      item: { ...item, status: 'completed', aggregatedOutput: 'ok', exitCode: 0 },
    })
  } else if ('notify' in step) notify(step.notify, { threadId, turnId: 'turn-1', ...step.params })
  else if ('authError' in step) {
    notify('error', {
      threadId,
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'unauthorized', codexErrorInfo: 'unauthorized' },
    })
  } else if ('say' in step) say(step.say)
  else if ('lines' in step) {
    for (let i = 1; i <= step.lines; i++) {
      say(`line ${i}`)
      await sleep(step.everyMs)
    }
  } else if ('waitFor' in step) {
    while (!existsSync(step.waitFor) && !stopped()) await sleep(25)
  } else if ('run' in step) {
    const [command = '', ...args] = step.run
    const result = spawnSync(command, args, { encoding: 'utf8' })
    say(JSON.stringify({ code: result.status, stdout: result.stdout, stderr: result.stderr }))
  } else if ('legacyApproval' in step) {
    const id = nextRequest++
    const answered = new Promise<Message>((resolve) => answers.set(id, resolve))
    send({
      id,
      method: 'execCommandApproval',
      params: {
        conversationId: threadId,
        callId: `call-${id}`,
        approvalId: null,
        command: step.legacyApproval,
        cwd: process.cwd(),
        reason: null,
        parsedCmd: [],
        ...step.extra,
      },
    })
    const answer = await answered
    say(JSON.stringify(answer.result ?? answer.error))
  } else if ('approval' in step) {
    const id = nextRequest++
    const answered = new Promise<Message>((resolve) => answers.set(id, resolve))
    if ('changes' in step && step.changes) {
      notify('item/started', {
        threadId,
        turnId: 'turn-1',
        item: {
          type: 'fileChange',
          id: `item-${id}`,
          status: 'inProgress',
          changes: step.changes.map((c) => ({ ...c, kind: { type: 'update', move_path: null } })),
        },
      })
    }
    status({ type: 'active', activeFlags: ['waitingOnApproval'] })
    send({
      id,
      method: `item/${step.approval === 'command' ? 'commandExecution' : step.approval}/requestApproval`,
      params: {
        threadId,
        turnId: 'turn-1',
        itemId: `item-${id}`,
        ...('permissions' in step && { permissions: step.permissions, cwd: process.cwd() }),
        ...('command' in step &&
          step.command !== undefined && {
            command: step.command,
            reason: 'git needs to write outside the workspace',
          }),
        ...('cwd' in step && step.cwd !== undefined && { cwd: step.cwd }),
        ...('extra' in step && step.extra),
      },
    })
    const answer = await answered
    notify('serverRequest/resolved', { threadId, requestId: id })
    status({ type: 'active', activeFlags: [] })
    say(JSON.stringify(answer.result ?? answer.error))
  } else if ('endTurn' in step) {
    turnActive = false
    notify('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed', items: [] } })
    status({ type: 'idle' })
  } else if ('exit' in step) process.stdout.write('', () => process.exit(step.exit))
}

function openThread(id: number | string, thread: string): void {
  threadId = thread
  send({ id, result: { thread: { id: threadId }, model: 'stub', cwd: process.cwd() } })
  notify('thread/started', { thread: { id: threadId } })
  status({ type: 'idle' })
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as Message
  appendFileSync('stub-requests.jsonl', `${line}\n`)
  if (message.method === undefined && typeof message.id === 'number') {
    answers.get(message.id)?.(message)
    continue
  }
  appendFileSync(
    path.join(process.env.TED_HOME ?? '', 'stub-usage-methods.jsonl'),
    `${JSON.stringify(message.method)}\n`,
  )
  const id = message.id ?? 0
  if (message.method === 'initialize') {
    initialized = true
    send({ id, result: { userAgent: 'stub-codex/0.0.0' } })
  } else if (message.method === 'initialized') {
  } else if (!initialized) {
    send({ id, error: { code: -32600, message: 'Not initialized' } })
  } else if (message.method === 'account/read') {
    const type = stubHealth().account ?? 'chatgpt'
    send({
      id,
      result: {
        account:
          type === 'apiKey' ? { type } : { type, email: 'stub@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      },
    })
  } else if (message.method === 'account/rateLimits/read') {
    const health = stubHealth()
    appendFileSync(
      path.join(process.env.TED_HOME ?? '', 'stub-usage-reads.jsonl'),
      `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), env: process.env })}\n`,
    )
    if (health.rateLimitsHang) continue
    if (health.rateLimitsDelayMs) await sleep(health.rateLimitsDelayMs)
    if (health.rateLimitsError) send({ id, error: { code: -1, message: 'Usage unavailable' } })
    else
      send({ id, result: { rateLimits: health.rateLimits ?? { primary: null, secondary: null } } })
  } else if (message.method === 'model/list') {
    send({ id, result: { data: models, nextCursor: null } })
  } else if (message.method === 'config/read') {
    send({ id, result: { config: { mcp_servers: { external: { command: 'must-not-run' } } } } })
  } else if (message.method === 'thread/start') {
    threadModel = String(message.params?.model ?? '')
    openThread(id, `0199a000-0000-7000-8000-${randomUUID().slice(-12)}`)
  } else if (message.method === 'thread/resume') {
    resumed = true
    threadModel = String(message.params?.model ?? '')
    openThread(id, String(message.params?.threadId))
  } else if (
    message.method === 'turn/start' &&
    `${threadModel} ${message.params?.model ?? ''}`.includes('unavailable')
  ) {
    send({ id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
    notify('turn/started', { threadId, turn: { id: 'turn-1', status: 'inProgress', items: [] } })
    status({ type: 'active', activeFlags: [] })
    status({ type: 'systemError' })
    const error = {
      message: JSON.stringify({
        type: 'error',
        status: 400,
        error: { message: 'The model is not supported.', code: 'model_not_found' },
      }),
      codexErrorInfo: 'other',
    }
    notify('error', { error, willRetry: false, threadId, turnId: 'turn-1' })
    notify('turn/completed', { threadId, turn: { id: 'turn-1', status: 'failed', error } })
    status({ type: 'idle' })
  } else if (
    message.method === 'turn/start' &&
    JSON.stringify(message.params).includes('reject-turn')
  ) {
    send({ id, error: { code: -32600, message: 'turn rejected' } })
  } else if (message.method === 'turn/steer') {
    if (!turnActive || message.params?.expectedTurnId !== 'turn-1') {
      send({ id, error: { code: -32600, message: 'no active turn to steer' } })
      continue
    }
    send({ id, result: { turnId: 'turn-1' } })
    const input = message.params?.input as { type: string; text: string }[]
    notify('item/completed', {
      threadId,
      turnId: 'turn-1',
      item: { type: 'userMessage', id: randomUUID(), content: input },
    })
    say(`Read: ${input.map((i) => i.text).join('\n')}`)
  } else if (message.method === 'turn/interrupt') {
    send({ id, result: {} })
    if (turnActive) {
      interrupted = true
      turnActive = false
      notify('turn/completed', {
        threadId,
        turn: { id: 'turn-1', status: 'interrupted', items: [] },
      })
      status({ type: 'idle' })
    }
  } else if (message.method === 'turn/start') {
    await sleep(stubHealth().turnStartDelayMs ?? 0)
    const waitFor = stubHealth().turnStartWaitFor
    while (waitFor && !existsSync(waitFor)) await sleep(25)
    turnActive = true
    interrupted = false
    const turn = ++turnNumber
    send({ id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
    const input = message.params?.input as { type: string; text: string }[]
    const text = input.map((i) => i.text).join('\n')
    notify('turn/started', { threadId, turn: { id: 'turn-1', status: 'inProgress', items: [] } })
    status({ type: 'active', activeFlags: [] })
    notify('item/completed', {
      threadId,
      turnId: 'turn-1',
      item: { type: 'userMessage', id: randomUUID(), content: input },
    })
    void (async () => {
      const steps = stepsIn(text)
      for (const step of steps.length > 0
        ? steps
        : resumed
          ? (stubHealth().resumeSteps ?? [])
          : []) {
        if (interrupted || turn !== turnNumber) break
        await runStep(step, turn)
      }
    })()
  } else {
    send({ id, error: { code: -32601, message: `unknown method ${message.method}` } })
  }
}

function stepsIn(content: string): Step[] {
  for (const candidate of [content, ...content.split('\n')]) {
    try {
      const parsed = JSON.parse(candidate) as { steps?: Step[] }
      if (Array.isArray(parsed.steps)) return parsed.steps
    } catch {}
  }
  return []
}
