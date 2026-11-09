import type { DriveAgent } from '../runs/host-files.ts'

export interface CodexPlan {
  thread: { method: 'thread/start' | 'thread/resume'; params: Record<string, unknown> }
  prompt: string
  clientVersion: string
}

interface RpcMessage {
  id?: number | string
  method?: string
  result?: { thread?: { id?: unknown } }
  error?: unknown
}

const declined: Record<string, unknown> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
  'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
  execCommandApproval: { decision: { denied: { rejection: 'TED declined this request' } } },
  applyPatchApproval: { decision: { denied: { rejection: 'TED declined this request' } } },
}

export const drive: DriveAgent = ({ input, send, stop }) => {
  const plan = JSON.parse(input) as CodexPlan
  const waiting = new Map<number, (message: RpcMessage) => void>()
  let nextId = 0
  let threadId: string | undefined
  const pending: string[] = []

  const request = (method: string, params: unknown) => {
    const id = ++nextId
    send(JSON.stringify({ id, method, params }))
    return new Promise<RpcMessage>((resolve) => waiting.set(id, resolve))
  }

  void (async () => {
    const init = await request('initialize', {
      clientInfo: { name: 'ted', title: 'TED', version: plan.clientVersion },
      capabilities: null,
    })
    if (init.error !== undefined) return stop()
    send(JSON.stringify({ method: 'initialized' }))
    const opened = await request(plan.thread.method, plan.thread.params)
    const openedId = opened.result?.thread?.id
    if (opened.error !== undefined || typeof openedId !== 'string') return stop()
    threadId = openedId
    const turn = await startTurn(plan.prompt)
    if (turn.error !== undefined) return stop()
    for (const text of pending.splice(0)) void startTurn(text)
  })()

  function startTurn(text: string) {
    return request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
  }

  return {
    onInput(line) {
      let text: unknown
      try {
        text = (JSON.parse(line) as { text?: unknown }).text
      } catch {
        return
      }
      if (typeof text !== 'string') return
      if (threadId === undefined) pending.push(text)
      else void startTurn(text)
    },
    onLine(line) {
      let message: RpcMessage
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.id === undefined) return
      if (message.method === undefined) {
        if (typeof message.id !== 'number') return
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
        return
      }
      const result = declined[message.method]
      send(
        JSON.stringify(
          result === undefined
            ? { id: message.id, error: { code: -32601, message: 'TED doesn’t answer this yet' } }
            : { id: message.id, result },
        ),
      )
    },
  }
}
