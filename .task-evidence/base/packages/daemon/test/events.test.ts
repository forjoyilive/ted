import http from 'node:http'
import { type DaemonClient, type DaemonEvent, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { appClient, makeTempHome, tokenFor } from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await cleanup()
})

async function client(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, daemon?.appToken)
}

function nextEvent(events: DaemonEvent[], count: number): Promise<void> {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (events.length >= count) {
        clearInterval(check)
        resolve()
      }
    }, 10)
  })
}

describe('daemon events', () => {
  test('a subscribed client receives task-created when a Task is created', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const ted = await client()
    const events: DaemonEvent[] = []
    const subscription = await ted.subscribe((event) => events.push(event))

    const task = await ted.createTask({ title: 'Fix login' })
    await nextEvent(events, 1)
    subscription.close()

    expect(events).toEqual([{ type: 'task-created', task }])
  })

  test('the daemon stops while a client is still subscribed', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    await (await client()).subscribe(() => {})

    const stopped = daemon.stop().then(() => 'stopped')
    daemon = undefined
    const timeout = new Promise((resolve) => setTimeout(resolve, 2_000, 'timed out'))

    expect(await Promise.race([stopped, timeout])).toBe('stopped')
  })

  test('a quiet stream gets keepalives so the client stays connected', async () => {
    daemon = await startDaemon({ home, version: '9.9.9', keepaliveMs: 50 })
    const token = await tokenFor(home)

    const received = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: daemon?.port,
          path: '/events',
          headers: { authorization: `Bearer ${token}` },
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            body += chunk
          })
          setTimeout(() => {
            req.destroy()
            resolve(body)
          }, 300)
        },
      )
      req.on('error', reject)
    })

    expect(received).toContain('\n\n: keepalive\n\n')
  })

  test('the client skips keepalives and still receives events', async () => {
    daemon = await startDaemon({ home, version: '9.9.9', keepaliveMs: 20 })
    const ted = await client()
    const events: DaemonEvent[] = []
    const subscription = await ted.subscribe((event) => events.push(event))

    await new Promise((resolve) => setTimeout(resolve, 100))
    const task = await ted.createTask({ title: 'Fix login' })
    await nextEvent(events, 1)
    subscription.close()

    expect(events).toEqual([{ type: 'task-created', task }])
  })
})
