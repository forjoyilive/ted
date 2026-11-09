import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { RunState } from '@ted/protocol'
import type { Agent } from './agent.ts'

const stateByHook: Record<string, RunState> = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  PermissionRequest: 'waiting',
  Stop: 'idle',
  StopFailure: 'idle',
}

const removedEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']

export function claudeAgent(binary: string): Agent {
  return {
    kind: 'claude',
    binary,
    launch({ prompt, runDir, env, resume }) {
      const sessionId = resume ?? randomUUID()
      const settingsPath = path.join(runDir, 'settings.json')
      const hooks = Object.fromEntries(
        Object.keys(stateByHook).map((event) => [
          event,
          [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }],
        ]),
      )
      return {
        command: binary,
        args: [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-hook-events',
          '--replay-user-messages',
          resume === undefined ? '--session-id' : '--resume',
          sessionId,
          '--settings',
          settingsPath,
          '--permission-mode',
          'auto',
        ],
        env: Object.fromEntries(Object.entries(env).filter(([k]) => !removedEnv.includes(k))),
        input: JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }),
        files: { 'settings.json': JSON.stringify({ hooks }, null, 2) },
        sessionId,
      }
    },
    stateFrom(line) {
      let message: { type?: unknown; subtype?: unknown; hook_event?: unknown }
      try {
        message = JSON.parse(line)
      } catch {
        return undefined
      }
      if (message.type !== 'system' || message.subtype !== 'hook_started') return undefined
      return typeof message.hook_event === 'string' ? stateByHook[message.hook_event] : undefined
    },
    sessionIdFrom: () => undefined,
  }
}
