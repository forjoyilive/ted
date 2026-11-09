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

export const drive: DriveAgent = ({ input, send }) => {
  const plan = JSON.parse(input) as CodexPlan
  const waiting = new Map<number, (message: RpcMessage) => void>()
  let nextId = 0

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
    if (init.error !== undefined) return
    send(JSON.stringify({ method: 'initialized' }))
    const opened = await request(plan.thread.method, plan.thread.params)
    const threadId = opened.result?.thread?.id
    if (typeof threadId !== 'string') return
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: plan.prompt, text_elements: [] }],
    })
  })()

  return {
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
