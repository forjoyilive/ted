import { randomUUID } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { recordVitestRun } from '../../../../scripts/failure-log.ts'
import { reportedTestLock, withProjectTestLock } from '../../../../scripts/test-reporting.ts'
import { killMarked } from './processes.ts'
import { heldLockEnv } from './suite-lock.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    tedTestRun: string
    tedTestLockPid: number
  }
}

export default async function setup(project: TestProject) {
  return withProjectTestLock(
    () => reportedTestLock(project.vitest.state.getPaths().length),
    async () => {
      const run = process.env.TED_TEST_RUN_ID || randomUUID()
      project.provide('tedTestRun', run)
      project.provide('tedTestLockPid', Number(process.env[heldLockEnv]) || process.pid)
      return async () => {
        recordVitestRun(project.vitest)
        const killed = await killMarked('TED_TEST_RUN', run)
        if (killed.length > 0)
          console.warn(`killed ${killed.length} process(es) the tests left running`)
      }
    },
  )
}
