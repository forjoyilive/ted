import { describe, expect, test, vi } from 'vitest'
import { type CodexPlan, drive } from '../src/agents/codex-driver.ts'

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
