import { randomUUID } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { reportedTestLock } from '../../../../scripts/test-reporting.ts'
import { killMarked } from './processes.ts'
import { heldLockEnv } from './suite-lock.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    tedTestRun: string
    tedTestLockPid: number
  }
}

let acquisition: ReturnType<typeof reportedTestLock> | undefined
let users = 0

export default async function setup(project: TestProject) {
  users++
  acquisition ??= reportedTestLock(project.vitest.state.getPaths().length)
  const unlock = await acquisition
  const run = process.env.TED_TEST_RUN_ID || randomUUID()
  project.provide('tedTestRun', run)
  project.provide('tedTestLockPid', Number(process.env[heldLockEnv]) || process.pid)
  return async () => {
    const killed = await killMarked('TED_TEST_RUN', run)
    if (killed.length > 0)
      console.warn(`killed ${killed.length} process(es) the tests left running`)
    if (--users === 0) {
      acquisition = undefined
      await unlock?.()
    }
  }
}
