import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Effort, isModelName } from '@ted/protocol'
import type { Agent } from './agent.ts'
import { withoutCredentials } from './agent.ts'
import {
  piAssistant,
  piChat,
  piChatFrom,
  piErrorText,
  piLine,
  piNumber,
  piObject,
  piText,
} from './pi-chat.ts'
import type { PiPlan } from './pi-driver.ts'
import { piHealth, piSavedModel } from './pi-health.ts'
import { piModels } from './pi-models.ts'

const driver = fileURLToPath(new URL('./pi-driver.ts', import.meta.url))

export const piSessionFolder = 'pi-sessions'

const thinking: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'max',
}

const toolFree = ['--no-tools', '--no-mcp', '--no-extensions', '--no-skills', '--no-approve']

export function piSessionFile(sessions: string, sessionId: string): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined
  try {
    const name = readdirSync(sessions).find((file) => file.endsWith(`_${sessionId}.jsonl`))
    return name === undefined ? undefined : path.join(sessions, name)
  } catch {
    return undefined
  }
}

const modelMissing = /model.*(not found|unknown|unavailable|not available|no such)/i

export function piAgent(binary: string): Agent {
  return {
    kind: 'pi',
    binary,
    launch({ prompt, runDir, env, resume, model, effort, tools }) {
      if (model !== undefined && !isModelName(model))
        throw new Error(`“${model}” isn’t a model name`)
      if (resume !== undefined && !/^[\w-]+$/.test(resume))
        throw new Error('Pi’s session ID isn’t one Ted recorded')
      const sessions = path.join(runDir, piSessionFolder)
      const session = resume === undefined ? undefined : piSessionFile(sessions, resume)
      if (resume !== undefined && session === undefined)
        throw new Error(`Pi’s saved session ${resume} is missing from this Run’s folder`)
      const plan: PiPlan = { prompt }
      return {
        command: binary,
        args: [
          '--mode',
          'rpc',
          ...(tools === undefined ? ['--approve'] : toolFree),
          '--session-dir',
          sessions,
          ...(session !== undefined ? ['--session', session] : []),
          ...(model !== undefined ? ['--model', model] : []),
          ...(effort !== undefined ? ['--thinking', thinking[effort]] : []),
        ],
        env: withoutCredentials(env),
        input: JSON.stringify(plan),
        files: {},
        driver,
        lines: 'lf',
        ...(resume !== undefined && { sessionId: resume }),
      }
    },
    environment: (env) => withoutCredentials(env),
    message: (text) => JSON.stringify({ text }),
    steer: (text) => JSON.stringify({ text, steer: true }),
    interrupt: () => [JSON.stringify({ interrupt: true })],
    boundaryFrom: (line) => piLine(line)?.type === 'tool_execution_end',
    permissionPromptFrom: () => undefined,
    permissionClosedFrom: () => undefined,
    permissionReply: () => [],
    autoModeFrom: () => undefined,
    stateFrom(line) {
      const event = piLine(line)?.ted_pi
      return event === 'started' ? 'working' : event === 'idle' ? 'idle' : undefined
    },
    turnFrom(line) {
      const event = piLine(line)
      if (event?.ted_pi === 'started' && event.steer !== true) return 'started'
      return event?.ted_pi === 'idle' ? 'completed' : undefined
    },
    acceptedTextFrom(line) {
      const event = piLine(line)
      return event?.ted_pi === 'started' ? piText(event.text) : undefined
    },
    agentTextFrom(line) {
      const event = piLine(line)
      const update = piObject(event?.assistantMessageEvent)
      return event?.type === 'message_update' && update.type === 'text_delta'
        ? piText(update.delta) || undefined
        : undefined
    },
    sessionIdFrom(line) {
      const event = piLine(line)
      const id = event?.ted_pi === 'session' ? piText(event.sessionId) : ''
      return /^[\w-]+$/.test(id) ? id : undefined
    },
    sessionContinuedFrom: (line) => piLine(line)?.ted_pi === 'session',
    problemFrom(line) {
      const event = piLine(line)
      if (!event) return undefined
      const assistant = piAssistant(event)
      const text = assistant
        ? piErrorText(assistant)
        : event.ted_pi === 'error'
          ? piText(event.message)
          : undefined
      return text !== undefined && modelMissing.test(text) ? 'model-unavailable' : undefined
    },
    tokensFrom(line) {
      const event = piLine(line)
      const assistant = event && piAssistant(event)
      if (!assistant) return undefined
      const usage = piObject(assistant.usage)
      const input = piNumber(usage.input) + piNumber(usage.cacheRead) + piNumber(usage.cacheWrite)
      const output = piNumber(usage.output)
      return input + output > 0 ? { input, output, total: false } : undefined
    },
    authErrorFrom: () => false,
    usageFrom: () => undefined,
    credentialFrom: () => undefined,
    retryingFrom(line) {
      const type = piLine(line)?.type
      return type === 'auto_retry_start' ? true : type === 'auto_retry_end' ? false : undefined
    },
    planUsageFrom: () => undefined,
    costLine(line) {
      const event = piLine(line)
      return event !== undefined && piAssistant(event) !== undefined
    },
    costOf(lines) {
      let total = 0
      for (const line of lines) {
        const event = piLine(line)
        const assistant = event && piAssistant(event)
        if (assistant) total += piNumber(piObject(piObject(assistant.usage).cost).total)
      }
      return total > 0 ? total : undefined
    },
    keyHelp: () => 'Pi reads its own keys and sign-ins from its settings.',
    chat: piChat,
    chatFrom: piChatFrom,
    savedModel: piSavedModel,
    health: {
      minimumVersion: '1.5.2',
      versionArgs: ['--version'],
      authArgs: ['--list-models'],
      auth: () => ({ signedIn: false }),
      inspect: piHealth,
      models: piModels,
      signIn: () => 'pi',
      update: 'npm install -g @earendil-works/pi-coding-agent@latest',
      install: 'npm install -g @earendil-works/pi-coding-agent',
      ignoresOfflineAndLimits: true,
    },
  }
}
