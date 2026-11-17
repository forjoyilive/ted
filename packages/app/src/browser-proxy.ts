import { randomBytes } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from 'node:http'
import { type AddressInfo, BlockList, connect, isIP, isIPv4, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { App, AuthInfo } from 'electron'

const local = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  local.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  local.addSubnet(address, prefix, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped) return isPublicAddress(mapped)
  const version = isIP(address)
  if (version === 4) return !local.check(address, 'ipv4')
  if (version === 6) return !local.check(address, 'ipv6')
  return false
}

export function isOutsideHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false
  return isIP(host) === 0 || isPublicAddress(host)
}

const outsideTypes = new Set(['image', 'font', 'media'])

export function isOutsideMedia(address: string, resourceType: string): boolean {
  if (!outsideTypes.has(resourceType)) return false
  try {
    const url = new URL(address)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      isOutsideHost(url.hostname)
    )
  } catch {
    return false
  }
}

export interface GuestProxy {
  port: number
  username: string
  password: string
  close(): Promise<void>
}

export interface GuestProxyOptions {
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  connect?: (port: number, address: string) => Socket
}

export async function startGuestProxy(options: GuestProxyOptions = {}): Promise<GuestProxy> {
  const username = 'ted'
  const password = randomBytes(24).toString('hex')
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const resolve = options.lookup ?? ((hostname) => lookup(hostname, { all: true }))
  const open = options.connect ?? ((port, address) => connect(port, address))
  const publicAddress = async (hostname: string) => {
    const host = hostname.replace(/^\[(.*)\]$/, '$1')
    if (!isOutsideHost(host)) return undefined
    const addresses = isIP(host) ? [host] : (await resolve(host)).map((entry) => entry.address)
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) return undefined
    return addresses.find(isIPv4) ?? addresses[0]
  }
  const authorized = (message: IncomingMessage) =>
    message.headers['proxy-authorization'] === expected
  const challenge =
    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Ted"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const refuse = (status: number) => {
      if (!outgoing.headersSent) outgoing.writeHead(status, { 'content-length': 0 })
      outgoing.end()
    }
    if (!authorized(incoming)) {
      outgoing.writeHead(407, { 'proxy-authenticate': 'Basic realm="Ted"', 'content-length': 0 })
      outgoing.end()
      return
    }
    let target: URL
    try {
      target = new URL(incoming.url ?? '')
    } catch {
      return refuse(400)
    }
    if (
      target.protocol !== 'http:' ||
      target.username ||
      target.password ||
      (incoming.method !== 'GET' && incoming.method !== 'HEAD')
    ) {
      return refuse(403)
    }
    void publicAddress(target.hostname).then(
      (address) => {
        if (!address) return refuse(403)
        const port = Number(target.port || 80)
        const headers: IncomingHttpHeaders = { ...incoming.headers, host: target.host }
        delete headers['proxy-authorization']
        delete headers['proxy-connection']
        const upstream = request(
          {
            method: incoming.method,
            path: `${target.pathname}${target.search}`,
            headers,
            setHost: false,
            agent: false,
            createConnection: () => open(port, address),
          },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers)
            response.pipe(outgoing)
          },
        )
        upstream.on('error', () => refuse(502))
        upstream.end()
      },
      () => refuse(502),
    )
  })
  server.on('connect', (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy())
    if (!authorized(incoming)) {
      client.end(challenge)
      return
    }
    let target: URL
    try {
      target = new URL(`http://${incoming.url ?? ''}`)
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const port = Number(target.port)
    if (!port || target.pathname !== '/' || target.username || target.password) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
      return
    }
    void publicAddress(target.hostname).then(
      (address) => {
        if (!address) {
          client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
          return
        }
        const upstream = open(port, address)
        upstream.on('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) upstream.write(head)
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on('error', () => {
          if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
          else client.destroy()
        })
        client.on('close', () => upstream.destroy())
      },
      () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'),
    )
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  // SAFETY: a server listening on a TCP host and port reports AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo
  return {
    port,
    username,
    password,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export function guestProxyRules(electronApp: Pick<App, 'on'>): () => Promise<string> {
  let started: Promise<GuestProxy> | undefined
  return async () => {
    started ??= startGuestProxy().then(
      (proxy) => {
        electronApp.on('login', (event, _contents, _details, authInfo: AuthInfo, callback) => {
          if (!authInfo.isProxy || authInfo.host !== '127.0.0.1' || authInfo.port !== proxy.port)
            return
          event.preventDefault()
          callback(proxy.username, proxy.password)
        })
        return proxy
      },
      (error: Error) => {
        started = undefined
        throw error
      },
    )
    return `http://127.0.0.1:${(await started).port}`
  }
}
