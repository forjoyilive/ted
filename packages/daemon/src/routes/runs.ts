import path from 'node:path'
import { type AgentKind, agentKinds, type StartDevRunRequest } from '@ted/protocol'
import { collectDiagnostics, readDaemonLog, readRunOutput, report } from '../diagnostics.ts'
import { RequestError as HttpError } from '../errors.ts'
import { type Route, readJson } from './route.ts'

export const runRoutes: Route[] = [
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
    path: /^\/runs\/([^/]+)$/,
    async handle({ params: [id = ''] }, { store }) {
      const run = store.getRun(id)
      if (!run) throw new HttpError(404, 'no such Run')
      return [200, { run, conversation: store.conversation(id) }]
    },
  },
]
