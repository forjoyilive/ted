import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import {
  type AddFactoryRequest,
  type AgentKind,
  type AgentStageId,
  type AnswerRequest,
  agentKinds,
  agentStageIds,
  appearances,
  archivedFilters,
  type BannerActionInput,
  type BlockTaskRequest,
  type CheckRepoRequest,
  type CreateFactoryRequest,
  type CreateTaskRequest,
  clarifyDepths,
  createdByKinds,
  type DaemonEvent,
  type Effort,
  efforts,
  integrationFixes,
  type ListFilters,
  type ListView,
  listColumns,
  listGroups,
  listSorts,
  type MachineSettings,
  type NewFactoryRepo,
  type PostCommentRequest,
  priorities,
  quitChoices,
  type ReportOutcomeRequest,
  type RepoSource,
  type RestoreBackupRequest,
  type RunChecksRequest,
  type RunFixRequest,
  type SendRunMessageRequest,
  type SetActivityRequest,
  type SetLocalFolderRequest,
  type StartDevRunRequest,
  type StatusFilter,
  type TaskLead,
  taskStatusKinds,
  terminalFontSizes,
  type WriteBriefRequest,
  workingRunLimits,
} from '@ted/protocol'
import type { Agents } from './agents/index.ts'
import type { Attachments } from './attachments.ts'
import type { CommandLine } from './command-line.ts'
import type { Data, Services } from './data.ts'
import { collectDiagnostics, readDaemonLog, readRunOutput, report } from './diagnostics.ts'
import { cantSaveMessage, isDiskFullError } from './disk.ts'
import { RequestError as HttpError } from './errors.ts'
import { addFactory } from './factories.ts'
import type { IdleTimer } from './idle.ts'
import type { Linear } from './linear/linear.ts'
import { readProfile } from './profile.ts'
import { redactSecrets } from './redact.ts'
import type { RunTokens } from './run-token.ts'
import type { Caller, CreateTaskInput } from './tasks/tasks.ts'

export interface BaseOptions {
  version: string
  token: string
  data: Data
  idle?: IdleTimer
  keepaliveMs: number
  agents: Agents
  runTokens: RunTokens
  attachments: Attachments
  linear: Linear
  reposDir: string
  appStreams: Set<http.ServerResponse>
  onShutdown: () => void
  home: string
  commandLine: CommandLine
}

export type ServerOptions = BaseOptions & Services

interface RequestContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  params: string[]
  caller: Caller
}

interface Route<O = ServerOptions> {
  method: string
  path: RegExp
  runToken?: true
  handle(context: RequestContext, options: O): Promise<[number, unknown] | undefined>
}

const maxBodyBytes = 1024 * 1024
const maxActivityLength = 200

const dataRoutes: Route<BaseOptions>[] = [
  {
    method: 'GET',
    path: /^\/events(\?app=1)?$/,
    async handle({ req, res, params: [app] }, options) {
      streamEvents(req, res, options, app === '?app=1')
      return undefined
    },
  },
  {
    method: 'GET',
    path: /^\/data-status$/,
    handle: async (_, { data }) => [200, data.status()],
  },
  {
    method: 'GET',
    path: /^\/backups$/,
    handle: async (_, { data }) => [200, await data.summary()],
  },
  {
    method: 'POST',
    path: /^\/backups\/restore$/,
    async handle({ req }, { data }) {
      const body = (await readJson(req)) as Partial<RestoreBackupRequest> | null
      const name = typeof body?.name === 'string' ? body.name : ''
      const stopRuns = body?.stopRuns === true
      return [200, await data.restore({ name, stopRuns })]
    },
  },
  {
    method: 'POST',
    path: /^\/shutdown$/,
    async handle({ res }, { data, onShutdown }) {
      await settled(data)
      if (data.status().state === 'ready') await (await data.services()).runs.stopAll()
      res.once('finish', () => setImmediate(onShutdown))
      return [200, {}]
    },
  },
  {
    method: 'GET',
    path: /^\/command-line$/,
    handle: async (_, { commandLine }) => [200, await commandLine.status()],
  },
  {
    method: 'POST',
    path: /^\/command-line\/install$/,
    handle: async (_, { commandLine }) => [200, await commandLine.install()],
  },
  {
    method: 'POST',
    path: /^\/app\/open$/,
    async handle(_, { appStreams }) {
      for (const stream of appStreams) send(stream, { type: 'open-requested' })
      return [200, { opened: appStreams.size > 0 }]
    },
  },
]

