import type { Billing, Effort } from '@ted/protocol'
import type { DriveAgent } from '../runs/host-files.ts'
import { acpRequests } from './antigravity-rpc.ts'
import { list, parseObject, record, str } from './chat-entries.ts'

export interface AntigravityPlan {
  prompt: string
  textOnly?: boolean
  resume?: string
  billing: Billing
  model?: string
  effort?: Effort
  clientVersion: string
}

export const drive: DriveAgent = ({ input, cwd, send, stop, emit }) => {
  const plan = JSON.parse(input) as AntigravityPlan
  const output = (event: string, data: Record<string, unknown> = {}) =>
    emit?.(JSON.stringify({ ted_antigravity: event, ...data }))
  const rpc = acpRequests(send)
  let sessionId: string | undefined
  let ready = false
  let failed = false
  let active = 0
  let turn = 0
  let interrupted = false
  const queued: string[] = []
  const asking = new Map<string, { id: string | number; options: Record<string, unknown>[] }>()
  const notify = (method: string, params: unknown) =>
    send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  const respond = (id: string | number, result: unknown) =>
    send(JSON.stringify({ jsonrpc: '2.0', id, result }))

  function closePermissions() {
    for (const [id, request] of asking) {
      respond(request.id, { outcome: { outcome: 'cancelled' } })
      output('permission-closed', { requestId: id })
    }
    asking.clear()
  }

  function fail(error: unknown) {
    if (failed) return
    failed = true
    closePermissions()
    output('error', { message: error instanceof Error ? error.message : 'Antigravity failed' })
    rpc.close()
    stop()
  }

  async function prompt(text: string) {
    if (!sessionId || failed) return
    active++
    const current = ++turn
    output('started', { text, turn: current })
    try {
      const result = await rpc.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        24 * 60 * 60 * 1000,
      )
      if (
        !['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(
          str(result.stopReason),
        )
      )
        throw new Error('Antigravity returned an unknown turn result')
      output('completed', { turn: current, stopReason: result.stopReason })
    } catch (error) {
      fail(error)
    } finally {
      active--
      if (active === 0) {
        interrupted = false
        closePermissions()
        output('idle')
        next()
      }
    }
  }

  function next() {
    if (!ready || active > 0 || failed) return
    const text = queued.shift()
    if (text !== undefined) void prompt(text)
  }

  async function configure(session: Record<string, unknown>) {
    let options = list(session.configOptions).map(record)
    let model = plan.model
    let effort: string | undefined = plan.effort
    const modelOption = options.find((option) => option.category === 'model')
    if (
      model !== undefined &&
      list(record(session.models).availableModels).some((entry) => record(entry).modelId === model)
    ) {
      const base = list(modelOption?.options)
        .map(record)
        .filter(
          (option) => typeof option.value === 'string' && model?.startsWith(`${option.value}-`),
        )
        .sort((a, b) => str(b.value).length - str(a.value).length)[0]
      if (base) {
        effort ??= model.slice(str(base.value).length + 1)
        model = str(base.value)
      }
    }
    for (const [category, wanted] of [
      ['model', model],
      ['thought_level', effort],
    ] as const) {
      if (wanted === undefined) continue
      const option = options.find(
        (o) =>
          o.category === category ||
          (category === 'thought_level' && /thinking|effort|thought/i.test(str(o.id))),
      )
      if (!option) throw new Error(`Antigravity does not advertise a ${category} setting`)
      const values = list(option.options).flatMap((v) => {
        const item = record(v)
        return Array.isArray(item.options) ? item.options.map(record) : [item]
      })
      const aliases: Record<string, string> = { xhigh: 'extra', ultra: 'max' }
      const value = values.find(
        (v) =>
          str(v.value).toLowerCase() === wanted ||
          str(v.name).toLowerCase() === wanted ||
          (category === 'thought_level' && str(v.name).toLowerCase() === aliases[wanted]),
      )?.value
      if (typeof value !== 'string')
        throw new Error(`Antigravity does not support the requested ${category}: ${wanted}`)
      const changed = await rpc.request('session/set_config_option', {
        sessionId,
        configId: option.id,
        value,
      })
      options = list(changed.configOptions).map(record)
      output('configured', { category, value })
    }
  }

  void (async () => {
    if (!emit || !cwd) throw new Error('This Run host must be updated for Antigravity')
    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'ted', title: 'TED', version: plan.clientVersion },
    })
    if (init.protocolVersion !== 1)
      throw new Error('Antigravity requires an unsupported protocol version')
    const methodId = plan.billing === 'api-key' ? 'gemini-api-key' : 'oauth-personal'
    if (!list(init.authMethods).some((method) => record(method).id === methodId))
      throw new Error('Antigravity does not support the selected billing method')
    await rpc.request('authenticate', { methodId })
    output('credential', { billing: plan.billing })
    const caps = record(init.agentCapabilities)
    const params = {
      cwd,
      mcpServers: [],
      ...(plan.resume !== undefined && { sessionId: plan.resume }),
    }
    if (plan.resume !== undefined && record(caps.sessionCapabilities).resume === undefined)
      throw new Error('Antigravity cannot resume sessions without replaying history')
    const session = await rpc.request(
      plan.resume === undefined ? 'session/new' : 'session/resume',
      params,
    )
    sessionId = plan.resume ?? str(session.sessionId)
    if (!sessionId) throw new Error('Antigravity did not return a session ID')
    await configure(session)
    output('session', { sessionId })
    ready = true
    if (plan.prompt !== '') queued.unshift(plan.prompt)
    if (interrupted) queued.length = 0
    output('idle')
    next()
  })().catch(fail)

  return {
    onInput(line) {
      const message = parseObject(line)
      if (!message || failed) return
      const permission = record(message.permission)
      if (typeof permission.id === 'string') {
        const request = asking.get(permission.id)
        if (!request) return
        const kind = permission.approved === true ? 'allow_once' : 'reject_once'
        const option = request.options.find(
          (o) => o.kind === kind && typeof o.optionId === 'string',
        )
        respond(request.id, {
          outcome: option
            ? { outcome: 'selected', optionId: option.optionId }
            : { outcome: 'cancelled' },
        })
        asking.delete(permission.id)
        output('permission-closed', { requestId: permission.id })
        if (asking.size > 0) output('permission-waiting')
        return
      }
      if (message.interrupt === true) {
        interrupted = true
        queued.length = 0
        closePermissions()
        if (sessionId && active > 0) notify('session/cancel', { sessionId })
        return
      }
      if (typeof message.text !== 'string') return
      if (ready && active > 0 && message.steer === true && !interrupted) void prompt(message.text)
      else {
        queued.push(message.text)
        next()
      }
    },
    onLine(line) {
      if (rpc.receive(line)) return
      const message = parseObject(line)
      if (!message) return fail(new Error('Antigravity returned malformed JSON'))
      if (typeof message.method !== 'string') return
      const params = record(message.params)
      if (message.method === 'session/update' && params.sessionId === sessionId) {
        const update = record(params.update)
        if (
          plan.textOnly &&
          (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
        ) {
          return fail(new Error('Antigravity attempted to use a tool in a text-only Run'))
        }
        output('update', { update: params.update, turn })
        return
      }
      if (typeof message.id !== 'string' && typeof message.id !== 'number') return
      if (
        message.method === 'session/request_permission' &&
        params.sessionId === sessionId &&
        !plan.textOnly &&
        ready &&
        !interrupted
      ) {
        const id = String(message.id)
        const options = list(params.options).map(record)
        asking.set(id, { id: message.id, options })
        output('permission', { requestId: id, toolCall: params.toolCall, options })
        return
      }
      if (message.method === 'session/request_permission')
        respond(message.id, { outcome: { outcome: 'cancelled' } })
      else
        send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'TED does not provide this capability' },
          }),
        )
    },
  }
}
