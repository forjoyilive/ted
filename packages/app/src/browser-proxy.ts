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
import type { App, AuthInfo, Net, WebContents } from 'electron'

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
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  local.addSubnet(address, prefix, 'ipv6')
}

// BlockList also checks IPv4-mapped IPv6 addresses against the IPv4 rules, and IPv4 addresses
// against IPv6 rules in mapped form, so a ::ffff:0:0/96 rule would block every IPv4 address.
export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return !local.check(address, 'ipv4')
  if (version !== 6 || address.includes('%')) return false
  const embedded = embeddedIPv4(address)
  if (embedded) return isPublicAddress(embedded)
  return !local.check(address, 'ipv6')
}

function ipv6Groups(address: string): number[] {
  const hex = new URL(`http://[${address}]`).hostname.slice(1, -1)
  const [head = '', tail = ''] = hex.split('::')
  const parse = (part: string) =>
    part ? part.split(':').map((group) => Number.parseInt(group, 16)) : []
  const front = parse(head)
  const back = parse(tail)
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back]
}

// NAT64 (64:ff9b::/96) and 6to4 (2002::/16) gateways connect to the IPv4 address inside the IPv6 one.
function embeddedIPv4(address: string): string | undefined {
  const groups = ipv6Groups(address)
  const quad = (high: number, low: number) => [high >> 8, high & 255, low >> 8, low & 255].join('.')
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  )
    return quad(groups[6] ?? 0, groups[7] ?? 0)
  if (groups[0] === 0x2002) return quad(groups[1] ?? 0, groups[2] ?? 0)
  return undefined
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
const signInHost = 'ted-guest-proxy.invalid'
export const guestSignInUrl = `http://${signInHost}/`

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

export function fixedHosts(value: string): (hostname: string) => Promise<LookupAddress[]> {
  const hosts = new Map(
    value.split(',').map((entry) => {
      const [name = '', address = ''] = entry.split('=')
      return [name.trim().toLowerCase(), address.trim()] as const
    }),
  )
  return async (hostname) => {
    const address = hosts.get(hostname.toLowerCase())
    const family = address ? isIP(address) : 0
    return address && family ? [{ address, family }] : []
  }
}

export interface GuestLogin {
  username: string
  password: string
  release(): void
}

export interface GuestProxy {
  port: number
  admit(refused: () => void): GuestLogin
  close(): Promise<void>
}

export interface GuestProxyOptions {
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  connect?: (port: number, address: string) => Socket
}

export async function startGuestProxy(options: GuestProxyOptions = {}): Promise<GuestProxy> {
  const logins = new Map<string, { refused(): void }>()
  const resolve = options.lookup ?? ((hostname) => lookup(hostname, { all: true }))
  const open = options.connect ?? ((port, address) => connect(port, address))
  const publicAddress = async (hostname: string) => {
    const host = hostname.replace(/^\[(.*)\]$/, '$1')
    if (!isOutsideHost(host)) return undefined
    const addresses = isIP(host) ? [host] : (await resolve(host)).map((entry) => entry.address)
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) return undefined
    return addresses.find(isIPv4) ?? addresses[0]
  }
  const authorized = (message: IncomingMessage) => {
    const header = message.headers['proxy-authorization']
    return header === undefined ? undefined : logins.get(header)
  }
  const challenge =
    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Ted"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const refuse = (status: number) => {
      if (!outgoing.headersSent) outgoing.writeHead(status, { 'content-length': 0 })
      outgoing.end()
    }
    const login = authorized(incoming)
    if (!login) {
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
    if (target.hostname === signInHost) return refuse(204)
    if (
      target.protocol !== 'http:' ||
      target.username ||
      target.password ||
      target.port !== '' ||
      (incoming.method !== 'GET' && incoming.method !== 'HEAD')
    ) {
      return refuse(403)
    }
    void publicAddress(target.hostname).then(
      (address) => {
        if (!address) {
          login.refused()
          return refuse(403)
        }
        const headers: IncomingHttpHeaders = { ...incoming.headers, host: target.host }
        delete headers['proxy-authorization']
        delete headers['proxy-connection']
        const upstream = request(
          {
            method: incoming.method,
            path: `${target.pathname}${target.search}`,
            headers,
            setHost: false,
            createConnection: () => open(80, address),
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
    const login = authorized(incoming)
    if (!login) {
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
    if (target.pathname !== '/' || target.username || target.password) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (target.port !== '443') {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      return
    }
    void publicAddress(target.hostname).then(
      (address) => {
        if (!address) {
          login.refused()
          client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
          return
        }
        const upstream = open(443, address)
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
    admit(onRefused) {
      const username = 'ted'
      const password = randomBytes(24).toString('hex')
      const header = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      logins.set(header, { refused: onRefused })
      return { username, password, release: () => logins.delete(header) }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export interface GuestProxyRoute {
  rules: string
  signIn(): Promise<void>
}

export type GuestProxyRules = (
  contents: WebContents,
  refused: () => void,
) => Promise<GuestProxyRoute>

// Chromium never asks for proxy credentials for a page's images, fonts or media; it only reuses
// credentials its session already holds, so each page signs in from the main process first.
export function guestProxyRules(
  electronApp: Pick<App, 'on'>,
  electronNet: Pick<Net, 'request'>,
  options: GuestProxyOptions = {},
): GuestProxyRules {
  let started: Promise<GuestProxy> | undefined
  const logins = new WeakMap<WebContents, GuestLogin>()
  return async (contents, refused) => {
    started ??= startGuestProxy(options).then(
      (proxy) => {
        electronApp.on('login', (event, asking, _details, authInfo: AuthInfo, callback) => {
          if (!authInfo.isProxy || authInfo.host !== '127.0.0.1' || authInfo.port !== proxy.port)
            return
          event.preventDefault()
          const login = asking ? logins.get(asking) : undefined
          if (login) callback(login.username, login.password)
          else callback()
        })
        return proxy
      },
      (error: Error) => {
        started = undefined
        throw error
      },
    )
    const proxy = await started
    logins.get(contents)?.release()
    const login = proxy.admit(refused)
    logins.set(contents, login)
    contents.once('destroyed', () => login.release())
    return {
      rules: `http://127.0.0.1:${proxy.port}`,
      signIn: () =>
        new Promise<void>((resolve) => {
          const request = electronNet.request({
            url: guestSignInUrl,
            session: contents.session,
            useSessionCookies: false,
          })
          request.on('login', (_authInfo, callback) => callback(login.username, login.password))
          request.on('response', (response) => {
            response.on('end', () => resolve())
            response.on('error', () => resolve())
            response.on('data', () => undefined)
          })
          request.on('error', () => resolve())
          request.end()
        }),
    }
  }
}
