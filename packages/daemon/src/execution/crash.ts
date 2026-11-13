import { tedEnv } from '@ted/protocol'

export function crashPoint(name: string, env: NodeJS.ProcessEnv = process.env): void {
  if (tedEnv('TED_EXECUTION_CRASH_AT', env) === name) process.kill(process.pid, 'SIGKILL')
}
