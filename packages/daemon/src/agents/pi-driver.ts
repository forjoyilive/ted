import { isObject, isString, type JsonObject, parseJson } from '@ted/protocol/parse'
import type { DriveAgent } from '../runs/host-files.ts'

export interface PiPlan {
  prompt: string
}

export const piDialogs = ['select', 'confirm', 'input', 'editor'] as const

const stateRequest = 'ted-state'

function parsePlan(input: string): PiPlan {
  const plan = parseJson(input)
  return { prompt: isObject(plan) && isString(plan.prompt) ? plan.prompt : '' }
}

function objectFrom(line: string): JsonObject | undefined {
  const value = parseJson(line)
  return isObject(value) ? value : undefined
}

export const drive: DriveAgent = ({ input, send, emit, stop, fail }) => {
  const plan = parsePlan(input)
  const output = (event: string, data: JsonObject = {}) =>
    emit?.(JSON.stringify({ ted_pi: event, ...data }))
  const command = (value: JsonObject) => send(JSON.stringify(value))
  let ready = false
  let busy = false
  let interrupted = false
  let requests = 0
  let starting: string | undefined
  let lastError: string | undefined
  const queued: string[] = []

  function prompt(text: string) {
    const steer = busy
    const id = `ted-prompt-${++requests}`
    busy = true
    if (!steer) starting = id
    output('started', { text, ...(steer && { steer: true }) })
    command({
      id,
      type: 'prompt',
      message: text,
      ...(steer && { streamingBehavior: 'steer' }),
    })
  }

  function settle() {
    busy = false
    interrupted = false
    output('idle')
    const next = queued.shift()
    if (next !== undefined) prompt(next)
  }

  command({ id: stateRequest, type: 'get_state' })

  return {
    onInput(line) {
      const message = objectFrom(line)
      if (!message) return
      if (message.interrupt === true) {
        queued.length = 0
        if (!busy) return
        interrupted = true
        command({ id: `ted-clear-${++requests}`, type: 'clear_queue' })
        command({ id: `ted-abort-${++requests}`, type: 'abort' })
        return
      }
      if (!isString(message.text)) return
      if (!ready || interrupted) queued.push(message.text)
      else prompt(message.text)
    },
    onLine(line) {
      const event = objectFrom(line)
      if (!event) return
      if (event.type === 'extension_ui_request') {
        const method = event.method
        if (isString(event.id) && isString(method) && piDialogs.some((d) => d === method)) {
          command({ type: 'extension_ui_response', id: event.id, cancelled: true })
          output('dialog-cancelled', { method, title: isString(event.title) ? event.title : '' })
        }
        return
      }
      if (event.type === 'response') {
        if (event.id === stateRequest) {
          const data = isObject(event.data) ? event.data : {}
          if (event.success === true && isString(data.sessionId)) {
            output('session', {
              sessionId: data.sessionId,
              ...(isString(data.sessionFile) && { sessionFile: data.sessionFile }),
            })
          } else {
            output('error', {
              message: isString(event.error) ? event.error : 'Pi didn’t report its session',
            })
          }
          ready = true
          if (plan.prompt !== '') queued.unshift(plan.prompt)
          if (queued.length === 0) output('idle')
          else prompt(queued.shift() ?? '')
          return
        }
        if (event.command === 'prompt' && event.success === false) {
          output('error', {
            message: isString(event.error) ? event.error : 'Pi didn’t accept the message',
          })
          if (event.id === starting) settle()
        }
        return
      }
      if (event.type === 'message_end' && isObject(event.message)) {
        const message = event.message
        if (message.role === 'assistant')
          lastError =
            message.stopReason === 'error'
              ? `Pi: ${isString(message.errorMessage) && message.errorMessage !== '' ? message.errorMessage : 'the model returned an error'}`
              : undefined
        return
      }
      if (event.type === 'agent_settled') {
        if (lastError !== undefined && event.aborted !== true) {
          const message = lastError
          lastError = undefined
          if (fail) fail(message)
          else stop()
          return
        }
        lastError = undefined
        if (busy || interrupted) settle()
      }
    },
  }
}
