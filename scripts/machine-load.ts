import { availableParallelism, loadavg } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

export const loadEnv = 'TED_TEST_LOAD'
export const quietEnv = 'TED_CHECK_WAIT_FOR_QUIET'
export const quietFlag = '--wait-for-quiet'
export const busyAbove = 0.75
export const quietMaxWaitMs = 30 * 60_000
export const quietPollMs = 10_000
export const quietReportMs = 60_000

// The 1-minute load average per core. TED_TEST_LOAD=off gives undefined (the load is ignored)
// and a number there is used in place of the machine's own figure.
export function loadPerCore(
  env: NodeJS.ProcessEnv = process.env,
  read: () => number = () => (loadavg()[0] ?? 0) / availableParallelism(),
): number | undefined {
  const value = env[loadEnv]
  if (value === 'off') return undefined
  const given = value ? Number(value) : Number.NaN
  const load = Number.isFinite(given) && given >= 0 ? given : read()
  return Math.round(load * 100) / 100
}

export function busy(load: number | undefined): load is number {
  return load !== undefined && load > busyAbove
}

export function scaledWorkers(idle: number, load: number | undefined): number {
  if (!busy(load)) return idle
  return Math.max(1, Math.min(idle, Math.round((idle * busyAbove) / load)))
}

export function busyLine(load: number, chosen: string, idle: string): string {
  return `The machine is busy (load per core ${load.toFixed(2)}, and more than ${busyAbove} counts as busy): running ${chosen} instead of ${idle}, so fewer test files run at once.`
}

// The value is `--wait-for-quiet`, `--wait-for-quiet=<minutes>` or the same in
// TED_CHECK_WAIT_FOR_QUIET (`1`, `on` or minutes). The flag wins.
export function quietWaitMs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const flag = args.find((arg) => arg === quietFlag || arg.startsWith(`${quietFlag}=`))
  const value = flag === undefined ? env[quietEnv] : (flag.split('=')[1] ?? 'on')
  if (value === undefined || value === '' || value === 'off' || value === '0') return undefined
  const minutes = Number(value)
  if (value === 'on' || value === '1' || !Number.isFinite(minutes) || minutes < 0)
    return quietMaxWaitMs
  return minutes * 60_000
}

export type QuietStep = 'start' | 'wait' | 'give-up'

export function quietStep(
  load: number | undefined,
  waitedMs: number,
  maxWaitMs: number,
): QuietStep {
  if (!busy(load)) return 'start'
  return waitedMs >= maxWaitMs ? 'give-up' : 'wait'
}

const minutes = (ms: number) => {
  const [value, unit] =
    ms < 60_000 ? [Math.round(ms / 1000), 'second'] : [Math.round(ms / 60_000), 'minute']
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}

export interface QuietOptions {
  maxWaitMs?: number
  pollMs?: number
  reportMs?: number
  read?: () => number | undefined
  now?: () => number
  pause?: (ms: number) => Promise<unknown>
  log?: (line: string) => void
}

export async function waitForQuiet(
  options: QuietOptions = {},
): Promise<{ waitedMs: number; quiet: boolean }> {
  const maxWaitMs = options.maxWaitMs ?? quietMaxWaitMs
  const pollMs = options.pollMs ?? quietPollMs
  const reportMs = options.reportMs ?? quietReportMs
  const read = options.read ?? (() => loadPerCore())
  const now = options.now ?? Date.now
  const pause = options.pause ?? ((ms: number) => sleep(ms))
  const log = options.log ?? ((line: string) => console.log(line))
  const started = now()
  let reported: number | undefined
  for (;;) {
    const load = read()
    const waitedMs = now() - started
    const step = quietStep(load, waitedMs, maxWaitMs)
    if (step === 'start') {
      if (reported !== undefined)
        log(`The machine is quiet (load per core ${load?.toFixed(2)}) after ${minutes(waitedMs)}.`)
      return { waitedMs, quiet: true }
    }
    if (step === 'give-up') {
      log(
        `Warning: the machine is still busy after ${minutes(waitedMs)} (load per core ${load?.toFixed(2)}). Starting the tests anyway.`,
      )
      return { waitedMs, quiet: false }
    }
    if (reported === undefined) {
      log(
        `Waiting for the machine to be quiet: load per core is ${load?.toFixed(2)}, and the tests start at ${busyAbove} or below, or after ${minutes(maxWaitMs)}…`,
      )
      reported = waitedMs
    } else if (waitedMs - reported >= reportMs) {
      log(`Still waiting after ${minutes(waitedMs)}: load per core is ${load?.toFixed(2)}.`)
      reported = waitedMs
    }
    await pause(Math.min(pollMs, Math.max(1, maxWaitMs - waitedMs)))
  }
}
