#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

type Step =
  | { say: string }
  | { lines: number; everyMs: number }
  | { waitFor: string }
  | { run: string[] }
  | { approval: 'command' | 'fileChange' }
  | { endTurn: true }
  | { exit: number }

interface Message {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

const argv = process.argv.slice(2)
writeFileSync('stub-record.json', JSON.stringify({ argv, env: process.env, pid: process.pid }))

const send = (message: Message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method: string, params: Record<string, unknown>) => send({ method, params })

let threadId = ''
let initialized = false
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

async function runStep(step: Step): Promise<void> {
  if ('say' in step) say(step.say)
  else if ('lines' in step) {
    for (let i = 1; i <= step.lines; i++) {
      say(`line ${i}`)
      await sleep(step.everyMs)
    }
  } else if ('waitFor' in step) {
    while (!existsSync(step.waitFor)) await sleep(25)
  } else if ('run' in step) {
    const [command = '', ...args] = step.run
    const result = spawnSync(command, args, { encoding: 'utf8' })
    say(JSON.stringify({ code: result.status, stdout: result.stdout, stderr: result.stderr }))
  } else if ('approval' in step) {
    const id = nextRequest++
    const answered = new Promise<Message>((resolve) => answers.set(id, resolve))
    status({ type: 'active', activeFlags: ['waitingOnApproval'] })
    send({
      id,
      method: `item/${step.approval === 'command' ? 'commandExecution' : 'fileChange'}/requestApproval`,
      params: { threadId, turnId: 'turn-1', itemId: 'item-1' },
    })
    const answer = await answered
    notify('serverRequest/resolved', { threadId, requestId: id })
    status({ type: 'active', activeFlags: [] })
    say(JSON.stringify(answer.result ?? answer.error))
  } else if ('endTurn' in step) {
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
  if (message.method === undefined && typeof message.id === 'number') {
    answers.get(message.id)?.(message)
    continue
  }
  const id = message.id ?? 0
  if (message.method === 'initialize') {
    initialized = true
    send({ id, result: { userAgent: 'stub-codex/0.0.0' } })
  } else if (message.method === 'initialized') {
  } else if (!initialized) {
    send({ id, error: { code: -32600, message: 'Not initialized' } })
  } else if (message.method === 'thread/start') {
    openThread(id, `0199a000-0000-7000-8000-${randomUUID().slice(-12)}`)
  } else if (message.method === 'thread/resume') {
    openThread(id, String(message.params?.threadId))
  } else if (message.method === 'turn/start') {
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
      for (const step of stepsIn(text)) await runStep(step)
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
