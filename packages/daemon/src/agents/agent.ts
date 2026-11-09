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
    billing?: Billing
  }): AgentLaunch
  message(text: string): string
  steer(text: string): string
  interrupt(): string[]
  boundaryFrom(line: string): boolean
  stateFrom(line: string): RunState | undefined
  permissionPromptFrom(line: string, earlier: EarlierLine): PermissionPrompt | undefined
  permissionClosedFrom(line: string): string | undefined
  autoModeUnavailableFrom(line: string): boolean
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

export function withoutKeys(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  billing: Billing = 'subscription',
): NodeJS.ProcessEnv {
  if (billing === 'api-key') return { ...env }
  return Object.fromEntries(Object.entries(env).filter(([k]) => !names.includes(k)))
}
