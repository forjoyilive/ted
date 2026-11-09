import { type Effort, efforts } from '@ted/protocol'
import type { DriveAgent } from '../runs/host-files.ts'

export interface CodexPlan {
  thread: { method: 'thread/start' | 'thread/resume'; params: Record<string, unknown> }
  prompt: string
  clientVersion: string
  model?: string
  effort?: Effort
}

interface RpcMessage {
  id?: number | string
  method?: string
  result?: { thread?: { id?: unknown }; data?: unknown }
  error?: unknown
}

interface ListedModel {
  id?: unknown
  model?: unknown
  isDefault?: unknown
  supportedReasoningEfforts?: { reasoningEffort?: unknown }[]
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
  let effort: Effort | undefined

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
    if (plan.effort !== undefined) effort = clampEffort(plan, await request('model/list', {}))
    const opened = await request(plan.thread.method, {
      ...plan.thread.params,
      ...(plan.model !== undefined && { model: plan.model }),
    })
    const openedId = opened.result?.thread?.id
    if (opened.error !== undefined || typeof openedId !== 'string') return stop()
    threadId = openedId
    if (plan.prompt !== '') {
      const turn = await startTurn(plan.prompt)
      if (turn.error !== undefined) return stop()
    }
    for (const text of pending.splice(0)) void startTurn(text)
  })()

  function startTurn(text: string) {
    return request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(plan.model !== undefined && { model: plan.model }),
      ...(effort !== undefined && { effort }),
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

function clampEffort(plan: CodexPlan, listed: RpcMessage): Effort | undefined {
  const wanted = plan.effort
  if (wanted === undefined) return undefined
  const models = Array.isArray(listed.result?.data) ? (listed.result.data as ListedModel[]) : []
  const model = models.find((m) =>
    plan.model === undefined ? m.isDefault === true : m.model === plan.model || m.id === plan.model,
  )
  const supported = (model?.supportedReasoningEfforts ?? [])
    .map((e) => e.reasoningEffort)
    .filter((e): e is Effort => efforts.includes(e as Effort))
  if (supported.length === 0 || supported.includes(wanted)) return wanted
  const rank = (e: Effort) => efforts.indexOf(e)
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b))
  return sorted.filter((e) => rank(e) < rank(wanted)).at(-1) ?? sorted[0]
}
