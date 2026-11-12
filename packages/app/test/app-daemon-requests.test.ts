import { expect, test } from 'vitest'
import { launchApp, setUpAppTests } from './app-harness.ts'

setUpAppTests()

test('the real preload permits listed calls and byte uploads while rejecting unlisted and inherited names', async () => {
  const page = await launchApp()
  const result = await page.evaluate(async () => {
    const tasks = await window.ted.request('listTasks')
    const connection = await window.ted.request('connection')
    const denied = []
    for (const name of [
      'constructor',
      '__proto__',
      'toString',
      'subscribe',
      'provesAppKey',
      'shutdown',
      'getReport',
      'request',
      null,
      ['listTasks'],
    ]) {
      try {
        await window.ted.request(name as string)
        denied.push({ name, rejected: false })
      } catch (error) {
        denied.push({ name, rejected: String(error).includes('unknown request') })
      }
    }
    const attachment = (await window.ted.request(
      'uploadAttachment',
      { name: 'hello.txt', mediaType: 'text/plain' },
      new Uint8Array([104, 105]),
    )) as { hash: string; name: string }
    const bytes = await window.ted.request('readAttachment', {
      hash: attachment.hash,
      name: attachment.name,
    })
    return { tasks, connection, denied, bytes }
  })
  expect(result.tasks).toEqual([])
  expect(result.connection).toMatchObject({ state: 'connected' })
  expect(result.denied).toHaveLength(10)
  expect(result.denied.every((item) => item.rejected)).toBe(true)
  expect(result.bytes).toMatchObject({ data: 'aGk=' })
})
