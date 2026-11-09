import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import {
  type AgentKind,
  agentKinds,
  type Effort,
  efforts,
  type SendRunMessageRequest,
  type SendSubAgentRequest,
  type StartDevRunRequest,
  type StartSubAgentRequest,
} from '@ted/protocol'
import { collectDiagnostics, readDaemonLog, readRunOutput, report } from '../diagnostics.ts'
import { RequestError as HttpError } from '../errors.ts'
import { type Route, readJson } from './route.ts'

const maxWaitMs = 60_000
const defaultWaitMs = 25_000

export const runRoutes: Route[] = [
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/sub-agents$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      return [201, await tasks.startSubAgent(ref, caller, subAgentRequest(await readJson(req)))]
    },
  },
  {
    method: 'GET',
    path: /^\/sub-agents\/([^/?]+)\/wait(?:\?timeoutMs=(\d+))?$/,
    runToken: true,
    async handle({ params: [id = '', timeout = ''], caller }, { tasks }) {
      const timeoutMs = timeout === '' ? defaultWaitMs : Math.min(Number(timeout), maxWaitMs)
      return [200, await tasks.waitForSubAgent(id, caller, timeoutMs)]
    },
  },
  {
    method: 'POST',
    path: /^\/sub-agents\/([^/]+)\/messages$/,
    runToken: true,
    async handle({ req, params: [id = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<SendSubAgentRequest> | null
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (text === '') throw new HttpError(400, 'text is required')
      return [200, await tasks.sendSubAgent(id, caller, text)]
    },
  },
  {
    method: 'POST',
    path: /^\/sub-agents\/([^/]+)\/stop$/,
    runToken: true,
    handle: async ({ params: [id = ''], caller }, { tasks }) => [
      200,
      await tasks.stopSubAgent(id, caller),
    ],
  },
  {
    method: 'GET',
    path: /^\/diagnostics$/,
    handle: async (_, options) => [200, await collectDiagnostics(options)],
  },
  {
    method: 'GET',
    path: /^\/diagnostics\/report$/,
    handle: async (_, options) => [200, { text: await report(options) }],
  },
  {
    method: 'GET',
    path: /^\/logs\/daemon$/,
    handle: async (_, { home }) => [200, await readDaemonLog(home)],
  },
  {
    method: 'GET',
    path: /^\/runs\/([^/]+)\/raw$/,
    async handle({ params: [id = ''] }, { store, home }) {
      if (!store.getRun(id)) throw new HttpError(404, 'no such Run')
      return [200, await readRunOutput(home, id)]
    },
  },
  {
    method: 'POST',
    path: /^\/dev\/runs$/,
    async handle({ req }, { runs, agents, disk }) {
      if (disk.held()) throw new HttpError(507, 'The disk is full, so TED isn’t starting new Runs')
      const body = (await readJson(req)) as Partial<StartDevRunRequest> | null
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      const agent = body?.agent ?? agents.defaultLead()
      if (prompt === '') throw new HttpError(400, 'prompt is required')
      if (!path.isAbsolute(cwd)) throw new HttpError(400, 'cwd must be an absolute path')
      if (!agentKinds.includes(agent as AgentKind)) {
        throw new HttpError(400, 'agent must be claude or codex')
      }
      return [201, await runs.start({ agent, prompt, cwd })]
    },
  },
  {
    method: 'GET',
    path: /^\/runs\/([^/]+)\/chat$/,
    handle: async ({ params: [id = ''] }, { conversations }) => [200, await conversations.chat(id)],
  },
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/messages$/,
    async handle({ req, params: [id = ''] }, { conversations }) {
      const body = (await readJson(req)) as Partial<SendRunMessageRequest> | null
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (text === '') throw new HttpError(400, 'text is required')
      return [201, await conversations.send(id, text)]
    },
  },
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/restart$/,
    handle: async ({ params: [id = ''] }, { conversations }) => [
      200,
      await conversations.restart(id),
    ],
  },
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/stop$/,
    handle: async ({ params: [id = ''] }, { conversations }) => [200, await conversations.stop(id)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/runs$/,
    handle: async ({ params: [ref = ''] }, { conversations }) => [200, conversations.taskRuns(ref)],
  },
  {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/tabs\/([^/]+)$/,
    handle: async ({ params: [ref = '', runId = ''] }, { conversations }) => [
      200,
      conversations.openTab(ref, runId),
    ],
  },
  {
    method: 'DELETE',
    path: /^\/tasks\/([^/]+)\/tabs\/([^/]+)$/,
    handle: async ({ params: [ref = '', runId = ''] }, { conversations }) => [
      200,
      conversations.closeTab(ref, runId),
    ],
  },
  {
    method: 'GET',
    path: /^\/runs\/([^/]+)$/,
    async handle({ params: [id = ''] }, { store }) {
      const run = store.getRun(id)
      if (!run) throw new HttpError(404, 'no such Run')
      return [200, { run, conversation: store.conversation(id) }]
    },
  },
]

function subAgentRequest(body: unknown): StartSubAgentRequest {
  const input = (body ?? {}) as Partial<Record<keyof StartSubAgentRequest, unknown>>
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  if (prompt.trim() === '') throw new HttpError(400, 'the prompt file is empty')
  const { agent, model, effort, name, ownWorktree, reviewer } = input
  if (agent !== undefined && !agentKinds.includes(agent as AgentKind)) {
    throw new HttpError(400, 'agent must be claude or codex')
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new HttpError(400, 'model must be a model name')
  }
  if (effort !== undefined && !efforts.includes(effort as Effort)) {
    throw new HttpError(400, `effort must be one of ${efforts.join(', ')}`)
  }
  if (name !== undefined && typeof name !== 'string') throw new HttpError(400, 'name must be text')
  if (ownWorktree !== undefined && typeof ownWorktree !== 'boolean') {
    throw new HttpError(400, 'ownWorktree must be true or false')
  }
  if (reviewer !== undefined && typeof reviewer !== 'boolean') {
    throw new HttpError(400, 'reviewer must be true or false')
  }
  return {
    prompt,
    ...(agent !== undefined && { agent: agent as AgentKind }),
    ...(typeof model === 'string' && { model: model.trim() }),
    ...(effort !== undefined && { effort: effort as Effort }),
    ...(typeof name === 'string' && name.trim() !== '' && { name: oneLine(name) }),
    ...(ownWorktree === true && { ownWorktree }),
    ...(reviewer === true && { reviewer }),
  }
}

function oneLine(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/g, ' ').trim()
}
