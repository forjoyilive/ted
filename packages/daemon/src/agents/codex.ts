import { fileURLToPath } from 'node:url'
import { type RunState, tedVersion } from '@ted/protocol'
import type { Agent } from './agent.ts'
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

interface CodexLine {
  id?: unknown
  method?: unknown
  params?: {
    thread?: { id?: unknown }
    status?: { type?: unknown; activeFlags?: unknown }
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
    launch({ prompt, env, resume }) {
      const plan: CodexPlan = {
        thread:
          resume === undefined
            ? { method: 'thread/start', params: {} }
            : { method: 'thread/resume', params: { threadId: resume } },
        prompt,
        clientVersion: tedVersion,
      }
      return {
        command: binary,
        args: ['app-server', ...config.flatMap((c) => ['-c', c])],
        env: Object.fromEntries(Object.entries(env).filter(([k]) => !removedEnv.includes(k))),
        input: JSON.stringify(plan),
        files: {},
        driver,
        ...(resume !== undefined && { sessionId: resume }),
      }
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
    sessionIdFrom(line) {
      const message = parse(line)
      if (message?.method !== 'thread/started') return undefined
      const id = message.params?.thread?.id
      return typeof id === 'string' ? id : undefined
    },
  }
}
