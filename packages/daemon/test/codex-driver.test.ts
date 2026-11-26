import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { JsonObject } from '@ted/protocol/parse'
import { describe, expect, test, vi } from 'vitest'
import { type CodexPlan, drive } from '../src/agents/codex-driver.ts'
import { createAgents } from '../src/agents/index.ts'

describe('Codex text drafting transport', () => {
  test.each(['thread/start', 'thread/resume'] as const)(
    '%s disables configured MCP servers before opening a thread and restricts every turn',
    async (method) => {
      const messages: { id?: number; method: string; params?: Record<string, unknown> }[] = []
      const stop = vi.fn()
      const plan: CodexPlan = {
        thread: { method, params: method === 'thread/resume' ? { threadId: 'thread' } : {} },
        prompt: 'Draft instructions',
        clientVersion: 'test',
        model: 'test-model',
        textOnly: true,
      }
      const driver = drive({
        input: JSON.stringify(plan),
        stop,
        send(line) {
          const message = JSON.parse(line)
          messages.push(message)
          if (message.id === undefined) return
          const result =
            message.method === 'config/read'
              ? {
                  config: {
                    mcp_servers: {
                      external: { command: 'never-run' },
                      'other.server': { url: 'https://example.invalid' },
                    },
                  },
                }
              : message.method === method
                ? { thread: { id: 'thread' } }
                : message.method === 'turn/start'
                  ? { turn: { id: 'turn' } }
                  : {}
          queueMicrotask(() => driver.onLine(JSON.stringify({ id: message.id, result })))
        },
      })
      await vi.waitFor(() =>
        expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(1),
      )
      expect(messages.find((m) => m.method === method)?.params).toMatchObject({
        sandbox: 'read-only',
        approvalPolicy: 'never',
        config: {
          mcp_servers: { external: { enabled: false }, 'other.server': { enabled: false } },
        },
      })
      driver.onLine(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn' } } }))
      driver.onInput?.(JSON.stringify({ text: 'Continue drafting' }))
      await vi.waitFor(() =>
        expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(2),
      )
      for (const message of messages.filter((m) => m.method === 'turn/start')) {
        expect(message.params).toMatchObject({
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly' },
        })
      }
      expect(stop).not.toHaveBeenCalled()
    },
  )

  test.each([{ error: { code: -1 } }, { result: {} }])(
    'refuses to open a text-only thread if effective configuration cannot be read: %j',
    async (response) => {
      const methods: string[] = []
      const stop = vi.fn()
      const driver = drive({
        input: JSON.stringify({
          thread: { method: 'thread/start', params: {} },
          prompt: 'Draft',
          clientVersion: 'test',
          textOnly: true,
        }),
        stop,
        send(line) {
          const message = JSON.parse(line)
          methods.push(message.method)
          if (message.id !== undefined)
            queueMicrotask(() =>
              driver.onLine(
                JSON.stringify({
                  id: message.id,
                  ...(message.method === 'config/read' ? response : { result: {} }),
                }),
              ),
            )
        },
      })
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
      expect(methods).not.toContain('thread/start')
      expect(methods).not.toContain('turn/start')
    },
  )
})

describe('Codex persistent storage', () => {
  test('a new Run resuming a thread keeps its private home even without the original Run folder', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'ted-codex-storage-'))
    try {
      const agent = createAgents({ home }).get('codex')
      const launch = agent.launch({
        prompt: 'Hello',
        runDir: path.join(home, 'old-run'),
        env: {},
        permissions: 'auto',
      })
      const stop = vi.fn()
      let turnStarted = false
      const driver = drive({
        input: launch.input,
        stop,
        send(line) {
          const message = JSON.parse(line)
          if (message.id === undefined) return
          if (message.method === 'turn/start') turnStarted = true
          const result =
            message.method === 'thread/start'
              ? { thread: { id: 'private-thread' } }
              : message.method === 'turn/start'
                ? { turn: { id: 'turn' } }
                : {}
          queueMicrotask(() => driver.onLine(JSON.stringify({ id: message.id, result })))
        },
      })
      await vi.waitFor(() => expect(turnStarted).toBe(true))
      expect(stop).not.toHaveBeenCalled()
      const resumed = createAgents({ home })
        .get('codex')
        .launch({
          prompt: 'Continue',
          runDir: path.join(home, 'new-run'),
          env: { CODEX_HOME: '/personal/codex', CODEX_SQLITE_HOME: '/personal/db' },
          resume: 'private-thread',
          permissions: 'auto',
        })
      expect(resumed.env).toMatchObject({
        CODEX_HOME: path.join(home, 'codex'),
        CODEX_SQLITE_HOME: path.join(home, 'codex'),
      })
      expect(JSON.parse(resumed.input).thread).toEqual({
        method: 'thread/resume',
        params: { threadId: 'private-thread' },
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('Codex turn ids', () => {
  test('a late turn/completed from an earlier turn leaves the live turn to steer and interrupt', async () => {
    const messages: { id?: number; method: string; params?: JsonObject }[] = []
    let turns = 0
    const driver = drive({
      input: JSON.stringify({
        thread: { method: 'thread/start', params: {} },
        prompt: 'First',
        clientVersion: 'test',
      }),
      stop: vi.fn(),
      send(line) {
        const message = JSON.parse(line)
        messages.push(message)
        if (message.id === undefined) return
        const result =
          message.method === 'thread/start'
            ? { thread: { id: 'thread' } }
            : message.method === 'turn/start'
              ? { turn: { id: `turn-${++turns}` } }
              : {}
        queueMicrotask(() => driver.onLine(JSON.stringify({ id: message.id, result })))
      },
    })
    const started = (n: number) =>
      vi.waitFor(() => expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(n))
    await started(1)
    driver.onLine(JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-1' } } }))
    driver.onLine(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } }))
    driver.onInput?.(JSON.stringify({ text: 'Second' }))
    await started(2)
    driver.onLine(JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-2' } } }))
    driver.onLine(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } }))

    driver.onInput?.(JSON.stringify({ text: 'Steer', steer: true }))
    driver.onInput?.(JSON.stringify({ interrupt: true }))
    await vi.waitFor(() => expect(messages.map((m) => m.method)).toContain('turn/interrupt'))
    expect(messages.find((m) => m.method === 'turn/steer')?.params).toMatchObject({
      expectedTurnId: 'turn-2',
    })
    expect(messages.find((m) => m.method === 'turn/interrupt')?.params).toMatchObject({
      turnId: 'turn-2',
    })
    expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(2)
  })
})
