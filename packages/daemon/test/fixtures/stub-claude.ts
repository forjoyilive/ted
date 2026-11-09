#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

writeFileSync('stub-record.json', JSON.stringify({ argv, env: process.env, pid: process.pid }))

const sessionId = flag('--session-id') ?? 'no-session'
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

async function runStep(step: Step): Promise<void> {
  if ('everyMessage' in step) everyMessage = step.everyMessage
  else if ('say' in step) say(step.say)
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

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { message: { content: string } }
  emit({ type: 'user', message: message.message })
  hook('UserPromptSubmit')
  emit({ type: 'system', subtype: 'init', cwd: process.cwd() })
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
