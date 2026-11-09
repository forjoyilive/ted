import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { RunState } from '@ted/protocol'
import type { Agent, AuthCheck } from './agent.ts'
import { claudeChat } from './claude-chat.ts'

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

const withoutRemoved = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !removedEnv.includes(k)))

const authFailure = /\/login|not logged in|authentication|invalid api key|oauth/i

function claudeAuth({ stdout, code }: { code: number | null; stdout: string }): AuthCheck {
  let status: {
    loggedIn?: unknown
    authMethod?: unknown
    email?: unknown
    subscriptionType?: unknown
  }
  try {
    status = JSON.parse(stdout)
  } catch {
    return { signedIn: code === 0 }
  }
  if (status.loggedIn !== true) return { signedIn: false }
  const plan =
    typeof status.subscriptionType === 'string' && status.subscriptionType !== ''
      ? `Claude ${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)}`
      : undefined
  const billing = status.authMethod === 'claude.ai' ? 'subscription' : 'API key'
  const parts = [
    ...(typeof status.email === 'string' ? [`Signed in as ${status.email}`] : ['Signed in']),
    ...(plan ? [plan] : []),
    billing,
  ]
  return { signedIn: true, account: parts.join(' · ') }
}

const userMessage = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

export function claudeAgent(binary: string): Agent {
  return {
    kind: 'claude',
    binary,
    launch({ prompt, runDir, env, resume, model, effort }) {
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
          ...(model !== undefined ? ['--model', model] : []),
          ...(effort !== undefined ? ['--effort', effort === 'ultra' ? 'max' : effort] : []),
        ],
        env: withoutRemoved(env),
        input: prompt === '' ? '' : userMessage(prompt),
        files: { 'settings.json': JSON.stringify({ hooks }, null, 2) },
        sessionId,
      }
    },
    message: userMessage,
    chat: claudeChat,
    stateFrom(line) {
      const message = parse(line)
      if (message === undefined) return undefined
      if (message.type !== 'system' || message.subtype !== 'hook_started') return undefined
      return typeof message.hook_event === 'string' ? stateByHook[message.hook_event] : undefined
    },
    acceptedTextFrom(line) {
      const message = parse(line)
      if (message?.type !== 'user') return undefined
      const content = message.message?.content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return undefined
      const texts = (content as { type?: unknown; text?: unknown }[]).flatMap((part) =>
        part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
      )
      return texts.length > 0 ? texts.join('\n') : undefined
    },
    sessionIdFrom: () => undefined,
    authErrorFrom(line) {
      let message: { type?: unknown; error?: unknown; is_error?: unknown; result?: unknown }
      try {
        message = JSON.parse(line)
      } catch {
        return false
      }
      if (message?.type === 'assistant') return message.error === 'authentication_failed'
      return (
        message?.type === 'result' &&
        message.is_error === true &&
        typeof message.result === 'string' &&
        authFailure.test(message.result)
      )
    },
    environment: withoutRemoved,
    health: {
      minimumVersion: '2.1.111',
      versionArgs: ['--version'],
      authArgs: ['auth', 'status'],
      auth: claudeAuth,
      signIn: 'claude auth login',
      update: 'claude update',
      install: 'curl -fsSL https://claude.ai/install.sh | bash',
    },
    tokensFrom(line) {
      let message: { type?: unknown; usage?: Record<string, unknown> }
      try {
        message = JSON.parse(line)
      } catch {
        return undefined
      }
      if (message?.type !== 'result' || typeof message.usage !== 'object') return undefined
      const count = (name: string) => {
        const value = message.usage?.[name]
        return typeof value === 'number' ? value : 0
      }
      return {
        input:
          count('input_tokens') +
          count('cache_creation_input_tokens') +
          count('cache_read_input_tokens'),
        output: count('output_tokens'),
        total: false,
      }
    },
    problemFrom(line) {
      const message = parse(line)
      return message?.type === 'assistant' && message.error === 'model_not_found'
        ? 'model-unavailable'
        : undefined
    },
  }
}

interface ClaudeLine {
  type?: unknown
  subtype?: unknown
  hook_event?: unknown
  error?: unknown
  message?: { content?: unknown }
}

function parse(line: string): ClaudeLine | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as ClaudeLine) : undefined
  } catch {
    return undefined
  }
}
