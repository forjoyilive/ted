import { fileURLToPath } from 'node:url'
import { type Billing, isModelName, tedVersion } from '@ted/protocol'
import type { Agent, PermissionPrompt } from './agent.ts'
import { withoutCredentials } from './agent.ts'
import { antigravityChat, antigravityChatFrom } from './antigravity-chat.ts'
import type { AntigravityPlan } from './antigravity-driver.ts'
import { antigravityHealth } from './antigravity-health.ts'
import { antigravityTextOnly } from './antigravity-text-only.ts'
import { list, parseObject, record, str } from './chat-entries.ts'

const driver = fileURLToPath(new URL('./antigravity-driver.ts', import.meta.url))

export function antigravityEnvironment(
  env: NodeJS.ProcessEnv,
  billing: Billing,
): NodeJS.ProcessEnv {
  const clean = withoutCredentials(env, billing === 'api-key' ? ['GEMINI_API_KEY'] : [])
  for (const name of [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'AGY_ADC_AUTH',
    'GOOGLE_GEMINI_BASE_URL',
  ])
    delete clean[name]
  return clean
}

function permission(line: string): PermissionPrompt | undefined {
  const event = parseObject(line)
  if (event?.ted_antigravity !== 'permission' || typeof event.requestId !== 'string')
    return undefined
  const call = record(event.toolCall)
  const options = list(event.options).map(record)
  const raw = record(call.rawInput)
  const command = str(raw.command) || str(raw.CommandLine) || str(call.title)
  const shown =
    Object.keys(raw).length > 0 ||
    list(call.content).some((part) => {
      const content = record(part)
      return (
        content.type === 'diff' &&
        typeof content.path === 'string' &&
        typeof content.newText === 'string'
      )
    })
  const details = JSON.stringify(call, null, 2)
  return {
    requestId: event.requestId,
    title: 'Allow Antigravity to use a tool',
    command: command || 'a tool TED can’t show',
    ...(details && { details }),
    refuse:
      !command ||
      !shown ||
      !options.some((o) => o.kind === 'allow_once' && typeof o.optionId === 'string'),
  }
}

export function antigravityAgent(binary: string): Agent {
  return {
    kind: 'antigravity',
    binary,
    launch({
      prompt,
      runDir,
      env,
      resume,
      model,
      effort,
      permissions,
      billing = 'subscription',
      tools,
    }) {
      const restricted = tools === 'none' ? antigravityTextOnly(runDir) : undefined
      if (model !== undefined && !isModelName(model))
        throw new Error(`“${model}” isn’t a model name`)
      if (billing === 'api-key' && !env.GEMINI_API_KEY)
        throw new Error(
          'Set GEMINI_API_KEY in your login-shell environment to use Antigravity API-key billing',
        )
      const plan: AntigravityPlan = {
        prompt,
        billing,
        clientVersion: tedVersion,
        ...(restricted && { textOnly: true, cwd: restricted.cwd }),
        ...(resume !== undefined && { resume }),
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
      }
      return {
        command: binary,
        args: [
          'acp',
          '--disable-telemetry',
          ...(restricted
            ? restricted.args
            : permissions === 'bypass'
              ? ['--dangerously-skip-permissions']
              : ['--sandbox']),
        ],
        env: antigravityEnvironment(env, billing),
        input: JSON.stringify(plan),
        files: restricted?.files ?? {},
        ...(restricted && { cwd: restricted.cwd }),
        driver,
        ...(resume !== undefined && { sessionId: resume }),
      }
    },
    environment: antigravityEnvironment,
    message: (text) => JSON.stringify({ text }),
    steer: (text) => JSON.stringify({ text, steer: true }),
    interrupt: () => [JSON.stringify({ interrupt: true })],
    boundaryFrom(line) {
      const event = parseObject(line)
      const update = record(event?.update)
      return (
        event?.ted_antigravity === 'update' &&
        update.sessionUpdate === 'tool_call_update' &&
        ['completed', 'failed'].includes(str(update.status))
      )
    },
    permissionPromptFrom: permission,
    permissionClosedFrom(line) {
      const event = parseObject(line)
      return event?.ted_antigravity === 'permission-closed'
        ? str(event.requestId) || undefined
        : undefined
    },
    permissionReply({ requestId, approved, text }) {
      return [
        JSON.stringify({ permission: { id: requestId, approved } }),
        ...(text !== undefined ? [JSON.stringify({ text })] : []),
      ]
    },
    autoModeFrom: () => undefined,
    stateFrom(line) {
      switch (parseObject(line)?.ted_antigravity) {
        case 'started':
        case 'permission-closed':
          return 'working'
        case 'permission-waiting':
        case 'permission':
          return 'waiting'
        case 'idle':
          return 'idle'
        default:
          return undefined
      }
    },
    turnFrom(line) {
      const type = parseObject(line)?.ted_antigravity
      return type === 'started' ? 'started' : type === 'completed' ? 'completed' : undefined
    },
    acceptedTextFrom(line) {
      const event = parseObject(line)
      return event?.ted_antigravity === 'started' ? str(event.text) : undefined
    },
    agentTextFrom(line) {
      const event = parseObject(line)
      const update = record(event?.update)
      return event?.ted_antigravity === 'update' && update.sessionUpdate === 'agent_message_chunk'
        ? str(record(update.content).text) || undefined
        : undefined
    },
    sessionIdFrom(line) {
      const event = parseObject(line)
      return event?.ted_antigravity === 'session' ? str(event.sessionId) || undefined : undefined
    },
    sessionContinuedFrom: (line) => parseObject(line)?.ted_antigravity === 'session',
    authErrorFrom(line) {
      const event = parseObject(line)
      return (
        event?.ted_antigravity === 'error' &&
        /authentication required|unauthorized|invalid.*key|sign.?in/i.test(str(event.message))
      )
    },
    credentialFrom(line) {
      const event = parseObject(line)
      return event?.ted_antigravity === 'credential' &&
        (event.billing === 'subscription' || event.billing === 'api-key')
        ? { billing: event.billing }
        : undefined
    },
    usageFrom(line) {
      const event = parseObject(line)
      if (
        event?.ted_antigravity === 'error' &&
        /quota|rate.?limit|resource.exhausted/i.test(str(event.message))
      )
        return { limited: true }
      return event?.ted_antigravity === 'completed' ? { limited: false } : undefined
    },
    retryingFrom: () => undefined,
    planUsageFrom: () => undefined,
    costOf: () => undefined,
    costLine: () => false,
    tokensFrom: () => undefined,
    problemFrom(line) {
      const event = parseObject(line)
      return event?.ted_antigravity === 'error' &&
        /model/i.test(str(event.message)) &&
        /(unavailable|unknown|not support)/i.test(str(event.message))
        ? 'model-unavailable'
        : undefined
    },
    keyHelp: () =>
      'Antigravity is using Gemini API access. Choose API key billing or sign in with the Google account that has your subscription.',
    chat: antigravityChat,
    chatFrom: antigravityChatFrom,
    health: {
      minimumVersion: '1.5.6',
      versionArgs: ['--version'],
      authArgs: ['acp', '--help'],
      auth: () => ({ signedIn: false }),
      inspect: antigravityHealth,
      signIn: () => 'agy acp --login',
      update: 'agy update',
      install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    },
  }
}
