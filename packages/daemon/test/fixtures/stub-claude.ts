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
  | { endTurn: true }
  | { exit: number }

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

async function runStep(step: Step): Promise<void> {
  if ('say' in step) say(step.say)
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
    emit({ type: 'result', subtype: 'success', stop_reason: 'end_turn' })
  } else if ('exit' in step) process.stdout.write('', () => process.exit(step.exit))
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { message: { content: string } }
  emit({ type: 'user', message: message.message })
  hook('UserPromptSubmit')
  emit({ type: 'system', subtype: 'init', cwd: process.cwd() })
  const { steps } = JSON.parse(message.message.content) as { steps: Step[] }
  for (const step of steps) await runStep(step)
}
