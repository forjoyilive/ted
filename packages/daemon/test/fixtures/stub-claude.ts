#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

type Step =
  | { say: string }
  | { hook: string }
  | { lines: number; everyMs: number; pad?: number }
  | { waitFor: string }
  | { run: string[] }
  | { endTurn: true; usage?: Record<string, number> }
  | { exit: number }
  | { everyMessage: Step[] }
  | { authError: true }
  | {
      permission: { tool: string; input: Record<string, unknown>; description?: string }
      noWait?: true
    }
  | { cancelPermission: true }

const argv = process.argv.slice(2)

interface StubHealth {
  version?: string
  signedIn?: boolean
  autoUnavailable?: boolean
}

function stubHealth(): StubHealth {
  try {
    return JSON.parse(
      readFileSync(path.join(process.env.TED_HOME ?? '', 'stub-claude.json'), 'utf8'),
    ) as StubHealth
  } catch {
    return {}
  }
}

function healthReply(): { text: string; code: number } | undefined {
  const health = stubHealth()
  if (argv[0] === '--version')
    return { text: `${health.version ?? '2.1.319'} (Claude Code)\n`, code: 0 }
  if (argv[0] === 'auth' && argv[1] === 'status') {
    const loggedIn = health.signedIn !== false
    const status = loggedIn
      ? { loggedIn, authMethod: 'claude.ai', email: 'stub@example.com', subscriptionType: 'max' }
      : { loggedIn }
    return { text: `${JSON.stringify(status)}\n`, code: loggedIn ? 0 : 1 }
  }
  return undefined
}

const reply = healthReply()
if (reply) {
  process.stdout.write(reply.text, () => process.exit(reply.code))
  await new Promise(() => {})
}
const flag = (name: string) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

writeFileSync('stub-record.json', JSON.stringify({ argv, env: process.env, pid: process.pid }))
appendFileSync('stub-starts.jsonl', `${JSON.stringify({ argv, pid: process.pid })}\n`)

const sessionId = flag('--session-id') ?? flag('--resume') ?? 'no-session'
const model = flag('--model')
const settingsPath = flag('--settings')
const settings = settingsPath
  ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, unknown> })
  : {}
const configuredHooks = new Set(Object.keys(settings.hooks ?? {}))

const emit = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId })}\n`)

const say = (text: string) =>
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

const hook = (name: string) => {
  const event = name.split(':')[0] ?? name
  if (configuredHooks.has(event))
    emit({ type: 'system', subtype: 'hook_started', hook_name: name, hook_event: event })
}

let everyMessage: Step[] = []
let nextRequest = 0
let lastRequest: string | undefined
const answers = new Map<string, (response: unknown) => void>()
const permissionMode = () => {
  const asked = flag('--permission-mode') ?? 'default'
  return asked === 'auto' && stubHealth().autoUnavailable ? 'default' : asked
}

async function runStep(step: Step): Promise<void> {
  if ('everyMessage' in step) everyMessage = step.everyMessage
  else if ('authError' in step) {
    emit({
      type: 'assistant',
      error: 'authentication_failed',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
      },
    })
    emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
    })
  } else if ('permission' in step) {
    const requestId = `req-${++nextRequest}`
    lastRequest = requestId
    const answered = new Promise((resolve) => answers.set(requestId, resolve))
    emit({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: step.permission.tool,
        input: step.permission.input,
        ...(step.permission.description !== undefined && {
          description: step.permission.description,
        }),
      },
    })
    if (!step.noWait) say(JSON.stringify(await answered))
  } else if ('cancelPermission' in step) {
    if (lastRequest !== undefined) {
      emit({ type: 'control_cancel_request', request_id: lastRequest })
      answers.get(lastRequest)?.({ cancelled: true })
      answers.delete(lastRequest)
    }
  } else if ('say' in step) say(step.say)
  else if ('hook' in step) hook(step.hook)
  else if ('lines' in step) {
    for (let i = 1; i <= step.lines; i++) {
      say(`line ${i}${'x'.repeat(step.pad ?? 0)}`)
      await sleep(step.everyMs)
    }
  } else if ('waitFor' in step) {
    while (!existsSync(step.waitFor)) await sleep(25)
  } else if ('run' in step) {
    const [command = '', ...args] = step.run
    const result = spawnSync(command, args, { encoding: 'utf8' })
    say(JSON.stringify({ code: result.status, stdout: result.stdout, stderr: result.stderr }))
  } else if ('endTurn' in step) {
    hook('Stop')
    emit({
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      ...(step.usage && { usage: step.usage }),
    })
  } else if ('exit' in step) process.stdout.write('', () => process.exit(step.exit))
}

const messages: { message: { content: string } }[] = []
let wake: (() => void) | undefined
let closed = false
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const parsed = JSON.parse(line) as {
      type?: string
      message?: { content: string }
      response?: { request_id?: string; response?: unknown }
    }
    if (parsed.type === 'control_response') {
      const id = parsed.response?.request_id ?? ''
      answers.get(id)?.(parsed.response?.response)
      answers.delete(id)
      return
    }
    messages.push(parsed as { message: { content: string } })
    wake?.()
  })
  .on('close', () => {
    closed = true
    wake?.()
  })
for (;;) {
  const message = messages.shift()
  if (!message) {
    if (closed) break
    await new Promise<void>((resolve) => {
      wake = resolve
    })
    continue
  }
  emit({ type: 'user', message: message.message })
  hook('UserPromptSubmit')
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), permissionMode: permissionMode() })
  if (model?.includes('unavailable')) {
    emit({
      type: 'assistant',
      error: 'model_not_found',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: `There's an issue with the selected model (${model}).` }],
      },
    })
    emit({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error' })
    hook('Stop')
    continue
  }
  const own = stepsIn(message.message.content)
  for (const step of own.length > 0 ? own : everyMessage) await runStep(step)
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