async function settled(data: Data): Promise<void> {
  const busy = () => data.status().state === 'opening' || data.status().state === 'updating'
  if (!busy()) return
  const { promise, resolve } = Promise.withResolvers<void>()
  const unsubscribe = data.subscribe(() => {
    if (!busy()) resolve()
  })
  if (!busy()) resolve()
  await promise.finally(unsubscribe)
}

const routes: Route[] = [
  {
    method: 'GET',
    path: /^\/tasks$/,
    runToken: true,
    handle: async (_, { store }) => [200, store.listTasks()],
  },
  {
    method: 'POST',
    path: /^\/tasks$/,
    async handle({ req }, { tasks, attachments }) {
      return [201, await tasks.create(await createTaskInput(await readJson(req), attachments))]
    },
  },
  {
    method: 'POST',
    path: /^\/attachments$/,
    handle: async ({ req }, { attachments }) => [201, await attachments.save(req)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/start$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.start(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/backlog$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.moveToBacklog(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/move$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      const body = (await readJson(req)) as Record<string, unknown> | null
      const side = (name: 'after' | 'before') => {
        const value = body?.[name]
        if (value === undefined || value === null) return undefined
        if (typeof value !== 'string') throw new HttpError(400, `${name} must be a Task ID`)
        return value
      }
      const after = side('after')
      const before = side('before')
      return [
        200,
        tasks.move(ref, {
          ...(after !== undefined && { after }),
          ...(before !== undefined && { before }),
        }),
      ]
    },
  },
  {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/priority$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      const body = (await readJson(req)) as Record<string, unknown> | null
      const priority = priorities.find((p) => p === body?.priority)
      if (!priority) throw new HttpError(400, `priority must be ${priorities.join(', ')}`)
      return [200, tasks.setPriority(ref, priority)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/archive$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.archive(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/blockers$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<BlockTaskRequest> | null
      const by = typeof body?.by === 'string' ? body.by.trim() : ''
      if (by === '') throw new HttpError(400, 'by is required')
      return [200, await tasks.block(ref, caller, by)]
    },
  },
  {
    method: 'DELETE',
    path: /^\/tasks\/([^/]+)\/blockers(?:\/([^/]+))?$/,
    runToken: true,
    async handle({ params: [ref = '', by], caller }, { tasks }) {
      return [200, tasks.unblock(ref, caller, by === '' ? undefined : by)]
    },
  },
  {
    method: 'GET',
    path: /^\/slots$/,
    handle: async (_, { tasks }) => [200, await tasks.slots()],
  },
  {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/lead$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      return [200, tasks.setLead(ref, agentChoice(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/lead\/use-default-model$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.useDefaultModel(ref)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/comments$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listComments(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/stage-entries$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listStageEntries(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/repos\/([^/]+)\/setup-log$/,
    async handle({ params: [ref = '', name = ''] }, { tasks }) {
      return [200, { text: await tasks.setupLog(ref, name) }]
    },
  },
  {
    method: 'GET',
    path: /^\/factories$/,
    handle: async (_, { factories }) => [200, await factories.list()],
  },
  {
    method: 'POST',
    path: /^\/factories$/,
    async handle({ req }, { factories }) {
      const body = (await readJson(req)) as Partial<CreateFactoryRequest> | null
      const repos = Array.isArray(body?.repos) ? body.repos.map(newRepo) : []
      return [
        201,
        await factories.create({
          name: typeof body?.name === 'string' ? body.name : '',
          key: typeof body?.key === 'string' ? body.key.trim() : '',
          repos,
          showTutorial: body?.showTutorial === true,
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/check-repo$/,
    async handle({ req }, { factories }) {
      const body = (await readJson(req)) as Partial<CheckRepoRequest> | null
      return [
        200,
        await factories.checkRepo({
          source: repoSource(body?.source),
          primary: body?.primary === true,
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/retry-clone$/,
    handle: async ({ params: [id = ''] }, { factories }) => [200, await factories.retry(id)],
  },
  {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/local-folder$/,
    async handle({ req, params: [key = ''] }, { factories }) {
      const body = (await readJson(req)) as Partial<SetLocalFolderRequest> | null
      const folder = typeof body?.path === 'string' ? body.path : ''
      if (folder === '') throw new HttpError(400, 'path is required')
      return [200, await factories.setLocalFolder(key, folder)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/comments$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<PostCommentRequest> | null
      const text = typeof body?.body === 'string' ? body.body.trim() : ''
      if (text === '') throw new HttpError(400, 'body is required')
      const choices = choiceList(body?.choices)
      const supersedes = body?.supersedes
      if (supersedes !== undefined && (typeof supersedes !== 'string' || supersedes === '')) {
        throw new HttpError(400, 'supersedes must be a request’s ID')
      }
      return [
        201,
        await tasks.comment(ref, caller, {
          body: text,
          ...(choices && { choices }),
          ...(supersedes !== undefined && { supersedes }),
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/read$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, { read: tasks.markRead(ref) }],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/events$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.threadEvents(ref)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/brief$/,
    runToken: true,
    handle: async ({ params: [ref = ''], caller }, { tasks }) => [200, tasks.brief(ref, caller)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/brief$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<WriteBriefRequest> | null
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (text === '') throw new HttpError(400, 'text is required')
      return [201, tasks.writeBrief(ref, caller, `${text}\n`)]
    },
  },
  {
    method: 'GET',
    path: /^\/inbox$/,
    handle: async (_, { tasks }) => [200, tasks.inbox()],
  },
  {
    method: 'POST',
    path: /^\/comments\/([^/]+)\/answer$/,
    async handle({ req, params: [id = ''] }, { tasks }) {
      return [200, await tasks.answer(id, answerRequest(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/activity$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<SetActivityRequest> | null
      const text = typeof body?.text === 'string' ? oneLine(body.text) : ''
      if (text === '') throw new HttpError(400, 'text is required')
      if ([...text].length > maxActivityLength) {
        throw new HttpError(400, `the activity line is limited to ${maxActivityLength} characters`)
      }
      return [200, tasks.setActivity(ref, caller, text)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/outcome$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const outcome = outcomeRequest(await readJson(req))
      return [200, await tasks.reportOutcome(ref, caller, outcome)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/checks$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<RunChecksRequest> | null
      const name = typeof body?.name === 'string' ? body.name.trim() : undefined
      return [201, await tasks.runChecks(ref, caller, name === '' ? undefined : name)]
    },
  },
  {
    method: 'GET',
    path: /^\/check-runs\/([^/]+)$/,
    runToken: true,
    async handle({ params: [id = ''], caller }, { tasks }) {
      return [200, await tasks.checkRun(id, caller)]
    },
  },
  {
    method: 'GET',
    path: /^\/check-runs\/([^/]+)\/checks\/(\d+)\/output$/,
    async handle({ params: [id = '', position = ''] }, { tasks }) {
      return [200, await tasks.checkOutput(id, Number(position))]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/check-runs$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listCheckRuns(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/send-backs$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listSendBacks(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/task-defaults$/,
    handle: async ({ params: [id = ''] }, { tasks }) => [200, await tasks.defaults(id)],
  },
  {
    method: 'GET',
    path: /^\/settings$/,
    handle: async (_, { store }) => [200, store.settings()],
  },
  {
    method: 'PATCH',
    path: /^\/settings$/,
    async handle({ req }, { store }) {
      return [200, store.updateSettings(settingsChanges(await readJson(req)))]
    },
  },
  {
    method: 'GET',
    path: /^\/activity$/,
    handle: async (_, { store }) => [200, store.activity()],
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
    method: 'GET',
    path: /^\/profile$/,
    handle: async () => [200, await readProfile()],
  },
  {
    method: 'GET',
    path: /^\/banners$/,
    handle: async (_, { banners }) => [200, banners.list()],
  },
  {
    method: 'POST',
    path: /^\/banners\/([^/]+)\/dismiss$/,
    handle: async ({ params: [id = ''] }, { banners }) => [200, banners.dismiss(id)],
  },
  {
    method: 'POST',
    path: /^\/banners\/([^/]+)\/action$/,
    async handle({ req, params: [id = ''] }, { banners }) {
      const body = (await readOptionalJson(req)) as Partial<BannerActionInput> | null
      const folder = typeof body?.folder === 'string' ? body.folder : undefined
      await banners.act(id, folder === undefined ? {} : { folder })
      return [200, {}]
    },
  },
  {
    method: 'GET',
    path: /^\/agents\/health$/,
    handle: async (_, { health }) => [200, health.list()],
  },
  {
    method: 'POST',
    path: /^\/agents\/health\/check$/,
    handle: async (_, { health }) => [200, await health.check(agentKinds, { reloadEnv: true })],
  },
  {
    method: 'POST',
    path: /^\/agents\/([^/]+)\/fix$/,
    async handle({ params: [agent = ''] }, { health }) {
      const kind = agentKinds.find((k) => k === agent)
      if (!kind) throw new HttpError(404, 'no such agent')
      return [200, await health.fix(kind)]
    },
  },
  {
    method: 'GET',
    path: /^\/integrations$/,
    async handle(_, { integrations }) {
      return [200, integrations.current() ?? (await integrations.check())]
    },
  },
  {
    method: 'POST',
    path: /^\/integrations\/check$/,
    handle: async (_, { integrations }) => [200, await integrations.check({ fresh: true })],
  },
  {
    method: 'POST',
    path: /^\/integrations\/fix$/,
    async handle({ req }, { integrations }) {
      const body = (await readJson(req)) as Partial<RunFixRequest> | null
      const fix = integrationFixes.find((f) => f === body?.fix)
      if (fix === undefined) throw new HttpError(400, `fix must be ${integrationFixes.join(', ')}`)
      const host = body?.host
      if (host !== undefined && typeof host !== 'string') {
        throw new HttpError(400, 'host must be text')
      }
      return [200, await integrations.fix({ fix, ...(host !== undefined && { host }) })]
    },
  },
  {
    method: 'GET',
    path: /^\/integrations\/linear$/,
    handle: async (_, { linear }) => [200, await linear.status()],
  },
  {
    method: 'PUT',
    path: /^\/integrations\/linear\/key$/,
    async handle({ req }, { linear }) {
      const body = (await readJson(req)) as Partial<Record<'key' | 'inFile', unknown>> | null
      if (typeof body?.key !== 'string') throw new HttpError(400, 'key must be text')
      if (body.inFile !== undefined && typeof body.inFile !== 'boolean') {
        throw new HttpError(400, 'inFile must be true or false')
      }
      return [200, await linear.save({ key: body.key, inFile: body.inFile === true })]
    },
  },
  {
    method: 'DELETE',
    path: /^\/integrations\/linear\/key$/,
    handle: async (_, { linear }) => [200, await linear.remove()],
  },
  {
    method: 'POST',
    path: /^\/integrations\/linear\/test$/,
    handle: async (_, { linear }) => [200, await linear.test()],
  },
  {
    method: 'POST',
    path: /^\/integrations\/linear\/lookup$/,
    async handle({ req }, { linear }) {
      const body = (await readJson(req)) as Partial<Record<'url', unknown>> | null
      if (typeof body?.url !== 'string') throw new HttpError(400, 'url must be text')
      return [200, await linear.lookup(body.url)]
    },
  },
  {
    method: 'POST',
    path: /^\/dev\/factories$/,
    async handle({ req }, { store, reposDir, workflows, factories }) {
      const body = (await readJson(req)) as Partial<AddFactoryRequest> | null
      const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
      const key = typeof body?.key === 'string' ? body.key.trim() : ''
      if (repo === '' || key === '') throw new HttpError(400, 'repo and key are required')
      const localFolder = typeof body?.localFolder === 'string' ? body.localFolder : undefined
      const added = await addFactory(
        { store, reposDir, workflows },
        { repo, key, ...(localFolder !== undefined && { localFolder }) },
      )
      await factories.checkLocalFolders()
      return [201, await factories.get(added.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/storage$/,
    handle: async (_, { storage }) => [200, await storage.summary()],
  },
  {
    method: 'POST',
    path: /^\/storage\/remove-clones$/,
    handle: async (_, { storage }) => [200, await storage.removeUnusedClones()],
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

const drainTimeoutMs = 10_000

export async function listen(options: BaseOptions): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    options.idle?.reset()
    handle(req, res, options).catch(async (error: unknown) => {
      await drain(req)
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message })
      if (isDiskFullError(error)) return sendJson(res, 507, { error: cantSaveMessage })
      console.error(
        redactSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error)),
      )
      sendJson(res, 500, { error: 'internal error' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, port: (server.address() as AddressInfo).port }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: BaseOptions,
): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'host not allowed')
  if (req.headers.origin !== undefined) throw new HttpError(403, 'browser requests not allowed')

  const url = req.url ?? '/'
  if (req.method === 'GET' && url === '/healthz') {
    return sendJson(res, 200, { status: 'ok', version: options.version })
  }

  const caller = identify(req.headers.authorization, options)
  if (!caller) throw new HttpError(401, 'missing or wrong token')

  const dataRoute = find(dataRoutes, req, url, caller)
  if (dataRoute) {
    const reply = await dataRoute.route.handle(context(dataRoute.params), options)
    if (reply) sendJson(res, ...reply)
    return
  }
  const route = find(routes, req, url, caller)
  if (!route) throw new HttpError(404, 'not found')
  const services = await options.data.services()
  if (services.disk.cantSave() && req.method !== 'GET' && !url.startsWith('/storage/')) {
    throw new HttpError(507, cantSaveMessage)
  }
  const reply = await route.route.handle(context(route.params), { ...options, ...services })
  if (reply) sendJson(res, ...reply)

  function context(params: string[]): RequestContext {
    return { req, res, params, caller: caller as Caller }
  }
}

function find<O>(
  list: Route<O>[],
  req: http.IncomingMessage,
  url: string,
  caller: Caller,
): { route: Route<O>; params: string[] } | undefined {
  for (const route of list) {
    const found = req.method === route.method ? route.path.exec(url) : null
    if (!found) continue
    if (caller.kind === 'run' && !route.runToken) {
      throw new HttpError(403, 'Not allowed from inside a Run')
    }
    return {
      route,
      params: found.slice(1).map((param) => (param === undefined ? '' : decodeParam(param))),
    }
  }
  return undefined
}

function send(res: http.ServerResponse, event: DaemonEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { data, idle, keepaliveMs, appStreams }: BaseOptions,
  app: boolean,
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.write('event: ready\ndata: {}\n\n')
  const unsubscribe = data.subscribe((event) => send(res, event))
  if (app) appStreams.add(res)
  // Node's fetch fails a response body that sends nothing for 300 seconds.
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), keepaliveMs)
  const release = idle?.hold()
  req.on('close', () => {
    clearInterval(keepalive)
    unsubscribe()
    appStreams.delete(res)
    release?.()
  })
}

function agentChoice(body: unknown): TaskLead {
  const { agent, model, effort } = (body ?? {}) as Record<string, unknown>
  if (!agentKinds.includes(agent as AgentKind)) {
    throw new HttpError(400, 'agent must be claude or codex')
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new HttpError(400, 'model must be a name')
  }
  if (effort !== undefined && !efforts.includes(effort as Effort)) {
    throw new HttpError(400, `effort must be one of ${efforts.join(', ')}`)
  }
  return {
    agent: agent as AgentKind,
    ...(typeof model === 'string' && { model: model.trim() }),
    ...(effort !== undefined && { effort: effort as Effort }),
  }
}

function identify(authorization: string | undefined, options: BaseOptions): Caller | undefined {
  const given = authorization?.replace(/^Bearer /, '') ?? ''
  if (equalSecrets(given, options.token)) return { kind: 'daemon' }
  const runId = options.runTokens.verify(given)
  return runId === undefined ? undefined : { kind: 'run', runId }
}

function decodeParam(param: string): string {
  try {
    return decodeURIComponent(param)
  } catch {
    throw new HttpError(400, 'malformed path')
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const hostname = host.replace(/:\d+$/, '')
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

function equalSecrets(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function settingsChanges(body: unknown): Partial<MachineSettings> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'settings must be an object')
  }
  const entries = Object.entries(body)
  if (entries.length === 0) throw new HttpError(400, 'no settings to change')
  const changes: Partial<MachineSettings> = {}
  for (const [name, value] of entries) {
    if (!Object.hasOwn(settingParsers, name)) throw new HttpError(400, `unknown setting ${name}`)
    Object.assign(changes, { [name]: settingParsers[name as keyof MachineSettings](value) })
  }
  return changes
}

async function createTaskInput(body: unknown, attachments: Attachments): Promise<CreateTaskInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'a Task must be an object')
  }
  const request = body as Record<keyof CreateTaskRequest, unknown>
  const text = (name: 'title' | 'description' | 'factory' | 'source') => {
    const value = request[name]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be text`)
    return value
  }
  const oneOf = <T extends string>(name: string, value: unknown, allowed: readonly T[]) => {
    if (value === undefined) return undefined
    const found = allowed.find((a) => a === value)
    if (!found) throw new HttpError(400, `${name} must be ${allowed.join(', ')}`)
    return found
  }
  const list = (name: string, value: unknown) => {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw new HttpError(400, `${name} must be a list`)
    return value as unknown[]
  }

  const title = text('title')
  const description = text('description')
  const factory = text('factory')
  const source = sourceUrl(text('source'))
  const priority = oneOf('priority', request.priority, priorities)
  const clarifyDepth = oneOf('clarifyDepth', request.clarifyDepth, clarifyDepths)
  const lead = taskLead(request.lead)
  const blockedBy = list('blockedBy', request.blockedBy)?.map((ref) => {
    if (typeof ref !== 'string') throw new HttpError(400, 'blockedBy must list Task IDs')
    return ref
  })
  const attached = await Promise.all(
    (list('attachments', request.attachments) ?? []).map((item) => {
      const { hash, name, mediaType } = (item ?? {}) as Record<string, unknown>
      if (typeof hash !== 'string' || typeof name !== 'string') {
        throw new HttpError(400, 'an attachment needs a hash and a name')
      }
      return attachments.find({
        hash,
        name,
        mediaType: typeof mediaType === 'string' ? mediaType : '',
      })
    }),
  )
  if (request.start !== undefined && typeof request.start !== 'boolean') {
    throw new HttpError(400, 'start must be true or false')
  }
  return {
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    ...(factory !== undefined && { factory }),
    ...(priority !== undefined && { priority }),
    ...(clarifyDepth !== undefined && { clarifyDepth }),
    ...(lead !== undefined && { lead }),
    ...(blockedBy !== undefined && { blockedBy }),
    ...(attached.length > 0 && { attachments: attached }),
    ...(source !== undefined && { source }),
    ...(request.start !== undefined && { start: request.start }),
  }

  function taskLead(value: unknown) {
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null) {
      throw new HttpError(400, 'lead must be an object')
    }
    const { agent, model, effort } = value as Record<string, unknown>
    const kind = oneOf('lead.agent', agent, agentKinds)
    if (kind === undefined) throw new HttpError(400, 'lead.agent is required')
    if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
      throw new HttpError(400, 'lead.model must be text')
    }
    const level = oneOf('lead.effort', effort, efforts)
    return {
      agent: kind,
      ...(typeof model === 'string' && { model: model.trim() }),
      ...(level !== undefined && { effort: level }),
    }
  }
}

function sourceUrl(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const trimmed = text.trim()
  const parsed = URL.canParse(trimmed) ? new URL(trimmed) : undefined
  if (
    !parsed ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    trimmed.length > 2048 ||
    /\s/.test(trimmed)
  ) {
    throw new HttpError(400, 'source must be a web address starting with https://')
  }
  return trimmed
}

const maxChoices = 6
const maxChoiceLength = 200

function choiceList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string')) {
    throw new HttpError(400, 'choices must be a list of strings')
  }
  const choices = (value as string[]).map(oneLine).filter((c) => c !== '')
  if (choices.length > maxChoices) {
    throw new HttpError(400, `a question has at most ${maxChoices} choices`)
  }
  if (choices.some((c) => [...c].length > maxChoiceLength)) {
    throw new HttpError(400, `a choice is limited to ${maxChoiceLength} characters`)
  }
  return choices.length > 0 ? choices : undefined
}

function outcomeRequest(body: unknown): ReportOutcomeRequest {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (request.outcome === 'advance') {
    return { outcome: 'advance', ...(request.skip === true && { skip: true }) }
  }
  if (request.outcome === 'back') {
    const to = request.to
    if (typeof to !== 'string' || !agentStageIds.includes(to as AgentStageId)) {
      throw new HttpError(400, `to must be one of ${agentStageIds.join(', ')}`)
    }
    const findings = typeof request.findings === 'string' ? request.findings.trim() : ''
    if (findings === '') throw new HttpError(400, '`back` needs Findings')
    return { outcome: 'back', to: to as AgentStageId, findings }
  }
  if (request.outcome === 'ask') {
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (question === '') throw new HttpError(400, 'question is required')
    const choices = choiceList(request.choices)
    return { outcome: 'ask', question, ...(choices && { choices }) }
  }
  throw new HttpError(400, 'outcome must be advance, back or ask')
}

function answerRequest(body: unknown): AnswerRequest {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const text = typeof request.text === 'string' ? request.text : undefined
  if (request.text !== undefined && text === undefined) {
    throw new HttpError(400, 'text must be a string')
  }
  if (request.action === 'approve') {
    return { action: 'approve', ...(text !== undefined && { text }) }
  }
  if (request.action === 'request-changes') {
    return { action: 'request-changes', text: text ?? '' }
  }
  if (request.action === 'answer') {
    if (request.choice !== undefined && typeof request.choice !== 'string') {
      throw new HttpError(400, 'choice must be a string')
    }
    return {
      action: 'answer',
      ...(typeof request.choice === 'string' && { choice: request.choice }),
      ...(text !== undefined && { text }),
    }
  }
  throw new HttpError(400, 'action must be approve, request-changes or answer')
}

function oneLine(text: string): string {
  return [...stripVTControlCharacters(text)]
    .map((c) => (isControl(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

const maxPictureBytes = 512 * 1024
const pictureUrl = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/

const stageIds = ['backlog', ...agentStageIds, 'done'] as const
const statusFilters: readonly StatusFilter[] = [...taskStatusKinds, 'none']

function oneOfList<T extends string>(name: string, value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${name} must be a list`)
  return value.map((item) => {
    const found = allowed.find((a) => a === item)
    if (!found) throw new HttpError(400, `${name} must list only ${allowed.join(', ')}`)
    return found
  })
}

function listFilters(value: unknown): ListFilters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'filters must be an object')
  }
  const given = value as Record<string, unknown>
  const filters: ListFilters = {}
  for (const [name, item] of Object.entries(given)) {
    if (name === 'factories') {
      if (!Array.isArray(item) || item.some((f) => typeof f !== 'string')) {
        throw new HttpError(400, 'factories must list Factory IDs')
      }
      filters.factories = item as string[]
    } else if (name === 'stages') filters.stages = oneOfList(name, item, stageIds)
    else if (name === 'statuses') filters.statuses = oneOfList(name, item, statusFilters)
    else if (name === 'priorities') filters.priorities = oneOfList(name, item, priorities)
    else if (name === 'createdBy') filters.createdBy = oneOfList(name, item, createdByKinds)
    else if (name === 'needsPlanning') {
      if (typeof item !== 'boolean') throw new HttpError(400, 'needsPlanning must be true or false')
      filters.needsPlanning = item
    } else if (name === 'archived') {
      const archived = archivedFilters.find((a) => a === item)
      if (!archived) throw new HttpError(400, `archived must be ${archivedFilters.join(', ')}`)
      filters.archived = archived
    } else throw new HttpError(400, `unknown filter ${name}`)
  }
  return filters
}

function listView(value: unknown): ListView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'a List view must be an object')
  }
  const view = value as Record<string, unknown>
  const sort = listSorts.find((s) => s === view.sort)
  if (!sort) throw new HttpError(400, `sort must be ${listSorts.join(', ')}`)
  const group = listGroups.find((g) => g === view.group)
  if (!group) throw new HttpError(400, `group must be ${listGroups.join(', ')}`)
  const columns = oneOfList('columns', view.columns, listColumns)
  return {
    sort,
    group,
    columns: columns.includes('title') ? columns : ['title', ...columns],
    filters: listFilters(view.filters ?? {}),
  }
}

const settingParsers: { [K in keyof MachineSettings]: (value: unknown) => MachineSettings[K] } = {
  listViews(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, 'listViews must be an object of List views by scope')
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([scope, view]) => [
        scope,
        listView(view),
      ]),
    )
  },
  appearance(value) {
    const appearance = appearances.find((a) => a === value)
    if (!appearance) throw new HttpError(400, `appearance must be ${appearances.join(', ')}`)
    return appearance
  },
  terminalFontSize(value) {
    const { min, max } = terminalFontSizes
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `terminalFontSize must be a whole number from ${min} to ${max}`)
    }
    return value
  },
  profilePicture(value) {
    if (value === null) return null
    if (typeof value !== 'string' || value.length > maxPictureBytes || !pictureUrl.test(value)) {
      throw new HttpError(
        400,
        'profilePicture must be a PNG or JPEG data URL under 512 KB, or null',
      )
    }
    return value
  },
  developerMode(value) {
    if (typeof value !== 'boolean') throw new HttpError(400, 'developerMode must be true or false')
    return value
  },
  maxWorkingRuns(value) {
    const { min, max } = workingRunLimits
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `maxWorkingRuns must be a whole number from ${min} to ${max}`)
    }
    return value
  },
  quitWithWorkRunning(value) {
    const choice = quitChoices.find((c) => c === value)
    if (!choice) throw new HttpError(400, `quitWithWorkRunning must be ${quitChoices.join(', ')}`)
    return choice
  },
  showTrayIcon: onOff('showTrayIcon'),
  startAtLogin: onOff('startAtLogin'),
  stayAwake: onOff('stayAwake'),
}

function onOff(name: keyof MachineSettings): (value: unknown) => boolean {
  return (value) => {
    if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false`)
    return value
  }
}

function repoSource(given: unknown): RepoSource {
  const source = (typeof given === 'object' && given !== null ? given : {}) as Record<
    string,
    unknown
  >
  if (typeof source.folder === 'string') return { folder: source.folder }
  return { remote: typeof source.remote === 'string' ? source.remote : '' }
}

function newRepo(given: unknown): NewFactoryRepo {
  const repo = (typeof given === 'object' && given !== null ? given : {}) as Record<string, unknown>
  return { source: repoSource(repo.source), name: typeof repo.name === 'string' ? repo.name : '' }
}

async function readOptionalJson(req: http.IncomingMessage): Promise<unknown> {
  if (req.headers['content-length'] === '0' || req.headers['content-type'] === undefined) {
    return readJson(req).catch(() => null)
  }
  return readJson(req)
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBodyBytes) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
}

async function drain(req: http.IncomingMessage): Promise<void> {
  if (req.complete || req.destroyed) return
  req.resume()
  await Promise.race([
    once(req, 'end'),
    once(req, 'close'),
    sleep(drainTimeoutMs, undefined, { ref: false }),
  ]).catch(() => undefined)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
