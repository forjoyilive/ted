import { type Effort, efforts } from '@ted/protocol'
import type { DriveAgent } from '../runs/host-files.ts'
import { rememberCodexSession } from './codex-home.ts'

export interface CodexPlan {
  sessionHome?: string
  textOnly?: boolean
  thread: { method: 'thread/start' | 'thread/resume'; params: Record<string, unknown> }
  prompt: string
  clientVersion: string
  model?: string
  effort?: Effort
}

interface RpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: {
    thread?: { id?: unknown }
    turn?: { id?: unknown }
    data?: unknown
    config?: { mcp_servers?: Record<string, unknown> }
  }
  error?: unknown
}

interface ListedModel {
  id?: unknown
  model?: unknown
  isDefault?: unknown
  supportedReasoningEfforts?: { reasoningEffort?: unknown }[]
}

const declined: Record<string, unknown> = {
  'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
}

const rejection = { denied: { rejection: 'The human denied this request' } }

const replies: Record<string, (approved: boolean, grant: unknown) => unknown> = {
  'item/commandExecution/requestApproval': (approved) => ({
    decision: approved ? 'accept' : 'decline',
  }),
  'item/fileChange/requestApproval': (approved) => ({ decision: approved ? 'accept' : 'decline' }),
  'item/permissions/requestApproval': (approved, grant) => ({
    permissions: approved && typeof grant === 'object' && grant !== null ? grant : {},
    scope: 'turn',
  }),
  execCommandApproval: (approved) => ({ decision: approved ? 'approved' : rejection }),
  applyPatchApproval: (approved) => ({ decision: approved ? 'approved' : rejection }),
}

