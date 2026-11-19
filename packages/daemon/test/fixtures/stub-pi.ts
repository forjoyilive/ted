#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { JsonObject } from '@ted/protocol/parse'

interface StubState {
  version?: string
  models?: number
}

const state: StubState = (() => {
  try {
    return JSON.parse(
      readFileSync(path.join(process.env.TED_HOME ?? process.cwd(), 'stub-pi.json'), 'utf8'),
    )
  } catch {
    return {}
  }
})()

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (argv.includes('--version')) {
  console.log(state.version ?? '1.5.2')
  process.exit(0)
}
if (argv.includes('--list-models')) {
  if (state.models === 0) {
    console.log('No models available. Log in to a provider first.')
  } else {
    console.log('provider    model        context  max-out  thinking  images')
    for (let n = 0; n < (state.models ?? 2); n++)
      console.log(`stub        model-${n}      128K     16K      yes       no    `)
  }
  process.exit(0)
}

const sessionDir = flag('--session-dir') ?? '.'
const runDir = path.dirname(path.resolve(sessionDir))
// Under Ted's real sandbox the Run folder outside pi-sessions isn't writable.
const note = (file: string, text: string) => {
  try {
    appendFileSync(path.join(runDir, file), text)
  } catch {}
}
note('stub-pi-launches.jsonl', `${JSON.stringify({ argv })}\n`)

