import type http from 'node:http'
import { expect, test } from 'vitest'
import type { Data, Services } from '../src/data.ts'
import { type BaseOptions, listen } from '../src/server.ts'
import { api } from './helpers.ts'

async function serve(services: Partial<Services>): Promise<{ server: http.Server; port: number }> {
  const data = { services: async () => services as Services } as unknown as Data
  return listen({
    version: '0.0.0',
    token: 'secret',
    data,
    keepaliveMs: 60_000,
    runTokens: { verify: () => undefined },
    appStreams: new Set(),
    onShutdown: () => undefined,
  } as unknown as BaseOptions)
}

test('a write route answers only after the store has saved the write', async () => {
  const saved = Promise.withResolvers<void>()
  let answered = false
  const { server, port } = await serve({
    store: { persisted: () => saved.promise } as unknown as Services['store'],
    disk: { cantSave: () => false } as unknown as Services['disk'],
    banners: { dismiss: () => ({}) } as unknown as Services['banners'],
  })
  try {
    const reply = api(port, 'secret')
      .call('POST', '/banners/b1/dismiss')
      .then((result) => {
        answered = true
        return result
      })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(answered).toBe(false)

    saved.resolve()

    expect((await reply).status).toBe(200)
  } finally {
    server.close()
  }
})

test('a read route does not wait for the store to save', async () => {
  const { server, port } = await serve({
    store: { persisted: () => new Promise<void>(() => undefined) } as unknown as Services['store'],
    disk: { cantSave: () => false } as unknown as Services['disk'],
    banners: { list: () => [] } as unknown as Services['banners'],
  })
  try {
    expect((await api(port, 'secret').call('GET', '/banners')).status).toBe(200)
  } finally {
    server.close()
  }
})
