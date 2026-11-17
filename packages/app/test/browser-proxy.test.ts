import { createServer, type IncomingHttpHeaders, request } from 'node:http'
import { type AddressInfo, connect, createServer as createTcpServer, type Server } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import {
  type GuestProxy,
  isOutsideMedia,
  isPublicAddress,
  startGuestProxy,
} from '../src/browser-proxy.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const listen = async (server: Server | ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  )
  return (server.address() as AddressInfo).port
}

test('only public addresses count as outside hosts', () => {
  for (const address of ['93.184.216.34', '2606:2800:220:1::1', '::ffff:93.184.216.34'])
    expect(isPublicAddress(address), address).toBe(true)
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'images.example',
  ])
    expect(isPublicAddress(address), address).toBe(false)
})

test('images, fonts and media from public hosts load; other kinds and local hosts don’t', () => {
  for (const type of ['image', 'font', 'media'])
    expect(isOutsideMedia('https://cdn.example/art.jpg', type)).toBe(true)
  expect(isOutsideMedia('http://93.184.216.34/art.jpg', 'image')).toBe(true)
  for (const type of ['script', 'stylesheet', 'xhr', 'subFrame', 'mainFrame', 'webSocket', 'ping'])
    expect(isOutsideMedia('https://cdn.example/x', type), type).toBe(false)
  for (const url of [
    'http://localhost:9/art.jpg',
    'http://app.localhost/art.jpg',
    'http://127.0.0.1:4000/art.jpg',
    'http://[::1]:4000/art.jpg',
    'http://192.168.1.10/art.jpg',
    'https://user:pass@cdn.example/art.jpg',
    'file:///etc/passwd',
    'data:image/png;base64,AA==',
  ])
    expect(isOutsideMedia(url, 'image'), url).toBe(false)
})

interface Seen {
  path?: string | undefined
  headers?: IncomingHttpHeaders
}

async function proxyWithUpstreams() {
  const seen: Seen = {}
  const web = createServer((incoming, outgoing) => {
    seen.path = incoming.url
    seen.headers = incoming.headers
    outgoing.end('image bytes')
  })
  const webPort = await listen(web)
  const tunnel = createTcpServer((socket) => socket.end('tunnel bytes'))
  const tunnelPort = await listen(tunnel)
  const dialed: string[] = []
  const names = new Map([
    ['images.example', [{ address: '93.184.216.34', family: 4 }]],
    ['rebind.example', [{ address: '127.0.0.1', family: 4 }]],
    [
      'mixed.example',
      [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    ],
  ])
  const proxy = await startGuestProxy({
    lookup: async (hostname) => names.get(hostname) ?? [],
    connect: (port, address) => {
      dialed.push(`${address}:${port}`)
      return connect(port === 443 ? tunnelPort : webPort, '127.0.0.1')
    },
  })
  closers.push(proxy.close)
  return { proxy, seen, dialed }
}

const auth = (proxy: GuestProxy) =>
  `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`

function get(proxy: GuestProxy, url: string, options: { method?: string; auth?: boolean } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        method: options.method ?? 'GET',
        path: url,
        headers: {
          host: new URL(url).host,
          ...(options.auth !== false && { 'proxy-authorization': auth(proxy) }),
        },
      },
      (response) => {
        let body = ''
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      },
    )
    sent.on('error', reject)
    sent.end()
  })
}

function tunnel(proxy: GuestProxy, target: string, withAuth = true) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      headers: withAuth ? { 'proxy-authorization': auth(proxy) } : {},
    })
    sent.on('connect', (response, socket) => {
      let body = ''
      socket.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      socket.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      socket.on('error', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    sent.on('response', (response) => resolve({ status: response.statusCode ?? 0, body: '' }))
    sent.on('error', reject)
    sent.end()
  })
}

test('the guest proxy forwards to public addresses only, after checking what the name resolves to', async () => {
  const { proxy, seen, dialed } = await proxyWithUpstreams()
  expect(await get(proxy, 'http://images.example/art.png', { auth: false })).toMatchObject({
    status: 407,
  })
  expect(await get(proxy, 'http://images.example/art.png?size=2')).toEqual({
    status: 200,
    body: 'image bytes',
  })
  expect(seen.path).toBe('/art.png?size=2')
  expect(seen.headers).toMatchObject({ host: 'images.example' })
  expect(seen.headers?.['proxy-authorization']).toBeUndefined()
  expect(dialed).toEqual(['93.184.216.34:80'])
  for (const url of [
    'http://rebind.example/art.png',
    'http://mixed.example/art.png',
    'http://unknown.example/art.png',
    'http://127.0.0.1:9/art.png',
    'http://localhost:9/art.png',
  ])
    expect((await get(proxy, url)).status, url).toBe(403)
  expect((await get(proxy, 'http://images.example/form', { method: 'POST' })).status).toBe(403)
  expect(await tunnel(proxy, 'images.example:443', false)).toMatchObject({ status: 407 })
  expect(await tunnel(proxy, 'images.example:443')).toEqual({ status: 200, body: 'tunnel bytes' })
  expect((await tunnel(proxy, 'rebind.example:443')).status).toBe(403)
  expect((await tunnel(proxy, '[::1]:443')).status).toBe(403)
  expect(dialed).toEqual(['93.184.216.34:80', '93.184.216.34:443'])
})
