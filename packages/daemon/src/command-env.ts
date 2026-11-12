import { filterTedEnv } from '@ted/protocol'
import { readLoginEnv } from './cli-env.ts'

export interface Environment {
  current(): NodeJS.ProcessEnv
  reload(): Promise<NodeJS.ProcessEnv>
}

export function createEnvironment(options: {
  loginShell: boolean
  base?: NodeJS.ProcessEnv
}): Environment {
  const base = filterTedEnv(options.base ?? process.env)
  let env: NodeJS.ProcessEnv = { ...base }
  let loading: Promise<NodeJS.ProcessEnv> | undefined

  async function load(): Promise<NodeJS.ProcessEnv> {
    const read = options.loginShell ? await readLoginEnv(base) : { ...base }
    if (base.ELECTRON_RUN_AS_NODE === undefined) delete read.ELECTRON_RUN_AS_NODE
    env = filterTedEnv(read)
    return env
  }

  return {
    current: () => env,
    reload() {
      loading ??= load().finally(() => {
        loading = undefined
      })
      return loading
    },
  }
}

// The daemon has no terminal, so a credential prompt would wait forever.
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_TERMINAL_PROMPT: '0' }
}

export function loginShell(env: NodeJS.ProcessEnv): string {
  const given = env.SHELL
  if (given?.startsWith('/')) return given
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

export function ghEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
}

const agentCredentials = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
]

export function worktreeCommandEnv(
  repoEnv: Record<string, string>,
  set: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(base).filter(([name]) => {
      const upper = name.toUpperCase()
      return (
        !upper.startsWith('TED_') &&
        upper !== 'ELECTRON_RUN_AS_NODE' &&
        !agentCredentials.includes(upper)
      )
    }),
  )
  return { ...inherited, ...repoEnv, ...set }
}
