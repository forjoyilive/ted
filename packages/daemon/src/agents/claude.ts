import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  type Billing,
  isModelName,
  type PlanWindow,
  type PlanWindowKind,
  type RunState,
} from '@ted/protocol'
import {
  type Agent,
  type AuthCheck,
  fromEpoch,
  type PermissionPrompt,
  type UsageSignal,
  withoutCredentials,
} from './agent.ts'
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

const boundaryGate =
  '[ -e "$TED_HOME/runs/$TED_RUN/queued" ] && ted run boundary >/dev/null 2>&1; exit 0'

const apiKeyEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']

function claudeEnvironment(env: NodeJS.ProcessEnv, billing: Billing): NodeJS.ProcessEnv {
  return billing === 'api-key'
    ? { ...withoutCredentials(env, apiKeyEnv), CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }
    : withoutCredentials(env)
}

const planWindowByType: Record<string, PlanWindowKind> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
}

const retriedStatuses = [429, 529]

interface RateLimitInfo {
  status?: unknown
  resetsAt?: unknown
  rateLimitType?: unknown
  utilization?: unknown
}

function rateLimitInfo(message: ClaudeLine | undefined): RateLimitInfo | undefined {
  if (message?.type !== 'rate_limit_event') return undefined
  const info = message.rate_limit_info
  return typeof info === 'object' && info !== null ? (info as RateLimitInfo) : undefined
}

function usageFrom(line: string): UsageSignal | undefined {
  const message = parse(line)
  const info = rateLimitInfo(message)
  if (info) {
    if (info.status !== 'rejected') return { limited: false }
    const resetsAt = fromEpoch(info.resetsAt)
    return { limited: true, ...(resetsAt !== undefined && { resetsAt }) }
  }
  if (message?.type === 'assistant') {
    return message.error === 'rate_limit' ? { limited: true } : { limited: false }
  }
  return undefined
}

const keySources: Record<string, string> = {
  ANTHROPIC_API_KEY:
    'Claude Code found ANTHROPIC_API_KEY. TED removes it from Runs, so it comes from Claude Code’s own settings (the env block in ~/.claude/settings.json or the repo’s .claude/settings.json).',
  ANTHROPIC_AUTH_TOKEN:
    'Claude Code found ANTHROPIC_AUTH_TOKEN. TED removes it from Runs, so it comes from Claude Code’s own settings (the env block in ~/.claude/settings.json or the repo’s .claude/settings.json).',
  apiKeyHelper:
    'An apiKeyHelper in Claude Code’s settings (~/.claude/settings.json or the repo’s .claude/settings.json) gives it a key.',
  '/login managed key':
    'Claude Code is signed in with a Console account, which bills an API key. Run claude auth login and choose your Claude subscription.',
}

function keyHelp(source: string | undefined): string {
  const where =
    source === undefined
      ? 'Claude Code reported an API key.'
      : (keySources[source] ?? `Claude Code reported an API key from ${source}.`)
  return `${where} Remove it, or choose API key billing if you meant to use one.`
}

function costOf(lines: readonly string[]): number | undefined {
  let total = 0
  let last = 0
  let seen = false
  for (const line of lines) {
    const message = parse(line)
    if (message?.type !== 'result' || typeof message.total_cost_usd !== 'number') continue
    seen = true
    if (message.total_cost_usd < last) total += last
    last = message.total_cost_usd
  }
  return seen ? total + last : undefined
}

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
  const subscription = status.authMethod === 'claude.ai'
  const parts = [
    ...(typeof status.email === 'string' ? [`Signed in as ${status.email}`] : ['Signed in']),
    ...(plan ? [plan] : []),
    subscription ? 'subscription' : 'API key',
  ]
  return {
    signedIn: true,
    account: parts.join(' · '),
    billing: subscription ? 'subscription' : 'api-key',
  }
}

const modeFlag = { auto: 'auto', bypass: 'bypassPermissions' } as const

const tedCommand = ['Bash(ted *)']

