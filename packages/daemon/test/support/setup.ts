import { randomUUID } from 'node:crypto'
import { afterAll, inject } from 'vitest'
import { killMarked } from './processes.ts'

const file = randomUUID()
process.env.TED_TEST_RUN = inject('tedTestRun')
process.env.TED_TEST_FILE = file
process.env.TED_EXIT_WITH_PID = String(process.pid)

afterAll(async () => {
  const killed = await killMarked('TED_TEST_FILE', file)
  if (killed.length > 0) {
    console.warn(`killed ${killed.length} process(es) this test file left running`)
  }
}, 60_000)
