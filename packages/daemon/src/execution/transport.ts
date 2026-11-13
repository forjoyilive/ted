import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import https from 'node:https'
import tls from 'node:tls'
import type { ExecutionOffer } from '@ted/protocol'
import { certificatePin } from './certificates.ts'

export class ExecutionRefused extends Error {}
export async function executionRequest(
  offer: Pick<ExecutionOffer, 'address' | 'port' | 'controllerPin'>,
  route: string,
  input: unknown,
  options: {
    key?: string
    cert?: string
    signal?: AbortSignal
    timeoutMs?: number
    maxBytes?: number
    onVerified?: () => void
  } = {},
): Promise<unknown> {
  const socket = tls.connect({
    host: offer.address,
    port: offer.port,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    ...(options.key && { key: options.key }),
    ...(options.cert && { cert: options.cert }),
    ...(options.signal && { signal: options.signal }),
  })
  const timeout = setTimeout(
    () =>
      socket.destroy(
        new Error('Connection timed out. Check both Macs are awake and on the same local network.'),
      ),
    options.timeoutMs ?? 15_000,
  )
  let agent: https.Agent | undefined
  try {
    await once(socket, 'secureConnect', options.signal ? { signal: options.signal } : {})
    const raw = socket.getPeerCertificate().raw
    if (!raw || certificatePin(raw) !== offer.controllerPin)
      throw new ExecutionRefused(
        'Controller identity does not match. Get fresh pairing details directly from the main Mac; do not override this check.',
      )
    const cert = new X509Certificate(raw)
    if (Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now())
      throw new ExecutionRefused('Controller certificate is expired or not yet valid')
    clearTimeout(timeout)
    options.onVerified?.()
    agent = new https.Agent({ keepAlive: false })
    agent.createConnection = () => socket
    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: offer.address,
          port: offer.port,
          method: 'POST',
          path: route,
          agent,
          ...(options.signal && { signal: options.signal }),
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = []
          let length = 0
          res.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > (options.maxBytes ?? 32 * 1024))
              res.destroy(new Error('Execution response exceeded limit'))
            else chunks.push(chunk)
          })
          res.on('error', reject)
          res.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
                string,
                unknown
              >
              if (res.statusCode !== 200) {
                const message =
                  typeof value.error === 'string'
                    ? value.error.slice(0, 300)
                    : 'Execution connection refused'
                if (res.statusCode === 403 || res.statusCode === 410 || res.statusCode === 400)
                  reject(new ExecutionRefused(message))
                else reject(new Error(message))
              } else resolve(value)
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      req.setTimeout(options.timeoutMs ?? 15_000, () =>
        req.destroy(new Error('Execution connection timed out')),
      )
      req.on('error', reject)
      req.end(JSON.stringify(input))
    })
  } finally {
    clearTimeout(timeout)
    agent?.destroy()
    socket.destroy()
  }
}
