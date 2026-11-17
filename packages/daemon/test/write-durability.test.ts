import type http from 'node:http'
import type { Banner } from '@ted/protocol'
import { expect, test } from 'vitest'
import type { Data, Services } from '../src/data.ts'
import { type BaseOptions, listen } from '../src/server.ts'
import { createSlowMonitor } from '../src/slow-moments.ts'
import { api } from './helpers.ts'

async function serve(services: Partial<Services>): Promise<{ server: http.Server; port: number }> {
  const data = { services: async () => services as Services } as Data
  const options: Pick<
    BaseOptions,
    | 'version'
    | 'token'
    | 'appToken'
    | 'appNonces'
    | 'data'
    | 'keepaliveMs'
    | 'runTokens'
    | 'appStreams'
    | 'onShutdown'
    | 'slow'
  > = {
    version: '0.0.0',
    token: 'secret',
    appToken: 'app-key',
    appNonces: new Map(),
    data,
    keepaliveMs: 60_000,
    runTokens: { issue: () => '', verify: () => undefined },
    appStreams: new Set(),
    onShutdown: () => undefined,
    slow: createSlowMonitor({ timer: false }),
  }
  return listen(options as BaseOptions)
}

test('a write route answers only after the store has saved the write', async () => {
  const saved = Promise.withResolvers<void>()
  let answered = false
  const banners: Pick<Services['banners'], 'dismiss'> = { dismiss: () => ({}) as Banner }
  const { server, port } = await serve({
    store: { persisted: () => saved.promise } as Services['store'],
    disk: { cantSave: () => false } as Services['disk'],
    banners: banners as Services['banners'],
  })
  try {
    const reply = api(port, { appKey: 'app-key' })
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
  const banners: Pick<Services['banners'], 'list'> = { list: () => [] }
  const { server, port } = await serve({
    store: { persisted: () => new Promise<void>(() => undefined) } as Services['store'],
    disk: { cantSave: () => false } as Services['disk'],
    banners: banners as Services['banners'],
  })
  try {
    expect((await api(port, 'secret').call('GET', '/banners')).status).toBe(200)
  } finally {
    server.close()
  }
})