export const drive: DriveAgent = ({ input, send, stop }) => {
  const plan = JSON.parse(input) as CodexPlan
  const waiting = new Map<number, (message: RpcMessage) => void>()
  let nextId = 0
  let threadId: string | undefined
  const pending: string[] = []
  const queued: string[] = []
  let turnActive = false
  let turnId: string | undefined
  let interruptWanted = false
  let effort: Effort | undefined
  let model = plan.model
  const asking = new Map<string, RpcMessage>()

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
    void request('account/read', { refreshToken: false })
    void request('account/rateLimits/read', undefined)
    const resumingOnDefault = plan.thread.method === 'thread/resume' && model === undefined
    if (plan.effort !== undefined || resumingOnDefault) {
      const models = listedModels(await request('model/list', {}))
      if (resumingOnDefault) model = defaultModel(models)
      effort = clampEffort(models, model, plan.effort)
    }
    let config: Record<string, unknown> | undefined
    if (plan.textOnly) {
      const read = await request('config/read', { cwd: process.cwd(), includeLayers: false })
      if (read.error !== undefined || !read.result?.config) return stop()
      // Empty tables merge with inherited MCP settings, so disable each configured server.
      config = {
        mcp_servers: Object.fromEntries(
          Object.keys(read.result.config.mcp_servers ?? {}).map((name) => [
            name,
            { enabled: false },
          ]),
        ),
      }
    }
    const opened = await request(plan.thread.method, {
      ...plan.thread.params,
      ...(plan.textOnly && { sandbox: 'read-only', approvalPolicy: 'never', config }),
      ...(model !== undefined && { model }),
    })
    const openedId = opened.result?.thread?.id
    if (opened.error !== undefined || typeof openedId !== 'string') return stop()
    threadId = openedId
    if (plan.sessionHome !== undefined) {
      try {
        rememberCodexSession(plan.sessionHome, openedId)
      } catch {
        return stop()
      }
    }
    if (plan.prompt === '') interruptWanted = false
    if (plan.prompt !== '') {
      const turn = await startTurn(plan.prompt)
      if (turn.error !== undefined) return stop()
    }
    for (const text of pending.splice(0)) queueTurn(text)
  })()

  const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }]

  async function startTurn(text: string) {
    turnActive = true
    turnId = undefined
    const started = await request('turn/start', {
      threadId,
      input: textInput(text),
      ...(plan.textOnly && { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never' }),
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
    })
    if (started.error !== undefined) {
      turnActive = false
      nextTurn()
    } else if (typeof started.result?.turn?.id === 'string' && turnActive) {
      turnId ??= started.result.turn.id
      interruptIfWanted()
    }
    return started
  }

  async function steer(text: string) {
    if (!turnActive || turnId === undefined) return queueTurn(text)
    const steered = await request('turn/steer', {
      threadId,
      input: textInput(text),
      expectedTurnId: turnId,
    })
    if (steered.error !== undefined) queueTurn(text)
  }

  function interrupt() {
    if (turnActive && turnId !== undefined) void request('turn/interrupt', { threadId, turnId })
    else if (threadId === undefined || turnActive) interruptWanted = true
  }

  function interruptIfWanted() {
    if (!interruptWanted || !turnActive || turnId === undefined) return
    interruptWanted = false
    void request('turn/interrupt', { threadId, turnId })
  }

  function queueTurn(text: string) {
    queued.push(text)
    nextTurn()
  }

  function nextTurn() {
    if (turnActive || threadId === undefined) return
    const text = queued.shift()
    if (text !== undefined) void startTurn(text)
  }

  return {
    onInput(line) {
      let input: {
        text?: unknown
        steer?: unknown
        interrupt?: unknown
        permission?: { id?: unknown; approved?: unknown; grant?: unknown }
      }
      try {
        input = JSON.parse(line)
      } catch {
        return
      }
      if (input.permission !== undefined) {
        const id = String(input.permission.id)
        const request = asking.get(id)
        const reply = request?.method !== undefined ? replies[request.method] : undefined
        if (!request || !reply) return
        asking.delete(id)
        send(
          JSON.stringify({
            id: request.id,
            result: reply(input.permission.approved === true, input.permission.grant),
          }),
        )
        return
      }
      if (input.interrupt === true) return interrupt()
      const text = input.text
      if (typeof text !== 'string') return
      if (threadId === undefined) pending.push(text)
      else if (input.steer === true) void steer(text)
      else queueTurn(text)
    },
    onLine(line) {
      let message: RpcMessage
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.method === 'turn/started') {
        const id = (message.params?.turn as { id?: unknown } | undefined)?.id
        if (typeof id === 'string') turnId = id
        interruptIfWanted()
      }
      if (message.method === 'turn/completed') {
        turnActive = false
        turnId = undefined
        interruptWanted = false
        nextTurn()
      }
      if (message.method === 'serverRequest/resolved') {
        asking.delete(String(message.params?.requestId))
      }
      if (message.id === undefined) return
      if (message.method === undefined) {
        if (typeof message.id !== 'number') return
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
        return
      }
      if (replies[message.method]) {
        asking.set(String(message.id), message)
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

function listedModels(listed: RpcMessage): ListedModel[] {
  return Array.isArray(listed.result?.data) ? (listed.result.data as ListedModel[]) : []
}

function defaultModel(models: ListedModel[]): string | undefined {
  const found = models.find((m) => m.isDefault === true)?.model
  return typeof found === 'string' ? found : undefined
}

function clampEffort(
  models: ListedModel[],
  name: string | undefined,
  wanted: Effort | undefined,
): Effort | undefined {
  if (wanted === undefined) return undefined
  const model = models.find((m) =>
    name === undefined ? m.isDefault === true : m.model === name || m.id === name,
  )
  const supported = (model?.supportedReasoningEfforts ?? [])
    .map((e) => e.reasoningEffort)
    .filter((e): e is Effort => efforts.includes(e as Effort))
  if (supported.length === 0 || supported.includes(wanted)) return wanted
  const rank = (e: Effort) => efforts.indexOf(e)
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b))
  return sorted.filter((e) => rank(e) < rank(wanted)).at(-1) ?? sorted[0]
}
