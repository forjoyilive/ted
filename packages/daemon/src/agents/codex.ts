import { fileURLToPath } from 'node:url'
import { type PermissionMode, type RunState, tedVersion } from '@ted/protocol'
import type { Agent, AuthCheck, PermissionPrompt } from './agent.ts'
import type { CodexPlan } from './codex-driver.ts'

const driver = fileURLToPath(new URL('./codex-driver.ts', import.meta.url))

const removedEnv = ['CODEX_API_KEY', 'OPENAI_API_KEY']

const sandbox: Record<PermissionMode, string[]> = {
  auto: [
    'sandbox_mode="workspace-write"',
    'approval_policy="on-request"',
    'sandbox_workspace_write.network_access=true',
  ],
  bypass: ['sandbox_mode="danger-full-access"', 'approval_policy="never"'],
}

const environmentPolicy = [
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

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

function promptFrom(message: CodexLine): PermissionPrompt | undefined {
  if (typeof message.method !== 'string') return undefined
  if (typeof message.id !== 'number' && typeof message.id !== 'string') return undefined
  const params = (message.params ?? {}) as Record<string, unknown>
  const reason = text(params.reason)
  const ask = (title: string, command: string): PermissionPrompt => ({
    requestId: String(message.id),
    title,
    command,
    ...(reason !== undefined && { reason }),
  })
  switch (message.method) {
    case 'item/commandExecution/requestApproval':
      return ask(
        params.kind === 'writeStdin'
          ? 'Send input to a running command'
          : params.networkApprovalContext
            ? 'Run a command that needs the network'
            : 'Run a command outside the sandbox',
        text(params.command) ?? 'a command',
      )
    case 'execCommandApproval':
      return ask(
        'Run a command outside the sandbox',
        Array.isArray(params.command) ? params.command.join(' ') : 'a command',
      )
    case 'item/fileChange/requestApproval':
      return ask(
        'Change files',
        text(params.grantRoot) !== undefined ? `write under ${params.grantRoot}` : 'apply a patch',
      )
    case 'applyPatchApproval': {
      const files = Object.keys((params.fileChanges ?? {}) as Record<string, unknown>)
      return ask('Change files', files.length > 0 ? files.join(' ') : 'apply a patch')
    }
    case 'item/permissions/requestApproval': {
      const grant = grantFrom(params.permissions)
      if (!grant) return { ...ask('Get more access', 'access TED can’t show'), refuse: true }
      const parts = [
        ...(grant.network ? ['network access'] : []),
        ...(grant.fileSystem?.write ?? []).map((p) => `write ${p}`),
        ...(grant.fileSystem?.read ?? []).map((p) => `read ${p}`),
      ]
      if (parts.length === 0) return { ...ask('Get more access', 'nothing'), refuse: true }
      return { ...ask('Get more access', parts.join(', ')), input: grant }
    }
  }
  return undefined
}

interface Grant {
  network?: { enabled: true }
  fileSystem?: { read: string[] | null; write: string[] | null }
}

const isEmpty = (value: unknown) =>
  value === null || value === undefined || (Array.isArray(value) && value.length === 0)

const paths = (value: unknown): string[] | null | undefined => {
  if (isEmpty(value)) return null
  return Array.isArray(value) && value.every((p) => typeof p === 'string' && p !== '')
    ? (value as string[])
    : undefined
}

function grantFrom(wanted: unknown): Grant | undefined {
  if (typeof wanted !== 'object' || wanted === null) return undefined
  const { network, fileSystem, ...other } = wanted as Record<string, unknown>
  if (Object.values(other).some((value) => !isEmpty(value))) return undefined
  const grant: Grant = {}
  if (!isEmpty(network)) {
    if (typeof network !== 'object' || network === null) return undefined
    const { enabled, ...rest } = network as Record<string, unknown>
    if (Object.values(rest).some((value) => !isEmpty(value))) return undefined
    if (enabled === true) grant.network = { enabled: true }
    else if (enabled !== false && !isEmpty(enabled)) return undefined
  }
  if (!isEmpty(fileSystem)) {
    if (typeof fileSystem !== 'object' || fileSystem === null) return undefined
    const { read, write, ...rest } = fileSystem as Record<string, unknown>
    if (Object.values(rest).some((value) => !isEmpty(value))) return undefined
    const readPaths = paths(read)
    const writePaths = paths(write)
    if (readPaths === undefined || writePaths === undefined) return undefined
    if (readPaths !== null || writePaths !== null) {
      grant.fileSystem = { read: readPaths, write: writePaths }
    }
  }
  return grant
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
    launch({ prompt, env, resume, model, effort, permissions }) {
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
        args: [
          'app-server',
          ...[...sandbox[permissions], ...environmentPolicy].flatMap((c) => ['-c', c]),
        ],
        env: withoutRemoved(env),
        input: JSON.stringify(plan),
        files: {},
        driver,
        ...(resume !== undefined && { sessionId: resume }),
      }
    },
    message: (text) => JSON.stringify({ text }),
    permissionPromptFrom(line) {
      const message = parse(line)
      return message && promptFrom(message)
    },
    permissionClosedFrom(line) {
      const message = parse(line)
      if (message?.method !== 'serverRequest/resolved') return undefined
      const id = (message.params as { requestId?: unknown } | undefined)?.requestId
      return typeof id === 'number' || typeof id === 'string' ? String(id) : undefined
    },
    autoModeUnavailableFrom: () => false,
    permissionReply({ requestId, approved, input, text }) {
      return [
        JSON.stringify({
          permission: { id: requestId, approved, ...(input !== undefined && { grant: input }) },
        }),
        ...(text !== undefined ? [JSON.stringify({ text })] : []),
      ]
    },
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
