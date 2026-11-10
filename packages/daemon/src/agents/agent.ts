import type {
  AgentKind,
  Billing,
  ChatDiff,
  ChatToolStatus,
  ConversationEntry,
  Effort,
  PermissionMode,
  PlanWindow,
  RunProblem,
  RunState,
} from '@ted/protocol'

export interface AgentLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  input: string
  files: Record<string, string>
  driver?: string
  sessionId?: string
}

export interface PermissionPrompt {
  requestId: string
  title: string
  command: string
  details?: string
  cwd?: string
  reason?: string
  input?: unknown
  refuse?: boolean
}

const hiddenRanges: readonly [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
]

const isHidden = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  return hiddenRanges.some(([from, to]) => code >= from && code <= to)
}

export function hidesText(prompt: PermissionPrompt): boolean {
  return [prompt.command, prompt.details ?? '', prompt.cwd ?? ''].some((part) =>
    [...part].some(isHidden),
  )
}

export type EarlierLine = (matches: (line: string) => boolean) => string | undefined

export interface PermissionReply {
  requestId: string
  approved: boolean
  input?: unknown
  text?: string
}

export interface TokenCount {
  input: number
  output: number
  total: boolean
}

export interface AuthCheck {
  signedIn: boolean
  account?: string
  billing?: Billing
}

export type UsageSignal = { limited: true; resetsAt?: string } | { limited: false }

export interface CredentialReport {
  billing: Billing
  source?: string
}

export interface AgentHealthSpec {
  minimumVersion: string
  versionArgs: string[]
  authArgs: string[]
  auth(result: { code: number | null; stdout: string; stderr: string }): AuthCheck
  signIn: string
  update: string
  install: string
}

export type AgentChatEntry =
  | { kind: 'user'; key: string; text: string; at?: string }
  | { kind: 'agent'; key: string; text: string; done: boolean; at?: string }
  | {
      kind: 'tool'
      key: string
      tool: string
      title: string
      status: ChatToolStatus
      detail?: string
      output?: string
      diffs?: ChatDiff[]
      at?: string
      endedAt?: string
    }

export type AutoModeSignal = 'on' | 'unavailable'

export interface Agent {
  kind: AgentKind
  binary: string
  launch(run: {
    prompt: string
    runDir: string
    env: NodeJS.ProcessEnv
    resume?: string
    model?: string
    effort?: Effort
    permissions: PermissionMode
    tools?: 'none'
    billing?: Billing
  }): AgentLaunch
  message(text: string): string
  steer(text: string): string
  interrupt(): string[]
  boundaryFrom(line: string): boolean
  stateFrom(line: string): RunState | undefined
  turnFrom(line: string): 'started' | 'completed' | undefined
  permissionPromptFrom(line: string, earlier: EarlierLine): PermissionPrompt | undefined
  permissionClosedFrom(line: string): string | undefined
  autoModeFrom(line: string): AutoModeSignal | undefined
  permissionReply(reply: PermissionReply): string[]
  chat(entries: readonly ConversationEntry[], cwd: string): AgentChatEntry[]
  acceptedTextFrom(line: string): string | undefined
  agentTextFrom(line: string): string | undefined
  sessionIdFrom(line: string): string | undefined
  sessionContinuedFrom(line: string): boolean
  problemFrom(line: string): RunProblem | undefined
  tokensFrom(line: string): TokenCount | undefined
  authErrorFrom(line: string): boolean
  usageFrom(line: string): UsageSignal | undefined
  retryingFrom(line: string): boolean | undefined
  credentialFrom(line: string): CredentialReport | undefined
  planUsageFrom(line: string): PlanWindow[] | undefined
  costOf(lines: readonly string[], model: string | undefined): number | undefined
  keyHelp(source: string | undefined): string
  environment(env: NodeJS.ProcessEnv, billing: Billing): NodeJS.ProcessEnv
  health: AgentHealthSpec
}

export function fromEpoch(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
    const number = Number(value)
    return Number.isFinite(number) ? fromEpoch(number) : undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return new Date(value > 1e12 ? value : value * 1000).toISOString()
}

const credentialWords = new Set([
  'TOKEN',
  'KEY',
  'APIKEY',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'AUTH',
  'CREDENTIALS',
])

const proxyName = /^(https?|all|no)_proxy$/i

function looksLikeCredential(name: string, value: string | undefined): boolean {
  if (proxyName.test(name) || name.startsWith('GIT_CONFIG_')) return false
  if (
    name
      .toUpperCase()
      .split('_')
      .some((word) => credentialWords.has(word))
  )
    return true
  if (value === undefined) return false
  return (
    /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(value) ||
    /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(value)
  )
}

export function withoutCredentials(
  env: NodeJS.ProcessEnv,
  keep: readonly string[] = [],
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => keep.includes(name) || !looksLikeCredential(name, value),
    ),
  )
}