const toolTitles: Record<string, string> = {
  Bash: 'Run a command',
  Edit: 'Edit a file',
  MultiEdit: 'Edit a file',
  Write: 'Write a file',
  NotebookEdit: 'Edit a notebook',
  WebFetch: 'Fetch a web page',
  WebSearch: 'Search the web',
}

const commandFields = ['command', 'file_path', 'notebook_path', 'url', 'query', 'path', 'pattern']

function promptFrom(message: ClaudeLine): PermissionPrompt | undefined {
  if (message.type !== 'control_request' || typeof message.request_id !== 'string') return undefined
  const request = message.request
  if (request?.subtype !== 'can_use_tool' || typeof request.tool_name !== 'string') return undefined
  const input =
    typeof request.input === 'object' && request.input !== null
      ? (request.input as Record<string, unknown>)
      : {}
  const field = commandFields.find((name) => typeof input[name] === 'string')
  const tool = typeof request.display_name === 'string' ? request.display_name : request.tool_name
  const command = field !== undefined ? String(input[field]) : tool
  const reason =
    typeof request.description === 'string'
      ? request.description
      : typeof input.description === 'string'
        ? input.description
        : undefined
  const rest = Object.fromEntries(
    Object.entries(input).filter(
      ([name, value]) => name !== field && !(name === 'description' && value === reason),
    ),
  )
  return {
    requestId: message.request_id,
    title: toolTitles[request.tool_name] ?? `Use ${tool}`,
    command,
    ...(Object.keys(rest).length > 0 && { details: JSON.stringify(rest, null, 2) }),
    ...(reason !== undefined && reason !== '' && { reason }),
    input,
  }
}

const userMessage = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

