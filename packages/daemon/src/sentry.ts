import { randomUUID } from 'node:crypto'

export interface SentryTarget {
  url: string
  key: string
}

export type Post = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>

const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]']

export function sentryTarget(
  dsn: string,
  { allowLoopbackHttp }: { allowLoopbackHttp: boolean },
): SentryTarget | undefined {
  const url = URL.parse(dsn)
  if (!url || url.username === '' || url.password !== '' || url.search !== '') return undefined
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const project = segments.pop()
  if (project === undefined || !/^\d+$/.test(project)) return undefined
  const secure = url.protocol === 'https:'
  const loopbackTest =
    allowLoopbackHttp && url.protocol === 'http:' && loopbackHosts.includes(url.hostname)
  if (!secure && !loopbackTest) return undefined
  const prefix = segments.map((segment) => `/${segment}`).join('')
  return {
    url: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`,
    key: url.username,
  }
}

export function newEventId(): string {
  return randomUUID().replaceAll('-', '')
}

export function envelopeRequest(
  target: SentryTarget,
  version: string,
  body: Uint8Array<ArrayBuffer>,
  timeoutMs: number,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=ted/${version}`,
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  }
}
