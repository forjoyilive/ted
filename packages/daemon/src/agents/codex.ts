import { fileURLToPath } from 'node:url'
import { type RunState, tedVersion } from '@ted/protocol'
import type { Agent, AuthCheck } from './agent.ts'
import { codexChat } from './codex-chat.ts'
import type { CodexPlan } from './codex-driver.ts'

const driver = fileURLToPath(new URL('./codex-driver.ts', import.meta.url))

const removedEnv = ['CODEX_API_KEY', 'OPENAI_API_KEY']

const config = [
  'sandbox_mode="workspace-write"',
  'approval_policy="on-request"',
  'sandbox_workspace_write.network_access=true',
  'shell_environment_policy.inherit="all"',
  'shell_environment_policy.ignore_default_excludes=true',
]

const stateByMethod: Record<string, RunState> = {
  'turn/started': 'working',
  'turn/completed': 'idle',
  'serverRequest/resolved': 'working',
  'item/commandExecution/requestApproval': 'waiting',
  'item/fileChange/requestApproval': 'waiting',
  'item/permissions/requestApproval': 'waiting',
  'item/tool/requestUserInput': 'waiting',
  'mcpServer/elicitation/request': 'waiting',
  execCommandApproval: 'waiting',
  applyPatchApproval: 'waiting',
}

const withoutRemoved = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !removedEnv.includes(k)))

function codexAuth({
  code,
  stdout,
  stderr,
}: {
  code: number | null
  stdout: string
  stderr: string
}): AuthCheck {
  const text = `${stdout}\n${stderr}`
  if (code !== 0 || /not logged in/i.test(text)) return { signedIn: false }
  if (/chatgpt/i.test(text))
    return { signedIn: true, account: 'Signed in with ChatGPT · subscription' }
  if (/api key/i.test(text)) return { signedIn: true, account: 'Signed in with an API key' }
  return { signedIn: true }
}

function isUnauthorized(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const info = (error as { codexErrorInfo?: unknown }).codexErrorInfo
  return (
    info === 'unauthorized' || (typeof info === 'object' && info !== null && 'unauthorized' in info)
  )
}

interface CodexLine {
  id?: unknown
  method?: unknown
  params?: {
    thread?: { id?: unknown }
    status?: { type?: unknown; activeFlags?: unknown }
    error?: { message?: unknown; codexErrorInfo?: unknown }
    turn?: { error?: unknown }
    item?: { type?: unknown; content?: unknown }
    tokenUsage?: { total?: { inputTokens?: unknown; outputTokens?: unknown } }
  }
}

function parse(line: string): CodexLine | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as CodexLine) : undefined
  } catch {
    return undefined
  }
}

export function codexAgent(binary: string): Agent {
  return {
    kind: 'codex',
    binary,
    launch({ prompt, env, resume, model, effort }) {
      const plan: CodexPlan = {
        thread:
          resume === undefined
            ? { method: 'thread/start', params: {} }
            : { method: 'thread/resume', params: { threadId: resume } },
        prompt,
        clientVersion: tedVersion,
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
      }
      return {
        command: binary,
        args: ['app-server', ...config.flatMap((c) => ['-c', c])],
        env: withoutRemoved(env),
        input: JSON.stringify(plan),
        files: {},
        driver,
        ...(resume !== undefined && { sessionId: resume }),
      }
    },
    message: (text) => JSON.stringify({ text }),
    chat: codexChat,
    stateFrom(line) {
      const message = parse(line)
      if (typeof message?.method !== 'string') return undefined
      if (message.method === 'thread/status/changed') {
        const status = message.params?.status
        if (status?.type === 'idle') return 'idle'
        if (status?.type !== 'active') return undefined
        const flags = Array.isArray(status.activeFlags) ? status.activeFlags : []
        return flags.length > 0 ? 'waiting' : 'working'
      }
      return stateByMethod[message.method]
    },
    acceptedTextFrom(line) {
      const message = parse(line)
      if (message?.method !== 'item/started' && message?.method !== 'item/completed') {
        return undefined
      }
      const item = message.params?.item
      if (item?.type !== 'userMessage' || !Array.isArray(item.content)) return undefined
      const texts = (item.content as { type?: unknown; text?: unknown }[]).flatMap((part) =>
        part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
      )
      return texts.length > 0 ? texts.join('\n') : undefined
    },
    sessionIdFrom(line) {
      const message = parse(line)
      if (message?.method !== 'thread/started') return undefined
      const id = message.params?.thread?.id
      return typeof id === 'string' ? id : undefined
    },
    authErrorFrom(line) {
      const message = parse(line)
      if (message?.method === 'error') return isUnauthorized(message.params?.error)
      if (message?.method === 'turn/completed') return isUnauthorized(message.params?.turn?.error)
      return false
    },
    environment: withoutRemoved,
    health: {
      minimumVersion: '0.128.0',
      versionArgs: ['--version'],
      authArgs: ['login', 'status'],
      auth: codexAuth,
      signIn: 'codex login',
      update: 'codex update',
      install: 'npm install -g @openai/codex',
    },
    problemFrom(line) {
      const message = parse(line)
      if (message?.method !== 'error') return undefined
      const text = message.params?.error?.message
      return typeof text === 'string' && text.includes('model_not_found')
        ? 'model-unavailable'
        : undefined
    },
    tokensFrom(line) {
      const message = parse(line)
      if (message?.method !== 'thread/tokenUsage/updated') return undefined
      const total = message.params?.tokenUsage?.total
      const { inputTokens, outputTokens } = total ?? {}
      if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
      return { input: inputTokens, output: outputTokens, total: true }
    },
  }
}
