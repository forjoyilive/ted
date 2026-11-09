import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readDaemonInfo } from '@ted/protocol'

export async function makeTempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-home-'))
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) }
}

export interface RawResponse {
  status: number
  body: string
}

export function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

export async function tokenFor(home: string): Promise<string> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error(`no daemon.json in ${home}`)
  return info.token
}
