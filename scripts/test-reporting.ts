import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import {
  acquireFullRun,
  inheritedLock,
  lockRun,
  runRefusal,
  type SlotOptions,
  smallRunFiles,
} from '../packages/daemon/test/support/suite-lock.ts'
import { DaemonClient } from '../packages/protocol/src/client.ts'
import { readDaemonInfo } from '../packages/protocol/src/daemon-info.ts'
import { tedEnv } from '../packages/protocol/src/env.ts'
import { tedPaths } from '../packages/protocol/src/paths.ts'
import { runTokenFrom } from '../packages/protocol/src/run.ts'
import {
  type TestInvocationReport,
  type TestInvocationUpdate,
  testActivityPulseMs,
  testInvocationId,
} from '../packages/protocol/src/test-invocations.ts'

export type ReportSink = (report: TestInvocationUpdate) => Promise<boolean>

export function testReporter(send: ReportSink) {
  let sequence = 0
  let pending = Promise.resolve(true)
  let waiting = false
  let ended = false
  let liveAvailable = true
  let phase: 'running' | 'waiting' | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const stopPulse = () => {
    if (timer) clearInterval(timer)
    timer = undefined
    phase = undefined
  }
  const deliver = (report: TestInvocationUpdate) => {
    const transient =
      report.kind === 'running' || report.kind === 'waiting' || report.kind === 'inactive'
    pending = pending.then(async (ok) => {
      if (!ok) {
        stopPulse()
        return false
      }
      try {
        if (await send(report)) return true
      } catch {}
      stopPulse()
      if (transient) liveAvailable = false
      return transient
    })
  }
  const pulse = () => {
    if (phase && !ended) deliver({ sequence, kind: phase, at: Date.now() })
  }
  const live = (next: 'running' | 'waiting') => {
    if (!liveAvailable) return
    phase = next
    pulse()
    timer ??= setInterval(pulse, testActivityPulseMs)
    timer.unref()
  }
  const emit = (kind: TestInvocationReport['kind'], at: number) => {
    if (ended) return
    const terminal = kind === 'finished' || kind === 'canceled' || kind === 'interrupted'
    if (sequence >= 63 && !terminal) {
      deliver({ sequence, kind: 'inactive', at: Date.now() })
      ended = true
      stopPulse()
      return
    }
    ended = terminal
    if (terminal) stopPulse()
    deliver({ sequence: sequence++, kind, at })
  }
  return {
    contention(next: boolean, at: number) {
      if (ended || waiting === next) return
      waiting = next
      emit(next ? 'wait-start' : 'wait-end', at)
      if (next && !ended) live('waiting')
      else stopPulse()
    },
    async running() {
      if (!ended && !waiting) live('running')
      await pending
    },
    async finish() {
      if (waiting && !ended) {
        deliver({ sequence, kind: 'inactive', at: Date.now() })
        ended = true
      } else emit('finished', Date.now())
      stopPulse()
      await pending
    },
    async incomplete() {
      if (!ended) deliver({ sequence, kind: 'inactive', at: Date.now() })
      ended = true
      stopPulse()
      await pending
    },
  }
}

export async function runnerReporter(
  label: 'Vitest' | 'pnpm check',
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReturnType<typeof testReporter> | undefined> {
  try {
    const home = tedEnv('TED_HOME', env)
    const token = runTokenFrom(env)
    const task = tedEnv('TED_TASK', env)
    if (!home || !token || !task) return undefined
    if (!(await lstat(tedPaths(home).daemonInfo)).isFile()) return undefined
    const info = await readDaemonInfo(home)
    if (!info || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535)
      return undefined
    let id: string
    let reportingToken: string
    if (token.startsWith('test-report:')) {
      id = testInvocationId(token.split(':')[1])
      reportingToken = token
    } else {
      if (!tedEnv('TED_RUN', env)) return undefined
      const registration = await new DaemonClient(info, token).tryRegisterTestInvocation(task, {
        id: randomUUID(),
        supported: true,
        label,
      })
      if (!registration) return undefined
      id = registration.invocation.id
      reportingToken = registration.token
    }
    const client = new DaemonClient(info, reportingToken)
    return testReporter((report) => client.reportTestInvocation(id, report))
  } catch {
    return undefined
  }
}

export async function reportedTestLock(
  files: number | 'check',
  options: SlotOptions = {},
  reporter?: ReturnType<typeof testReporter>,
): Promise<(() => Promise<void>) | undefined> {
  const refusal = files === 'check' ? undefined : runRefusal(files)
  if (refusal) throw new Error(refusal)
  if (await inheritedLock(files === 'check' ? smallRunFiles : files, options)) return undefined
  const reporting = reporter ?? (await runnerReporter(files === 'check' ? 'pnpm check' : 'Vitest'))
  const acquireOptions = {
    ...options,
    onContention(waiting: boolean, at: number) {
      reporting?.contention(waiting, at)
      options.onContention?.(waiting, at)
    },
  }
  try {
    const release =
      files === 'check'
        ? await acquireFullRun(acquireOptions)
        : await lockRun(files, acquireOptions)
    if (!release) {
      await reporting?.incomplete()
      return undefined
    }
    await reporting?.running()
    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        await release()
        await reporting?.finish()
      } catch (error) {
        await reporting?.incomplete()
        throw error
      }
    }
  } catch (error) {
    await reporting?.incomplete()
    throw error
  }
}

interface TestLockOwner {
  users: number
  acquisition: Promise<(() => Promise<void>) | undefined>
  closing?: Promise<void>
}

const ownerKey = Symbol.for('ted.vitest.test-lock-owner')

declare global {
  namespace NodeJS {
    interface Process {
      [ownerKey]?: TestLockOwner
    }
  }
}

export async function withProjectTestLock(
  acquire: () => Promise<(() => Promise<void>) | undefined>,
  setup: () => Promise<() => Promise<void>>,
): Promise<() => Promise<void>> {
  const previous = process[ownerKey]
  if (previous?.closing) {
    await previous.closing.catch(() => undefined)
    return withProjectTestLock(acquire, setup)
  }
  const owner: TestLockOwner = previous ?? {
    users: 0,
    acquisition: Promise.resolve().then(acquire),
  }
  process[ownerKey] = owner
  owner.users++
  let released = false
  const release = async () => {
    if (released) return
    released = true
    if (--owner.users !== 0) return
    owner.closing = owner.acquisition.then(async (unlock) => {
      await unlock?.()
    })
    try {
      await owner.closing
    } finally {
      if (process[ownerKey] === owner) delete process[ownerKey]
    }
  }
  try {
    await owner.acquisition
    const teardown = await setup()
    return async () => {
      try {
        await teardown()
      } finally {
        await release()
      }
    }
  } catch (error) {
    await release().catch(() => undefined)
    throw error
  }
}
