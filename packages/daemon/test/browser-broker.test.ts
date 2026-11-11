import type { TaskApp } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import { createBrowserBroker } from '../src/tasks/browser.ts'

const app: TaskApp = {
  name: 'Web',
  repo: 'widgets',
  kind: 'web',
  state: 'running',
  url: 'http://localhost:3000/',
  startedAt: 'today',
}
const brokers: ReturnType<typeof createBrowserBroker>[] = []
afterEach(() => {
  for (const broker of brokers) broker.close()
  brokers.length = 0
})

test('a replaced waiting poll cannot take the new owner’s command', async () => {
  const broker = createBrowserBroker()
  brokers.push(broker)
  const obsolete = broker.poll('old-owner')
  await expect(broker.poll('new-owner')).rejects.toThrow(/poll is already waiting/)
  const requesting = broker.request({ taskId: 'one', app, request: { action: 'open' } })
  const result = requesting.then(
    (result) => ({ result }),
    (error: Error) => ({ error: error.message }),
  )
  expect(await obsolete).toBeNull()
  const command = await broker.poll('new-owner')
  if (!command) throw new Error('Missing new owner’s command')
  broker.reply('new-owner', command.id, { result: { text: 'Completed' } })
  expect(await result).toEqual({ result: { text: 'Completed' } })
})
