import {
  parseAnswerAutomationRequest,
  parseAutomationCommentRequest,
  parseAutomationNoteTaskRequest,
  parseAutomationReportRequest,
  parseCreateAutomationRequest,
  parseDraftAutomationPromptRequest,
  parseEditAutomationRequest,
  parseSchedulePreviewRequest,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { jsonRoute, type Route } from './route.ts'

const factoryQuery = '(?:\\?factory=([^&]*))?'
const ref = '([^/?]+)'

const path = (pattern: string) => new RegExp(`^${pattern}$`)

export const automationRoutes: Route[] = [
  jsonRoute(parseDraftAutomationPromptRequest, {
    method: 'POST',
    path: path('/automation-prompt-drafts'),
    async handle({ body }, { automations }) {
      return [201, await automations.drafts.start(body)]
    },
  }),
  {
    method: 'GET',
    path: path('/automation-prompt-drafts/([^/]+)'),
    async handle({ caller, params: [id = ''] }, { automations }) {
      if (caller.kind !== 'app') throw new HttpError(403, 'Only the Ted app can read Prompt drafts')
      return [200, automations.drafts.get(id)]
    },
  },
  {
    method: 'DELETE',
    path: path('/automation-prompt-drafts/([^/]+)'),
    async handle({ params: [id = ''] }, { automations }) {
      return [200, await automations.drafts.cancel(id)]
    },
  },
  {
    method: 'GET',
    path: path(`/automations/templates`),
    runToken: true,
    handle: async (_, { automations }) => [200, automations.templates()],
  },
  {
    method: 'GET',
    path: path(`/automations/requests`),
    handle: async (_, { automations }) => [200, automations.requests()],
  },
  jsonRoute(parseSchedulePreviewRequest, {
    method: 'POST',
    path: path(`/automations/schedule-preview`),
    fileToken: true,
    async handle({ body }, { automations }) {
      return [200, automations.preview(body.schedule)]
    },
  }),
  {
    method: 'GET',
    path: path(`/automations${factoryQuery}`),
    runToken: true,
    handle: async ({ caller, params: [factory = ''] }, { automations }) => [
      200,
      await automations.list(caller, factory === '' ? undefined : factory),
    ],
  },
  jsonRoute(parseCreateAutomationRequest, {
    method: 'POST',
    path: path(`/automations`),
    runToken: true,
    async handle({ body, caller }, { automations }) {
      const input = body
      return [201, await automations.create(input, caller)]
    },
  }),
  {
    method: 'GET',
    path: path(`/automations/${ref}${factoryQuery}`),
    runToken: true,
    handle: async ({ caller, params: [id = '', factory = ''] }, { automations }) => [
      200,
      await automations.detail(id, caller, factory === '' ? undefined : factory),
    ],
  },
  jsonRoute(parseEditAutomationRequest, {
    method: 'PATCH',
    path: path(`/automations/${ref}${factoryQuery}`),
    runToken: true,
    async handle({ body, caller, params: [id = '', factory = ''] }, { automations }) {
      const input = body
      return [200, await automations.edit(id, input, caller, factory || undefined)]
    },
  }),
  ...(['enable', 'disable'] as const).map(
    (action): Route => ({
      method: 'POST',
      path: path(`/automations/${ref}/${action}${factoryQuery}`),
      runToken: true,
      ...(action === 'disable' && { fileToken: true as const }),
      handle: async ({ caller, params: [id = '', factory = ''] }, { automations }) => [
        200,
        await automations.setOn(id, action === 'enable', caller, factory || undefined),
      ],
    }),
  ),
  {
    method: 'POST',
    path: path(`/automations/${ref}/run${factoryQuery}`),
    runToken: true,
    handle: async ({ caller, params: [id = '', factory = ''] }, { automations }) => [
      201,
      await automations.runNow(id, caller, factory || undefined),
    ],
  },
  {
    method: 'DELETE',
    path: path(`/automations/${ref}${factoryQuery}`),
    runToken: true,
    async handle({ caller, params: [id = '', factory = ''] }, { automations }) {
      await automations.delete(id, caller, factory || undefined)
      return [200, { deleted: true }]
    },
  },
  {
    method: 'GET',
    path: path(`/automation-runs/${ref}/output`),
    runToken: true,
    handle: async ({ caller, params: [id = ''] }, { automations }) => [
      200,
      await automations.output(id, caller),
    ],
  },
  jsonRoute(parseAutomationReportRequest, {
    method: 'POST',
    path: path('/automation-runs/report'),
    runToken: true,
    async handle({ body, caller }, { automations }) {
      return [200, automations.report(caller, body.summary)]
    },
  }),
  jsonRoute(parseAutomationNoteTaskRequest, {
    method: 'POST',
    path: path(`/automation-runs/tasks/${ref}/note`),
    runToken: true,
    async handle({ body, caller, params: [task = ''] }, { tasks }) {
      return [201, tasks.automationNote(task, caller, body.body)]
    },
  }),
  {
    method: 'POST',
    path: path(`/automation-runs/tasks/${ref}/start`),
    runToken: true,
    async handle({ caller, params: [task = ''] }, { tasks }) {
      return [200, await tasks.automationStart(task, caller)]
    },
  },
  {
    method: 'POST',
    path: path(`/automation-runs/${ref}/retry`),
    runToken: true,
    handle: async ({ caller, params: [id = ''] }, { automations }) => [
      201,
      await automations.retry(id, caller),
    ],
  },
  jsonRoute(parseAutomationCommentRequest, {
    method: 'POST',
    path: path(`/automation-runs/comments`),
    runToken: true,
    async handle({ body, caller }, { automations }) {
      return [201, automations.comment(caller, body)]
    },
  }),
  jsonRoute(parseAnswerAutomationRequest, {
    method: 'POST',
    path: path(`/automation-requests/${ref}/answer`),
    async handle({ body, params: [id = ''] }, { automations }) {
      return [200, await automations.answer(id, body)]
    },
  }),
]
