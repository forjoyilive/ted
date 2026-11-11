import path from 'node:path'
import { waitUntil } from '../helpers.ts'
import { createExecutionFixture } from '../support/execution-fixture.ts'

const fixture = await createExecutionFixture()
const machine = await fixture.machine('controller')
const factory = await machine.client.addFactory({ repo: machine.origin, key: 'CRASH' })
const task = await machine.client.createTask({
  factory: factory.key,
  title: JSON.stringify({ steps: [{ waitFor: path.join(machine.root, 'never') }] }),
})
await machine.client.startTask(task.id)
await waitUntil(async () => (await machine.agentStarts()) === 1, 'stub Task agent start')
console.log(JSON.stringify({ root: fixture.root, home: machine.home }))
process.exit(7)
