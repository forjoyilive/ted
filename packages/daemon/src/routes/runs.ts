import {
  parseSendRunMessageRequest,
  parseSendSubAgentRequest,
  parseSideChatMessageRequest,
  parseStartDevRunRequest,
  parseStartSubAgentRequest,
} from '@ted/protocol'
import {
  collectDiagnostics,
  processUsage,
  readDaemonLog,
  readRunOutput,
  report,
} from '../diagnostics.ts'
import { RequestError as HttpError } from '../errors.ts'
import { resolveReference } from '../references.ts'
import { jsonRoute, type Route, routePattern } from './route.ts'

const maxWaitMs = 60_000
const defaultWaitMs = 25_000

const routes: Route[] = [
  {
    method: 'GET',
    path: /^\/runs\/([^/]+)\/side-chat$/,
    handle: async ({ params: [id = ''] }, { sideChats }) => [200, await sideChats.get(id)],
  },
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/side-chat$/,
    handle: async ({ params: [id = ''] }, { sideChats }) => [201, await sideChats.open(id)],
  },
  jsonRoute(parseSideChatMessageRequest, {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/side-chat\/messages$/,
    async handle({ body, params: [id = ''] }, { sideChats }) {
      return [201, await sideChats.send(id, body.text)]
    },
  }),
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/side-chat\/stop$/,
    handle: async ({ params: [id = ''] }, { sideChats }) => [200, await sideChats.stop(id)],
  },
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/side-chat\/retry$/,
    handle: async ({ params: [id = ''] }, { sideChats }) => [200, await sideChats.retry(id)],
  },

  jsonRoute(parseStartSubAgentRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/sub-agents$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [201, await tasks.startSubAgent(ref, caller, body)]
    },
  }),
  {
    method: 'GET',
    path: /^\/sub-agents\/([^/?]+)\/wait(?:\?timeoutMs=(\d+))?$/,
    waits: true,
    runToken: true,
    async handle({ params: [id = '', timeout = ''], caller }, { tasks }) {
      const timeoutMs = timeout === '' ? defaultWaitMs : Math.min(Number(timeout), maxWaitMs)
      return [200, await tasks.waitForSubAgent(id, caller, timeoutMs)]
    },
  },
  jsonRoute(parseSendSubAgentRequest, {
    method: 'POST',
    path: /^\/sub-agents\/([^/]+)\/messages$/,
    runToken: true,
    async handle({ body, params: [id = ''], caller }, { tasks }) {
      return [200, await tasks.sendSubAgent(id, caller, body.text)]
    },
  }),
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
    path: /^\/diagnostics\/usage$/,
    handle: async (_, options) => [200, await processUsage(options)],
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
  jsonRoute(parseStartDevRunRequest, {
    method: 'POST',
    path: /^\/dev\/runs$/,
    async handle({ body }, { runs, agents, disk, store }) {
      if (disk.held()) throw new HttpError(507, 'The disk is full, so TED isn’t starting new Runs')
      return [
        201,
        await runs.start({
          ...body,
          agent:
            body.agent ??
            store.settings().enabledAgents.find((kind) => agents.installed(kind)) ??
            store.settings().enabledAgents[0] ??
            agents.defaultLead(),
        }),
      ]
    },
  }),
  {
    method: 'GET',
    path: /^\/runs\/([^/]+)\/chat$/,
    handle: async ({ params: [id = ''] }, { conversations }) => [200, await conversations.chat(id)],
  },
  jsonRoute(parseSendRunMessageRequest, {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/messages$/,
    async handle({ body, params: [id = ''] }, { conversations }) {
      return [201, await conversations.send(id, body.text, { interrupt: body.interrupt === true })]
    },
  }),
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/messages\/([^/]+)\/send-now$/,
    handle: async ({ params: [id = '', messageId = ''] }, { conversations }) => [
      200,
      await conversations.sendNow(id, messageId),
    ],
  },
  {
    method: 'DELETE',
    path: /^\/runs\/([^/]+)\/messages\/([^/]+)$/,
    handle: async ({ params: [id = '', messageId = ''] }, { conversations }) => [
      200,
      conversations.deleteMessage(id, messageId),
    ],
  },
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/interrupt$/,
    handle: async ({ params: [id = ''] }, { conversations }) => [
      200,
      await conversations.stopTurn(id),
    ],
  },
  {
    method: 'POST',
    path: /^\/runs\/([^/]+)\/boundary$/,
    runToken: true,
    handle: async ({ params: [id = ''], caller }, { conversations }) => [
      200,
      await conversations.boundary(id, caller),
    ],
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
    handle: async ({ params: [ref = '', runId = ''] }, { conversations, store }) => [
      200,
      conversations.openTab(
        ref,
        resolveReference(
          runId,
          store.taskRunList(store.getTask(ref)?.id ?? ref).map((run) => run.id),
          'Run on this Task',
        ),
      ),
    ],
  },
  {
    method: 'DELETE',
    path: /^\/tasks\/([^/]+)\/tabs\/([^/]+)$/,
    handle: async ({ params: [ref = '', runId = ''] }, { conversations, store }) => [
      200,
      conversations.closeTab(
        ref,
        resolveReference(
          runId,
          store.taskRunList(store.getTask(ref)?.id ?? ref).map((run) => run.id),
          'Run on this Task',
        ),
      ),
    ],
  },
  {
    method: 'GET',
    path: /^\/runs\/([^/]+)$/,
    async handle({ params: [id = ''] }, { store, runs }) {
      const run = store.getRun(id)
      if (!run) throw new HttpError(404, 'no such Run')
      return [200, { run, conversation: runs.output.entries(run.id) }]
    },
  },
]

export const runRoutes: Route[] = routes.map((route) => {
  if (!routePattern(route.path).startsWith('/runs/:id')) return route
  return {
    ...route,
    async handle(context, options) {
      const reference = context.params[0] ?? ''
      const ids =
        context.caller.kind === 'run'
          ? [context.caller.runId]
          : options.store.getRun(reference)
            ? [reference]
            : options.store.listRuns().map((run) => run.id)
      const id = resolveReference(context.params[0] ?? '', ids, 'Run')
      return route.handle({ ...context, params: [id, ...context.params.slice(1)] }, options)
    },
  }
})
