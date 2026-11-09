import type { AttachmentBytes } from '@ted/protocol'
import { protocol, type WebContents } from 'electron'

export const prototypeScheme = 'ted-prototype'

const prototypeUrl = /^ted-prototype:\/\/file\/([0-9a-f]{64})\/([^/?#]+)$/

const policy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export function isFigmaLink(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol: scheme, hostname } = new URL(url)
  return scheme === 'https:' && (hostname === 'figma.com' || hostname.endsWith('.figma.com'))
}

export function registerPrototypeScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: prototypeScheme, privileges: { standard: true, secure: true } },
  ])
}

export function servePrototypes(
  read: (file: { hash: string; name: string }) => Promise<AttachmentBytes>,
): void {
  protocol.handle(prototypeScheme, async (request) => {
    const match = prototypeUrl.exec(request.url)
    if (!match?.[1] || !match[2]) return new Response('Not found', { status: 404 })
    try {
      const { data } = await read({ hash: match[1], name: decodeURIComponent(match[2]) })
      return new Response(Buffer.from(data, 'base64'), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': policy,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function keepFramesInPlace(contents: WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (prototypeUrl.test(event.url) || event.url === 'about:srcdoc' || event.url === 'about:blank')
      return
    event.preventDefault()
  })
}
