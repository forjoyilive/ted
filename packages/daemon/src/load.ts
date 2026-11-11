import { readFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { tedEnv } from '@ted/protocol'

export function machineLoadRatio(): number {
  const fake = tedEnv('TED_LOAD_FILE')
  if (fake) return Number(readFileSync(fake, 'utf8'))
  return (loadavg()[0] ?? 0) / availableParallelism()
}
