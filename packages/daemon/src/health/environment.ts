import { readLoginEnv } from '../cli-env.ts'

export interface Environment {
  current(): NodeJS.ProcessEnv
  reload(): Promise<NodeJS.ProcessEnv>
}

export function createEnvironment(options: {
  loginShell: boolean
  base?: NodeJS.ProcessEnv
}): Environment {
  const base = options.base ?? process.env
  let env: NodeJS.ProcessEnv = { ...base }
  let loading: Promise<NodeJS.ProcessEnv> | undefined

  async function load(): Promise<NodeJS.ProcessEnv> {
    const read = options.loginShell ? await readLoginEnv(base) : { ...base }
    if (base.ELECTRON_RUN_AS_NODE === undefined) delete read.ELECTRON_RUN_AS_NODE
    env = read
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