const opened = flag('--session')
const sessionId = opened ? path.basename(opened, '.jsonl').split('_').at(-1) : randomUUID()
const sessionFile = opened ?? path.join(sessionDir, `2026-11-18T00-00-00-000Z_${sessionId}.jsonl`)
if (!opened) {
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId })}\n`)
}

const send = (record: JsonObject) => process.stdout.write(`${JSON.stringify(record)}\n`)
const record = (command: JsonObject) =>
  note('stub-pi-commands.jsonl', `${JSON.stringify(command)}\n`)

const attempt = (work: () => string) => {
  try {
    return { ok: true, output: work() }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}
const write = (file: string) => () => {
  writeFileSync(file, 'x')
  return ''
}

function probeSandbox() {
  const home = process.env.TED_HOME ?? ''
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? ''
  const result = {
    insideWrite: attempt(write(path.join(process.cwd(), 'stub-pi-wrote'))),
    outsideWrite: attempt(write(path.join(home, 'stub-pi-escaped'))),
    daemonInfo: attempt(() => readFileSync(path.join(home, 'daemon.json'), 'utf8')),
    piAgentRead: attempt(() => readFileSync(path.join(agentDir, 'settings.json'), 'utf8')),
    piAgentWrite: attempt(write(path.join(agentDir, 'stub-pi-wrote'))),
    ted: attempt(() =>
      execFileSync('ted', ['task', 'list'], { encoding: 'utf8', timeout: 60_000 }),
    ),
  }
  writeFileSync(path.join(sessionDir, 'stub-pi-probe.json'), JSON.stringify(result))
}

const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cacheRead: 2,
  cacheWrite: 0,
  totalTokens: input + output + 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
})

let streaming = false
let waiting: ((steer: string | undefined) => void) | undefined
const steers: string[] = []
const dialogs = new Map<string, () => void>()

function assistant(content: JsonObject[], stopReason: string, extra: JsonObject = {}) {
  return {
    role: 'assistant',
    content,
    api: 'stub',
    provider: 'stub',
    model: flag('--model') ?? 'stub/default',
    usage: usage(10, 5, flag('--model')?.startsWith('ollama/') ? 0 : 0.0012),
    stopReason,
    timestamp: Date.now(),
    ...extra,
  }
}

async function turn(text: string) {
  if (text.includes('STUB_PROBE')) probeSandbox()
  streaming = true
  send({ type: 'agent_start' })
  send({ type: 'turn_start' })
  send({ type: 'message_start', message: { role: 'user', content: text } })
  send({ type: 'message_end', message: { role: 'user', content: text } })
  send({ type: 'message_start', message: assistant([], 'pending') })
  if (text.includes('STUB_ERROR')) {
    send({
      type: 'message_end',
      message: assistant([], 'error', { errorMessage: 'The stub provider failed' }),
    })
  } else {
    if (text.includes('STUB_DIALOG')) {
      await new Promise<void>((resolve) => {
        dialogs.set('dialog-1', resolve)
        send({
          type: 'extension_ui_request',
          id: 'dialog-1',
          method: 'select',
          title: 'Allow the stub?',
          options: ['Allow', 'Block'],
        })
        send({ type: 'extension_ui_request', id: 'note-1', method: 'notify', message: 'Hi' })
      })
    }
    send({
      type: 'message_update',
      usage: usage(0, 0, 0),
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Thinking it ' },
    })
    send({
      type: 'message_update',
      usage: usage(0, 0, 0),
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Thinking it over' },
    })
    send({
      type: 'message_update',
      usage: usage(0, 0, 0),
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello\u2028' },
    })
    send({
      type: 'message_update',
      usage: usage(0, 0, 0),
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: `from Pi: ${text}` },
    })
    if (argv.includes('--no-tools')) {
      send({
        type: 'message_end',
        message: assistant(
          [
            { type: 'thinking', thinking: 'Thinking it over' },
            { type: 'text', text: `Hello\u2028from Pi: ${text}` },
          ],
          'stop',
        ),
      })
      send({ type: 'turn_end', message: {}, toolResults: [] })
      streaming = false
      send({ type: 'agent_end', messages: [], willRetry: false })
      send({ type: 'agent_settled', aborted: false })
      return
    }
    const call = { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls -la' } }
    send({
      type: 'message_update',
      usage: usage(0, 0, 0),
      assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: call },
    })
    send({
      type: 'message_end',
      message: assistant(
        [
          { type: 'thinking', thinking: 'Thinking it over' },
          { type: 'text', text: `Hello\u2028from Pi: ${text}` },
          call,
        ],
        'toolUse',
      ),
    })
    send({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: call.arguments,
    })
    let steer = steers.shift()
    if (steer === undefined && text.includes('STUB_WAIT')) {
      steer = await new Promise<string | undefined>((resolve) => {
        waiting = resolve
      })
      waiting = undefined
    }
    if (steer === undefined && text.includes('STUB_WAIT')) {
      send({ type: 'message_end', message: assistant([], 'aborted') })
      streaming = false
      send({ type: 'agent_end', messages: [], willRetry: false })
      send({ type: 'agent_settled', aborted: true })
      return
    }
    send({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'stub-output' }], details: {} },
      isError: false,
      durationMs: 3,
    })
    send({ type: 'turn_end', message: {}, toolResults: [] })
    const reply = steer === undefined ? 'Done.' : `Steered: ${steer}`
    send({ type: 'message_start', message: assistant([], 'pending') })
    send({
      type: 'message_end',
      message: assistant([{ type: 'text', text: reply }], 'stop'),
    })
  }
  send({ type: 'turn_end', message: {}, toolResults: [] })
  streaming = false
  send({ type: 'agent_end', messages: [], willRetry: false })
  send({ type: 'agent_settled', aborted: false })
}

async function* lfLines(input: NodeJS.ReadableStream) {
  let buffered = ''
  for await (const chunk of input) {
    buffered += chunk.toString()
    let end = buffered.indexOf('\n')
    while (end !== -1) {
      yield buffered.slice(0, end).replace(/\r$/, '')
      buffered = buffered.slice(end + 1)
      end = buffered.indexOf('\n')
    }
  }
}

for await (const line of lfLines(process.stdin)) {
  const command = JSON.parse(line)
  record(command)
  const respond = (data?: JsonObject) =>
    send({
      type: 'response',
      ...(command.id !== undefined && { id: command.id }),
      command: command.type,
      success: true,
      ...(data !== undefined && { data }),
    })
  if (command.type === 'get_state') {
    respond({ sessionId, sessionFile, isStreaming: streaming, thinkingLevel: flag('--thinking') })
  } else if (command.type === 'prompt') {
    if (streaming && command.streamingBehavior === undefined) {
      send({
        type: 'response',
        id: command.id,
        command: 'prompt',
        success: false,
        error: 'Agent is already streaming',
      })
    } else if (streaming) {
      respond({ disposition: 'queued' })
      if (waiting) waiting(command.message)
      else steers.push(command.message)
    } else {
      respond({ disposition: 'started' })
      void turn(command.message)
    }
  } else if (command.type === 'abort') {
    waiting?.(undefined)
    respond()
  } else if (command.type === 'clear_queue') {
    steers.length = 0
    respond({ steering: [], followUp: [] })
  } else if (command.type === 'extension_ui_response') {
    dialogs.get(command.id)?.()
    dialogs.delete(command.id)
  }
}
