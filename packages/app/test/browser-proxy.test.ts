import { createServer, type IncomingHttpHeaders, request } from 'node:http'
import { type AddressInfo, connect, createServer as createTcpServer, type Server } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import {
  fixedHosts,
  type GuestLogin,
  heldLookups,
  isOutsideRequest,
  isPublicAddress,
  isYouTube,
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
  for (const address of [
    '93.184.216.34',
    '2606:2800:220:1::1',
    '::ffff:93.184.216.34',
    '64:ff9b::5db8:d822',
    '64:ff9b::93.184.216.34',
    '2002:5db8:d822::1',
  ])
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
    '64:ff9b::c0a8:101',
    '64:ff9b::192.168.1.1',
    '64:ff9b::7f00:1',
    '2002:c0a8:101::1',
    '64:ff9b:1::5db8:d822',
    '2001:0:4136:e378::1',
    '2001:db8::1',
    'fec0::1',
    '100::1',
    'fe80::1%en0',
    'images.example',
  ])
    expect(isPublicAddress(address), address).toBe(false)
})

test('images, fonts and media from public hosts load; other kinds and local hosts don’t', () => {
  for (const type of ['image', 'font', 'media'])
    expect(isOutsideRequest('https://cdn.example/art.jpg', type, 'GET')).toBe(true)
  expect(isOutsideRequest('http://93.184.216.34/art.jpg', 'image', 'GET')).toBe(true)
  for (const type of ['script', 'stylesheet', 'subFrame', 'mainFrame', 'webSocket', 'ping'])
    expect(isOutsideRequest('https://cdn.example/x', type, 'GET'), type).toBe(false)
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
    expect(isOutsideRequest(url, 'image', 'GET'), url).toBe(false)
})

test('script data requests to public hosts load only when they read', () => {
  for (const method of ['GET', 'HEAD'])
    expect(isOutsideRequest('https://public.radio.co/status', 'xhr', method), method).toBe(true)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    expect(isOutsideRequest('https://public.radio.co/status', 'xhr', method), method).toBe(false)
  expect(isOutsideRequest('http://10.0.0.1/status', 'xhr', 'GET')).toBe(false)
  expect(isOutsideRequest('http://localhost:9/status', 'xhr', 'GET')).toBe(false)
})

test('YouTube’s hosts load anything but a top-level page or a socket, over HTTPS only', () => {
  for (const url of [
    'https://www.youtube.com/iframe_api',
    'https://youtube.com/embed/x',
    'https://www.youtube-nocookie.com/embed/x',
    'https://rr1---sn-abc.googlevideo.com/videoplayback',
    'https://i.ytimg.com/vi/x/hq.jpg',
    'https://yt3.ggpht.com/a.jpg',
    'https://WWW.YOUTUBE.COM./embed/x',
  ])
    expect(isYouTube(url), url).toBe(true)
  for (const url of [
    'http://www.youtube.com/embed/x',
    'https://notyoutube.com/embed/x',
    'https://youtube.com.example/embed/x',
    'https://user:pass@www.youtube.com/embed/x',
  ])
    expect(isYouTube(url), url).toBe(false)
  for (const type of ['subFrame', 'script', 'stylesheet', 'xhr', 'media'])
    expect(isOutsideRequest('https://www.youtube.com/x', type, 'POST'), type).toBe(true)
  for (const type of ['mainFrame', 'webSocket'])
    expect(isOutsideRequest('https://www.youtube.com/x', type, 'GET'), type).toBe(false)
  expect(isOutsideRequest('https://www.google.com/js/th/abc.js', 'script', 'GET')).toBe(true)
  expect(isOutsideRequest('https://www.google.com/js/other.js', 'script', 'GET')).toBe(false)
  expect(isOutsideRequest('https://www.google.com/js/th/abc.js', 'subFrame', 'GET')).toBe(false)
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
    outgoing.statusCode = incoming.url === '/missing' ? 404 : 200
    outgoing.end('image bytes')
  })
  const webPort = await listen(web)
  const tunnel = createTcpServer((socket) => socket.end('tunnel bytes'))
  const tunnelPort = await listen(tunnel)
  const dialed: string[] = []
  const looked: string[] = []
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
    lookup: async (hostname) => {
      looked.push(hostname)
      if (hostname === 'broken.example') throw new Error('DNS server unreachable')
      return names.get(hostname) ?? []
    },
    connect: (port, address) => {
      dialed.push(`${address}:${port}`)
      return connect(port === 443 ? tunnelPort : webPort, '127.0.0.1')
    },
  })
  closers.push(proxy.close)
  const refusals = { count: 0 }
  const login = proxy.admit(() => () => refusals.count++)
  return { proxy: { port: proxy.port, login }, guestProxy: proxy, refusals, seen, dialed, looked }
}

