import { randomUUID } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { killMarked } from './processes.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    tedTestRun: string
  }
}

export default function setup(project: TestProject) {
  const run = process.env.TED_TEST_RUN_ID || randomUUID()
  project.provide('tedTestRun', run)
  return async () => {
    const killed = await killMarked('TED_TEST_RUN', run)
    if (killed.length > 0)
      console.warn(`killed ${killed.length} process(es) the tests left running`)
  }
}
