import type {
  AgentKind,
  ChatDiff,
  ChatToolStatus,
  ConversationEntry,
  Effort,
  PermissionMode,
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
  }): AgentLaunch
  message(text: string): string
  stateFrom(line: string): RunState | undefined
  permissionPromptFrom(line: string, earlier: EarlierLine): PermissionPrompt | undefined
  permissionClosedFrom(line: string): string | undefined
  autoModeUnavailableFrom(line: string): boolean
  permissionReply(reply: PermissionReply): string[]
  chat(entries: readonly ConversationEntry[], cwd: string): AgentChatEntry[]
  acceptedTextFrom(line: string): string | undefined
  sessionIdFrom(line: string): string | undefined
  problemFrom(line: string): RunProblem | undefined
  tokensFrom(line: string): TokenCount | undefined
  authErrorFrom(line: string): boolean
  environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  health: AgentHealthSpec
}
