import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const appAuthScheme = 'TED-App'
export const bodyHashHeader = 'x-ted-body-sha256'
export const responseMacHeader = 'x-ted-mac'

export interface AppAuth {
  at: number
  nonce: string
  mac: string
}

export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

export function bodyHash(body: Uint8Array | string | undefined): string {
  return createHash('sha256')
    .update(body ?? '')
    .digest('hex')
}

const mac = (key: string, ...parts: (string | number)[]) =>
  createHmac('sha256', key).update(parts.join('\n')).digest('hex')

export function requestMac(
  key: string,
  { at, nonce }: Pick<AppAuth, 'at' | 'nonce'>,
  method: string,
  path: string,
  hash: string,
): string {
  return mac(key, 'request', at, nonce, method, path, hash)
}

export function signRequest(
  key: string,
  method: string,
  path: string,
  body: Uint8Array | string | undefined,
  nonce: string = newNonce(),
): Record<string, string> {
  const at = Date.now()
  const hash = bodyHash(body)
  return {
    authorization: `${appAuthScheme} ${at}.${nonce}.${requestMac(key, { at, nonce }, method, path, hash)}`,
    [bodyHashHeader]: hash,
  }
}

export function parseAppAuth(header: string | undefined): AppAuth | undefined {
  const match = /^TED-App (\d{1,16})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(header ?? '')
  if (!match) return undefined
  return { at: Number(match[1]), nonce: match[2] ?? '', mac: match[3] ?? '' }
}

export function daemonProof(key: string, nonce: string, port: number): string {
  return mac(key, 'daemon', nonce, port)
}

export function responseMac(key: string, nonce: string, status: number, hash: string): string {
  return mac(key, 'response', nonce, status, hash)
}

export function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
