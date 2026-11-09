import { fileURLToPath } from 'node:url'
import { isModelName, type PermissionMode, type RunState, tedVersion } from '@ted/protocol'
import type { Agent, AuthCheck, EarlierLine, PermissionPrompt } from './agent.ts'
import { codexChat } from './codex-chat.ts'
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

interface ShownChange {
  path: string
  text: string
}

function changeText(kind: string, body: string, moveTo?: string): string {
  return [`${kind}${moveTo ? ` → ${moveTo}` : ''}`, body].filter((part) => part !== '').join('\n')
}

function itemChanges(earlier: EarlierLine, itemId: unknown): ShownChange[] | undefined {
  if (typeof itemId !== 'string') return undefined
  const found = earlier((line) => {
    const message = parse(line)
    const item = (message?.params as { item?: { type?: unknown; id?: unknown } } | undefined)?.item
    return (
      (message?.method === 'item/started' || message?.method === 'item/updated') &&
      item?.type === 'fileChange' &&
      item.id === itemId
    )
  })
  const changes = (parse(found ?? '')?.params as { item?: { changes?: unknown } } | undefined)?.item
    ?.changes
  if (!Array.isArray(changes) || changes.length === 0) return undefined
  const shown: ShownChange[] = []
  for (const change of changes as {
    path?: unknown
    diff?: unknown
    kind?: { type?: unknown; move_path?: unknown }
  }[]) {
    if (typeof change.path !== 'string' || typeof change.diff !== 'string') return undefined
    const kind = typeof change.kind?.type === 'string' ? change.kind.type : 'update'
    const moveTo = typeof change.kind?.move_path === 'string' ? change.kind.move_path : undefined
    shown.push({ path: change.path, text: changeText(kind, change.diff, moveTo) })
  }
  return shown
}

function patchChanges(fileChanges: unknown): ShownChange[] | undefined {
  if (typeof fileChanges !== 'object' || fileChanges === null) return undefined
  const shown: ShownChange[] = []
  for (const [file, change] of Object.entries(fileChanges)) {
    const { type, content, unified_diff, move_path } = (change ?? {}) as Record<string, unknown>
    if ((type === 'add' || type === 'delete') && typeof content === 'string') {
      shown.push({ path: file, text: changeText(type, content) })
    } else if (type === 'update' && typeof unified_diff === 'string') {
      shown.push({
        path: file,
        text: changeText(type, unified_diff, typeof move_path === 'string' ? move_path : undefined),
      })
    } else return undefined
  }
  return shown.length > 0 ? shown : undefined
}

function changePrompt(
  base: PermissionPrompt,
  changes: ShownChange[] | undefined,
): PermissionPrompt {
  if (!changes) return { ...base, command: 'changes TED can’t show', refuse: true }
  return {
    ...base,
    command: changes.map((c) => c.path).join(' '),
    details: changes.map((c) => `${c.path}\n${c.text}`).join('\n\n'),
  }
}

const commandFields = new Set([
  'kind',
  'threadId',
  'turnId',
  'itemId',
  'startedAtMs',
  'approvalId',
  'environmentId',
  'reason',
  'networkApprovalContext',
  'command',
  'cwd',
  'commandActions',
  'proposedExecpolicyAmendment',
  'proposedNetworkPolicyAmendments',
])

const legacyCommandFields = new Set([
  'conversationId',
  'callId',
  'approvalId',
  'command',
  'cwd',
  'reason',
  'parsedCmd',
])

const plainArg = /^[A-Za-z0-9_\-./=:@%+,]+$/

function shellLine(argv: readonly string[]): string {
  return argv
    .map((arg) => (plainArg.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(' ')
}

function commandPrompt(
  base: PermissionPrompt,
  cwd: string | undefined,
  network: string | undefined,
): PermissionPrompt {
  const details = [
    ...(cwd !== undefined ? [`Runs in ${cwd}`] : []),
    ...(network !== undefined ? [`Network access to ${network}`] : []),
  ]
  return {
    ...base,
    ...(cwd !== undefined && { cwd }),
    ...(details.length > 0 && { details: details.join('\n') }),
  }
}

function promptFrom(message: CodexLine, earlier: EarlierLine): PermissionPrompt | undefined {
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
    case 'item/commandExecution/requestApproval': {
      const network = params.networkApprovalContext as
        | { host?: unknown; protocol?: unknown }
        | null
        | undefined
      const title = network
        ? 'Run a command that needs the network'
        : 'Run a command outside the sandbox'
      const command = text(params.command)
      const unknown = Object.keys(params).some(
        (key) => !commandFields.has(key) && !isEmpty(params[key]),
      )
      const host = network ? text(network.host) : undefined
      if (
        params.kind === 'writeStdin' ||
        command === undefined ||
        unknown ||
        (network && host === undefined)
      ) {
        return { ...ask(title, command ?? 'a command TED can’t show'), refuse: true }
      }
      return commandPrompt(
        ask(title, command),
        text(params.cwd),
        network && host !== undefined
          ? `${text(network.protocol) ?? 'https'}://${host}`
          : undefined,
      )
    }
    case 'execCommandApproval': {
      const argv = params.command
      const title = 'Run a command outside the sandbox'
      const unknown = Object.keys(params).some(
        (key) => !legacyCommandFields.has(key) && !isEmpty(params[key]),
      )
      if (
        unknown ||
        !Array.isArray(argv) ||
        argv.length === 0 ||
        argv.some((arg) => typeof arg !== 'string')
      ) {
        return { ...ask(title, 'a command TED can’t show'), refuse: true }
      }
      return commandPrompt(ask(title, shellLine(argv as string[])), text(params.cwd), undefined)
    }
    case 'item/fileChange/requestApproval':
      return changePrompt(
        ask('Change files', ''),
        isEmpty(params.grantRoot) ? itemChanges(earlier, params.itemId) : undefined,
      )
    case 'applyPatchApproval':
      return changePrompt(
        ask('Change files', ''),
        isEmpty(params.grantRoot) ? patchChanges(params.fileChanges) : undefined,
      )
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
  result?: { thread?: { id?: unknown } }
  params?: {
    thread?: { id?: unknown }
    status?: { type?: unknown; activeFlags?: unknown }
    error?: { message?: unknown; codexErrorInfo?: unknown }
    turn?: { error?: unknown }
    item?: { type?: unknown; content?: unknown; text?: unknown }
    tokenUsage?: { total?: { inputTokens?: unknown; outputTokens?: unknown } }
  }
}

const toolItems = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
])

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
      if (model !== undefined && !isModelName(model)) {
        throw new Error(`“${model}” isn’t a model name`)
      }
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
    steer: (text) => JSON.stringify({ text, steer: true }),
    interrupt: () => [JSON.stringify({ interrupt: true })],
    boundaryFrom(line) {
      const message = parse(line)
      if (message?.method !== 'item/completed') return false
      const type = message.params?.item?.type
      return typeof type === 'string' && toolItems.has(type)
    },
    permissionPromptFrom(line, earlier) {
      const message = parse(line)
      return message && promptFrom(message, earlier)
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
    agentTextFrom(line) {
      const message = parse(line)
      if (message?.method !== 'item/completed') return undefined
      const item = message.params?.item
      return item?.type === 'agentMessage' && typeof item.text === 'string' ? item.text : undefined
    },
    sessionContinuedFrom(line) {
      const message = parse(line)
      return (
        typeof message?.result?.thread?.id === 'string' ||
        (message?.method === 'thread/started' && typeof message.params?.thread?.id === 'string')
      )
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
