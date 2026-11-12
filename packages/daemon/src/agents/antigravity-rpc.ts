import { parseObject, record } from './chat-entries.ts'

export function acpRequests(send: (line: string) => void) {
  let nextId = 0
  const pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  return {
    request(method: string, params: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Antigravity did not answer ${method}`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    },
    receive(line: string): boolean {
      const message = parseObject(line)
      if (!message || message.method !== undefined || typeof message.id !== 'number') return false
      const request = pending.get(message.id)
      if (!request) return false
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error !== undefined) {
        const error = record(message.error)
        request.reject(
          new Error(
            typeof error.message === 'string' ? error.message : 'Antigravity request failed',
          ),
        )
      } else request.resolve(record(message.result))
      return true
    },
    close() {
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('Antigravity connection closed'))
      }
      pending.clear()
    },
  }
}