interface Client {
  port: number
  login: GuestLogin
}

const auth = (login: GuestLogin) =>
  `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`

function get(
  proxy: Client,
  url: string,
  options: { method?: string; auth?: boolean; login?: GuestLogin } = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        method: options.method ?? 'GET',
        path: url,
        headers: {
          host: new URL(url).host,
          ...(options.auth !== false && {
            'proxy-authorization': auth(options.login ?? proxy.login),
          }),
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

function tunnel(proxy: Client, target: string, withAuth = true) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      headers: withAuth ? { 'proxy-authorization': auth(proxy.login) } : {},
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

test('the guest proxy forwards plain HTTP only to port 80 and tunnels only to port 443', async () => {
  const { proxy, dialed, looked } = await proxyWithUpstreams()
  expect((await get(proxy, 'http://images.example:80/art.png')).status).toBe(200)
  for (const url of [
    'http://images.example:8080/art.png',
    'http://images.example:443/art.png',
    'http://93.184.216.34:22/art.png',
  ])
    expect((await get(proxy, url)).status, url).toBe(403)
  for (const target of ['images.example:80', 'images.example:8443', '93.184.216.34:22'])
    expect((await tunnel(proxy, target)).status, target).toBe(403)
  expect(looked).toEqual(['images.example'])
  expect(dialed).toEqual(['93.184.216.34:80'])
})

test('the guest proxy tells only the page whose login asked when it refuses a private address', async () => {
  const { proxy, guestProxy, refusals, looked } = await proxyWithUpstreams()
  expect((await get(proxy, 'http://ted-guest-proxy.invalid/', { auth: false })).status).toBe(407)
  expect((await get(proxy, 'http://ted-guest-proxy.invalid/')).status).toBe(204)
  expect(looked).toEqual([])
  expect((await get(proxy, 'http://images.example/art.png')).status).toBe(200)
  expect((await get(proxy, 'http://images.example/missing')).status).toBe(404)
  expect((await get(proxy, 'http://broken.example/art.png')).status).toBe(502)
  expect((await get(proxy, 'http://images.example:8080/art.png')).status).toBe(403)
  expect((await tunnel(proxy, 'images.example:443')).status).toBe(200)
  expect((await tunnel(proxy, 'broken.example:443')).status).toBe(502)
  expect(refusals.count).toBe(0)
  const other = { count: 0 }
  const second = guestProxy.admit(() => () => other.count++)
  expect((await get(proxy, 'http://rebind.example/art.png')).status).toBe(403)
  expect((await tunnel(proxy, 'mixed.example:443')).status).toBe(403)
  expect(refusals.count).toBe(2)
  expect(other.count).toBe(0)
  expect((await get(proxy, 'http://rebind.example/art.png', { login: second })).status).toBe(403)
  expect(other.count).toBe(1)
  second.release()
  expect((await get(proxy, 'http://rebind.example/art.png', { login: second })).status).toBe(407)
  expect(other.count).toBe(1)
  expect(refusals.count).toBe(2)
})

test('a refusal counts for the page that made the request, even when its lookup finishes after navigating', async () => {
  let release: (() => void) | undefined
  const proxy = await startGuestProxy({
    lookup: () =>
      new Promise((resolve) => {
        release = () => resolve([{ address: '10.0.0.1', family: 4 }])
      }),
  })
  closers.push(proxy.close)
  let page = 'first'
  const counted: string[] = []
  const login = proxy.admit(() => {
    const made = page
    return () => counted.push(made)
  })
  const response = get({ port: proxy.port, login }, 'http://private.example/art.png')
  await expect.poll(() => release).toBeTypeOf('function')
  page = 'second'
  release?.()
  expect((await response).status).toBe(403)
  expect(counted).toEqual(['first'])
})

test('a fixed host list resolves only the names it lists, and holds a held name until released', async () => {
  const lookup = fixedHosts(
    'private.example=10.0.0.1, Public.example=93.184.216.34,bad.example=nope',
  )
  expect(await lookup('PRIVATE.example')).toEqual([{ address: '10.0.0.1', family: 4 }])
  expect(await lookup('public.example')).toEqual([{ address: '93.184.216.34', family: 4 }])
  expect(await lookup('bad.example')).toEqual([])
  expect(await lookup('other.example')).toEqual([])
  const held = heldLookups()
  const holding = fixedHosts('held.example=held', held)('Held.example')
  expect(held.waiting).toEqual(['held.example'])
  held.release()
  expect(await holding).toEqual([])
  expect(held.waiting).toEqual([])
})
