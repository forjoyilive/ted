#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  DaemonClient,
  PostCommentRequest,
  ReportOutcomeRequest,
  SetClarifyDepthRequest,
} from '@ted/protocol'
import { readStubJson } from './stub-json.ts'

type DemoRequest =
  | { brief: string }
  | { outcome: ReportOutcomeRequest }
  | { depth: SetClarifyDepthRequest }
  | { comment: PostCommentRequest }
  | { planRequest: Parameters<DaemonClient['postPlanRequest']>[0] }

type Step =
  | { demoRequest: DemoRequest }
  | { say: string }
  | { hook: string }
  | { lines: number; everyMs: number; pad?: number }
  | { waitFor: string }
  | { readNextAfter: string }
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
  | { emit: Record<string, unknown> }
  | { tool: string; failed?: true }

const argv = process.argv.slice(2)

interface StubHealth {
  version?: string
  signedIn?: boolean
  autoUnavailable?: boolean
  resumeSteps?: Step[]
  resumeFails?: boolean
  stopWaitsFor?: string
  resumeWaitsFor?: string
  resumeInputWaitsFor?: string
  inputWaitsFor?: string
  apiKeySource?: string
  authMethod?: string
  interruptEndsAfterMs?: number
}

function stubHealth(): StubHealth {
  return readStubJson(path.join(process.env.TED_HOME ?? '', 'stub-claude.json'))
}