export function claudeAgent(binary: string): Agent {
  return {
    kind: 'claude',
    binary,
    launch({ prompt, runDir, env, resume, model, effort, permissions, billing, tools }) {
      if (model !== undefined && !isModelName(model)) {
        throw new Error(`“${model}” isn’t a model name`)
      }
      const sessionId = resume ?? randomUUID()
      const settingsPath = path.join(runDir, 'settings.json')
      const hooks = Object.fromEntries(
        Object.keys(stateByHook).map((event) => [
          event,
          [
            {
              matcher: '*',
              hooks: [
                event === 'PostToolUse' || event === 'PostToolUseFailure'
                  ? { type: 'command', command: boundaryGate, timeout: 60 }
                  : { type: 'command', command: 'true' },
              ],
            },
          ],
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
          modeFlag[permissions],
          '--permission-prompt-tool',
          'stdio',
          ...(tools === 'none'
            ? [
                '--tools',
                '',
                '--strict-mcp-config',
                '--mcp-config',
                '{"mcpServers":{}}',
                '--setting-sources',
                '',
                '--disable-slash-commands',
              ]
            : []),
          ...(model !== undefined ? ['--model', model] : []),
          ...(effort !== undefined ? ['--effort', effort === 'ultra' ? 'max' : effort] : []),
        ],
        env: claudeEnvironment(env, billing ?? 'subscription'),
        input: prompt === '' ? '' : userMessage(prompt),
        files: {
          'settings.json': JSON.stringify(
            tools === 'none'
              ? { disableAllHooks: true }
              : { ...(permissions === 'auto' && { permissions: { allow: tedCommand } }), hooks },
            null,
            2,
          ),
        },
        sessionId,
      }
    },
    message: userMessage,
    steer: userMessage,
    interrupt: () => [
      JSON.stringify({
        type: 'control_request',
        request_id: `interrupt-${randomUUID()}`,
        request: { subtype: 'interrupt' },
      }),
    ],
    boundaryFrom: () => false,
    permissionPromptFrom(line) {
      const message = parse(line)
      return message && promptFrom(message)
    },
    permissionClosedFrom(line) {
      const message = parse(line)
      return message?.type === 'control_cancel_request' && typeof message.request_id === 'string'
        ? message.request_id
        : undefined
    },
    autoModeFrom(line) {
      const message = parse(line)
      if (message?.type !== 'system' || message.subtype !== 'init') return undefined
      if (typeof message.permissionMode !== 'string') return undefined
      if (message.permissionMode === 'bypassPermissions') return undefined
      return message.permissionMode === 'auto' ? 'on' : 'unavailable'
    },
    permissionReply({ requestId, approved, input, text }) {
      const response = approved
        ? { behavior: 'allow', updatedInput: input ?? {} }
        : { behavior: 'deny', message: text ?? 'The human denied this request.' }
      return [
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response },
        }),
        ...(approved && text !== undefined ? [userMessage(text)] : []),
      ]
    },
    chat: claudeChat,
    stateFrom(line) {
      const message = parse(line)
      if (message === undefined) return undefined
      if (promptFrom(message)) return 'waiting'
      if (message.type === 'result') return 'idle'
      if (message.type !== 'system' || message.subtype !== 'hook_started') return undefined
      return typeof message.hook_event === 'string' ? stateByHook[message.hook_event] : undefined
    },
    turnFrom(line) {
      const message = parse(line)
      if (message?.type === 'result') return 'completed'
      if (message?.type === 'user' && textParts(message.message?.content) !== undefined)
        return 'started'
      return undefined
    },
    acceptedTextFrom(line) {
      const message = parse(line)
      if (message?.type !== 'user') return undefined
      return textParts(message.message?.content)
    },
    agentTextFrom(line) {
      const message = parse(line)
      if (message?.type !== 'assistant' || message.error !== undefined) return undefined
      return textParts(message.message?.content)
    },
    sessionIdFrom: () => undefined,
    sessionContinuedFrom(line) {
      try {
        const message: unknown = JSON.parse(line)
        return typeof message === 'object' && message !== null
      } catch {
        return false
      }
    },
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
    environment: claudeEnvironment,
    usageFrom,
    retryingFrom(line) {
      const message = parse(line)
      if (message?.type === 'system' && message.subtype === 'api_retry') {
        const status = message.error_status
        return typeof status !== 'number' || retriedStatuses.includes(status)
      }
      if (message?.type === 'assistant' || message?.type === 'result') return false
      return undefined
    },
    credentialFrom(line) {
      const message = parse(line)
      if (message?.type !== 'system' || message.subtype !== 'init') return undefined
      const source = message.apiKeySource
      if (typeof source !== 'string') return undefined
      return source === 'none' ? { billing: 'subscription' } : { billing: 'api-key', source }
    },
    planUsageFrom(line) {
      const info = rateLimitInfo(parse(line))
      const window = typeof info?.rateLimitType === 'string' && planWindowByType[info.rateLimitType]
      if (!info || !window) return undefined
      const percent =
        typeof info.utilization === 'number'
          ? info.utilization * 100
          : info.status === 'rejected'
            ? 100
            : undefined
      if (percent === undefined) return undefined
      const resetsAt = fromEpoch(info.resetsAt)
      const shown: PlanWindow = {
        window,
        percent: Math.min(100, Math.max(0, percent)),
        ...(resetsAt !== undefined && { resetsAt }),
      }
      return [shown]
    },
    costOf,
    keyHelp,
    health: {
      minimumVersion: '2.1.111',
      versionArgs: ['--version'],
      authArgs: ['auth', 'status'],
      auth: claudeAuth,
      signIn: () => 'claude auth login',
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
  request_id?: unknown
  permissionMode?: unknown
  request?: {
    subtype?: unknown
    tool_name?: unknown
    display_name?: unknown
    description?: unknown
    input?: unknown
  }
  hook_event?: unknown
  error?: unknown
  error_status?: unknown
  apiKeySource?: unknown
  rate_limit_info?: unknown
  total_cost_usd?: unknown
  message?: { content?: unknown }
}

function textParts(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = (content as { type?: unknown; text?: unknown }[]).flatMap((part) =>
    part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  )
  return texts.length > 0 ? texts.join('\n') : undefined
}

function parse(line: string): ClaudeLine | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as ClaudeLine) : undefined
  } catch {
    return undefined
  }
}
