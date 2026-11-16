import { type Edition, edition, filterTedEnv, tedEnv } from '@ted/protocol'
import { readLoginEnv } from './cli-env.ts'

export interface Environment {
  current(): NodeJS.ProcessEnv
  reload(): Promise<NodeJS.ProcessEnv>
}

export function createEnvironment(options: {
  loginShell: boolean
  base?: NodeJS.ProcessEnv
  edition?: Edition
  readLoginEnv?: (base: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>
}): Environment {
  const which = options.edition ?? edition
  const readLogin = options.readLoginEnv ?? readLoginEnv
  const base = filterTedEnv(options.base ?? process.env, which)
  let env: NodeJS.ProcessEnv = { ...base }
  let loading: Promise<NodeJS.ProcessEnv> | undefined

  async function load(): Promise<NodeJS.ProcessEnv> {
    const read = options.loginShell ? await readLogin(base) : { ...base }
    if (base.ELECTRON_RUN_AS_NODE === undefined) delete read.ELECTRON_RUN_AS_NODE
    env = filterTedEnv(read, which)
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

export function executionEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = [
    'PATH',
    'SHELL',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'APPIMAGE',
    'APPDIR',
    'TED_EXECUTION_CRASH_AT',
    'TED_EXECUTION_HOME',
    'TED_LAB_RUN',
    'TED_LOGIN_SHELL',
    'TED_TEST_RUN',
    'TED_TEST_FILE',
    'TED_EXIT_WITH_PID',
  ]
  return Object.fromEntries(
    Object.entries(base).flatMap(([name, value]) => {
      const kept = name.startsWith('TED_') ? tedEnv(name, base) : value
      return names.includes(name) && kept !== undefined ? [[name, kept]] : []
    }),
  )
}