function healthReply(): { text: string; code: number } | undefined {
  const health = stubHealth()
  if (argv[0] === '--version')
    return { text: `${health.version ?? '2.1.319'} (Claude Code)\n`, code: 0 }
  if (argv[0] === 'auth' && argv[1] === 'status') {
    const loggedIn = health.signedIn !== false
    const status = loggedIn
      ? {
          loggedIn,
          authMethod: health.authMethod ?? 'claude.ai',
          email: 'stub@example.com',
          subscriptionType: 'max',
        }
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

// Not spawnSync: a blocked event loop would hold the SIGTERM handler below until the command ends.
function runCommand(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text
    })
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text
    })
    child.on('error', (error) => resolve({ code: null, stdout, stderr: stderr + String(error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

process.on('SIGTERM', async () => {
  const gate = stubHealth().stopWaitsFor
  if (gate !== undefined) {
    writeFileSync(`${gate}.waiting`, '')
    while (!existsSync(gate)) await sleep(20)
  }
  process.removeAllListeners('SIGTERM')
  process.kill(process.pid, 'SIGTERM')
})

const resumeGate = flag('--resume') !== undefined ? stubHealth().resumeWaitsFor : undefined
while (resumeGate !== undefined && !existsSync(resumeGate)) {
  await sleep(20)
}

if (flag('--resume') !== undefined && stubHealth().resumeFails) {
  process.stderr.write(`No conversation found with session ID: ${flag('--resume')}\n`, () =>
    process.exit(1),
  )
  await new Promise(() => {})
}

const sessionId = flag('--session-id') ?? flag('--resume') ?? 'no-session'
const model = flag('--model')
const settingsPath = flag('--settings')
const settings = settingsPath
  ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, unknown> })
  : {}
const configuredHooks = new Set(Object.keys(settings.hooks ?? {}))

type HookConfig = { hooks?: { command?: string }[] }[]
const hookCommands = (event: string) =>
  ((settings.hooks?.[event] ?? []) as HookConfig).flatMap((matcher) =>
    (matcher.hooks ?? []).flatMap((hook) => (hook.command ? [hook.command] : [])),
  )

const emit = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId })}\n`)

const say = (text: string) =>
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

const hook = (name: string) => {
  const event = name.split(':')[0] ?? name
  if (configuredHooks.has(event))
    emit({ type: 'system', subtype: 'hook_started', hook_name: name, hook_event: event })
}

const defaultMessageSteps: Step[] = process.env.TED_DEMO === '1' ? [{ endTurn: true }] : []
let everyMessage: Step[] =
  flag('--resume') !== undefined
    ? (stubHealth().resumeSteps ?? defaultMessageSteps)
    : defaultMessageSteps
let inputGate =
  stubHealth().inputWaitsFor ??
  (flag('--resume') !== undefined ? stubHealth().resumeInputWaitsFor : undefined)
if (inputGate !== undefined) emit({ type: 'system', subtype: 'init', cwd: process.cwd() })
let interrupted = false
let gating = false
let gate: ReturnType<typeof spawn> | undefined
const readDuringGate: string[] = []
let nextTool = 0
let nextRequest = 0
let lastRequest: string | undefined
const answers = new Map<string, (response: unknown) => void>()
const permissionMode = () => {
  const asked = flag('--permission-mode') ?? 'default'
  const scrubbed = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1'
  return asked === 'auto' && (stubHealth().autoUnavailable || scrubbed) ? 'default' : asked
}

const credentialName = /TOKEN|KEY|SECRET|PASSWORD|AUTH/

function commandEnv(): NodeJS.ProcessEnv {
  if (process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB !== '1') return process.env
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !credentialName.test(name)),
  )
}

async function runStep(step: Step): Promise<void> {
  if ('demoRequest' in step) {
    if (process.env.TED_DEMO !== '1') throw new Error('Demo requests require an isolated demo.')
    if (!process.env.TED_HOME) throw new Error('A demo request needs a home.')
    const { DaemonClient, readDaemonInfo, runTokenFrom } = await import('@ted/protocol')
    const info = await readDaemonInfo(process.env.TED_HOME)
    const token = runTokenFrom(process.env)
    const task = process.env.TED_TASK
    if (!info || !token) throw new Error('A demo request needs a Run.')
    const client = new DaemonClient(info, token)
    const request = step.demoRequest
    try {
      if ('planRequest' in request) await client.postPlanRequest(request.planRequest)
      else if (!task) throw new Error('A demo request needs a Task Run.')
      else if ('comment' in request) await client.postComment(task, request.comment)
      else if ('brief' in request) await client.writeBrief(task, request.brief)
      else if ('outcome' in request) {
        for (let attempt = 0; ; attempt++) {
          try {
            await client.reportOutcome(task, request.outcome)
            break
          } catch (error) {
            if (
              attempt >= 100 ||
              !(error instanceof Error) ||
              !/^Ted is running .+Checks/.test(error.message)
            )
              throw error
            await sleep(25)
          }
        }
      } else await client.setClarifyDepth(task, request.depth)
      say(JSON.stringify({ code: 0, stdout: '', stderr: '' }))
    } catch (error) {
      say(
        JSON.stringify({
          code: 1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  } else if ('everyMessage' in step) everyMessage = step.everyMessage
  else if ('emit' in step) emit(step.emit)
  else if ('tool' in step) {
    const id = `tool-${++nextTool}`
    hook('PreToolUse')
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id, name: step.tool, input: { command: `step ${nextTool}` } },
        ],
      },
    })
    emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    })
    const after = step.failed ? 'PostToolUseFailure' : 'PostToolUse'
    hook(after)
    gating = true
    for (const command of hookCommands(after)) {
      if (interrupted) break
      const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] })
      gate = child
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: step.tool }))
      await once(child, 'exit')
    }
    gate = undefined
    gating = false
    for (const text of readDuringGate.splice(0)) say(`Read: ${text}`)
  } else if ('authError' in step) {
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
    while (!existsSync(step.waitFor) && !interrupted) await sleep(25)
  } else if ('readNextAfter' in step) {
    inputGate = step.readNextAfter
  } else if ('run' in step) {
    const [command = '', ...args] = step.run
    say(JSON.stringify(await runCommand(command, args)))
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

let firstDemoMessage = true
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
    if (parsed.type === 'control_request') {
      const request = parsed as { request_id?: string; request?: { subtype?: string } }
      if (request.request?.subtype === 'interrupt') {
        interrupted = true
        gate?.kill('SIGTERM')
        emit({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
            response: { still_queued: [] },
          },
        })
        wake?.()
      }
      return
    }
    if (gating && parsed.type === 'user' && parsed.message) {
      emit({ type: 'user', message: parsed.message })
      readDuringGate.push(parsed.message.content)
      return
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
  while (inputGate !== undefined && !existsSync(inputGate)) await sleep(25)
  inputGate = undefined
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
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    permissionMode: permissionMode(),
    apiKeySource: stubHealth().apiKeySource ?? 'none',
  })
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
  let own = stepsIn(message.message.content)
  if (
    firstDemoMessage &&
    process.env.TED_DEMO === '1' &&
    process.env.TED_HOME &&
    process.env.TED_TASK
  ) {
    const scenario = path.join(process.env.TED_HOME, 'inputs', `${process.env.TED_TASK}.json`)
    if (existsSync(scenario)) own = stepsIn(readFileSync(scenario, 'utf8'))
  }
  firstDemoMessage = false
  interrupted = false
  for (const step of own.length > 0 ? own : everyMessage) {
    if (interrupted) break
    await runStep(step)
  }
  if (interrupted) {
    interrupted = false
    await sleep(stubHealth().interruptEndsAfterMs ?? 0)
    emit({ type: 'result', subtype: 'error_during_execution', is_error: false })
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
