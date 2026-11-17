import {
  type Attachment,
  archivedTaskDayLimits,
  maxCommitLookups,
  type NewTaskDraft,
  parseAddFailureEvidenceRequest,
  parseAnswerRequest,
  parseAnswerTedStopsRequest,
  parseArchiveTaskRequest,
  parseAsanaImportRequest,
  parseAsanaIntakeRequest,
  parseAssessFailureRequest,
  parseBlockTaskRequest,
  parseCancelMergeRequest,
  parseCloseRoundRequest,
  parseCreateTaskRequest,
  parseDeleteTaskRequest,
  parseDraftLineCommentRequest,
  parseEditLineCommentRequest,
  parseEditTaskRequest,
  parseFollowUpRequest,
  parseGitHubIntakeRequest,
  parseLinearIntakeRequest,
  parseMarkDoneRequest,
  parseMoveTaskRequest,
  parsePostCommentRequest,
  parseRecordFailureRequest,
  parseReportCleanupStepRequest,
  parseReportOutcomeRequest,
  parseRequestArchiveRequest,
  parseResolveFailureRequest,
  parseResumeTaskRequest,
  parseRunChecksRequest,
  parseSaveTaskDraftRequest,
  parseSetActivityRequest,
  parseSetClarifyDepthRequest,
  parseSetPriorityRequest,
  parseSetPullRequestTitleRequest,
  parseSetTaskAutopilotRequest,
  parseSetTaskGatesRequest,
  parseSetTaskParentRequest,
  parseSetTaskReposRequest,
  parseSetTaskSnoozeRequest,
  parseSnoozeRequestRequest,
  parseStartTaskRequest,
  parseTalkThroughRequest,
  parseTaskLead,
  parseUnarchiveTaskRequest,
  parseVerifyFailureRequest,
  parseWriteBriefRequest,
} from '@ted/protocol'
import type { Attachments } from '../attachments.ts'
import { RequestError as HttpError } from '../errors.ts'
import type {
  CreateTaskInput,
  DesignSubmission,
  DesignSubmissionFile,
  OutcomeInput,
} from '../tasks/tasks.ts'
import { jsonRoute, type Route } from './route.ts'

export const taskRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/archive-expiry(?:\?.*)?$/,
    handle: async ({ req }, { archiveCleanup }) => {
      const days = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('days'))
      const { min, max } = archivedTaskDayLimits
      if (!Number.isInteger(days) || days < min || days > max) {
        throw new HttpError(400, `days must be a whole number from ${min} to ${max}`)
      }
      return [200, archiveCleanup.preview(days)]
    },
  },
  {
    method: 'GET',
    path: /^\/ted-stops$/,
    handle: async (_, { tasks }) => [200, tasks.tedStops()],
  },
  jsonRoute(parseAnswerTedStopsRequest, {
    method: 'POST',
    path: /^\/ted-stops\/answer$/,
    async handle({ body }, { tasks }) {
      return [200, await tasks.answerTedStops(body)]
    },
  }),
  jsonRoute(parseSetTaskAutopilotRequest, {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/autopilot$/,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.setTaskAutopilot(ref, caller, body)]
    },
  }),
  jsonRoute(parseAnswerRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/autopilot\/([^/]+)$/,
    runToken: true,
    async handle({ body, params: [ref = '', id = ''], caller }, { tasks }) {
      return [200, await tasks.answerAutopilot(ref, id, caller, body)]
    },
  }),
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/gates$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.taskGates(ref)],
  },
  jsonRoute(parseSetTaskGatesRequest, {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/gates$/,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.setTaskGates(ref, caller, body)]
    },
  }),
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/task-draft$/,
    handle: async ({ params: [factoryId = ''], caller }, { store }) => {
      if (caller.kind !== 'app')
        throw new HttpError(403, 'only the Ted app can read New Task drafts')
      if (!store.getFactory(factoryId)) throw new HttpError(404, 'no such Factory')
      return [200, store.taskDraft(factoryId)]
    },
  },
  jsonRoute(parseSaveTaskDraftRequest, {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/task-draft$/,
    handle: async ({ body, params: [factoryId = ''] }, { store, attachments }) => {
      if (!store.getFactory(factoryId)) throw new HttpError(404, 'no such Factory')
      return [200, store.saveTaskDraft(factoryId, await taskDraftInput(body, attachments))]
    },
  }),
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/failure-contexts\/([^/]+)$/,
    runToken: true,
    handle: async ({ params: [ref = '', id = ''], caller }, { tasks }) => [
      200,
      tasks.failureContext(ref, id, caller),
    ],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/failures$/,
    runToken: true,
    handle: async ({ params: [ref = ''], caller }, { tasks }) => [
      200,
      await tasks.listFailures(ref, caller),
    ],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/validation-obligations$/,
    runToken: true,
    handle: async ({ params: [ref = ''], caller }, { tasks }) => [
      200,
      await tasks.validationObligations(ref, caller),
    ],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/failure-contexts$/,
    runToken: true,
    handle: async ({ params: [ref = ''], caller }, { tasks }) => [
      201,
      await tasks.captureFailureContext(ref, caller),
    ],
  },
  jsonRoute(parseRecordFailureRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/failures$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [201, await tasks.recordFailure(ref, caller, body)]
    },
  }),
  jsonRoute(parseAddFailureEvidenceRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/failures\/([^/]+)\/evidence$/,
    runToken: true,
    async handle({ body, params: [ref = '', id = ''], caller }, { tasks }) {
      return [200, await tasks.addFailureEvidence(ref, caller, id, body.evidence, body.contextId)]
    },
  }),
  jsonRoute(parseAssessFailureRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/failures\/([^/]+)\/assessments$/,
    runToken: true,
    async handle({ body, params: [ref = '', id = ''], caller }, { tasks }) {
      return [200, await tasks.assessFailure(ref, caller, id, body)]
    },
  }),
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/failures\/([^/]+)\/decision$/,
    runToken: true,
    handle: async ({ params: [ref = '', id = ''], caller }, { tasks }) => [
      201,
      await tasks.requestFailureDecision(ref, caller, id),
    ],
  },
  jsonRoute(parseVerifyFailureRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/failures\/([^/]+)\/verification$/,
    runToken: true,
    async handle({ body, params: [ref = '', id = ''], caller }, { tasks }) {
      return [200, await tasks.verifyFailure(ref, caller, id, body.evidence, body.fixedBy)]
    },
  }),
  jsonRoute(parseResolveFailureRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/failures\/([^/]+)\/resolve$/,
    async handle({ body, params: [ref = '', id = ''] }, { tasks }) {
      return [200, await tasks.resolveFailure(ref, id, body)]
    },
  }),

  {
    method: 'GET',
    path: /^\/tasks$/,
    runToken: true,
    handle: async (_, { store }) => [200, store.listTasks()],
  },
  jsonRoute(parseCreateTaskRequest, {
    method: 'POST',
    path: /^\/tasks$/,
    fileToken: true,
    runToken: true,
    async handle({ body, caller }, { tasks, attachments }) {
      return [201, await tasks.create(await createTaskInput(body, attachments), caller)]
    },
  }),
  jsonRoute(parseAsanaImportRequest, {
    method: 'POST',
    path: /^\/tasks\/asana-preview$/,
    fileToken: true,
    runToken: true,
    async handle({ body, caller }, { tasks }) {
      return [200, await tasks.asanaPreview(body, caller)]
    },
  }),
  jsonRoute(parseAsanaImportRequest, {
    method: 'POST',
    path: /^\/tasks\/asana-import$/,
    fileToken: true,
    runToken: true,
    async handle({ body, caller }, { tasks }) {
      return [201, await tasks.importAsana(body, caller)]
    },
  }),
  jsonRoute(parseAsanaIntakeRequest, {
    method: 'POST',
    path: /^\/asana-intake$/,
    fileToken: true,
    runToken: true,
    async handle({ body, caller }, { tasks }) {
      return [200, await tasks.asanaIntake(body, caller)]
    },
  }),
  jsonRoute(parseGitHubIntakeRequest, {
    method: 'POST',
    path: /^\/github-intake$/,
    runToken: true,
    async handle({ body, caller }, { tasks }) {
      return [200, await tasks.githubIntake(body, caller)]
    },
  }),
  jsonRoute(parseLinearIntakeRequest, {
    method: 'POST',
    path: /^\/linear-intake$/,
    fileToken: true,
    runToken: true,
    async handle({ body, caller }, { tasks }) {
      return [200, await tasks.linearIntake(body, caller)]
    },
  }),
  {
    method: 'POST',
    path: /^\/attachments$/,
    fileToken: true,
    runToken: true,
    handle: async ({ req, caller }, { tasks, attachments }) => [
      201,
      await tasks.uploadForCreate(caller, () => attachments.save(req)),
    ],
  },
  {
    method: 'GET',
    path: /^\/attachments\/([^/]+)\/([^/]+)$/,
    async handle({ params: [hash = '', name = ''] }, { attachments }) {
      return [200, await attachments.read({ hash, name })]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/attachments$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks, attachments }) {
      return [201, await tasks.upload(ref, caller, () => attachments.save(req))]
    },
  },
  jsonRoute(parseSetTaskSnoozeRequest, {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/snooze$/,
    async handle({ body, params: [ref = ''] }, { tasks }) {
      return [200, tasks.setTaskSnooze(ref, body.snoozedUntil)]
    },
  }),
  jsonRoute(parseSnoozeRequestRequest, {
    method: 'PUT',
    path: /^\/requests\/([^/]+)\/snooze$/,
    async handle({ body, params: [id = ''] }, { tasks }) {
      return [200, tasks.snoozeRequest(id, body.until)]
    },
  }),
  jsonRoute(parseStartTaskRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/start$/,
    fileToken: true,
    optionalBody: true,
    async handle({ params: [ref = ''], body, caller }, { tasks }) {
      if (body.prepare && caller.kind !== 'app')
        throw new HttpError(403, 'only the Ted app can prepare Tasks')
      return [200, await tasks.start(ref, body)]
    },
  }),
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/backlog$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.moveToBacklog(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/stop$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.stop(ref)],
  },
  jsonRoute(parseResumeTaskRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/resume$/,
    async handle({ body, params: [ref = ''] }, { tasks, attachments }) {
      const files = await attachmentList(body.attachments, attachments)
      return [200, await tasks.resume(ref, { ...body, attachments: files })]
    },
  }),
  jsonRoute(parseMoveTaskRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/move$/,
    async handle({ body, params: [ref = ''] }, { tasks }) {
      return [200, tasks.move(ref, body)]
    },
  }),
  jsonRoute(parseSetPriorityRequest, {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/priority$/,
    async handle({ body, params: [ref = ''] }, { tasks }) {
      return [200, tasks.setPriority(ref, body.priority)]
    },
  }),
  jsonRoute(parseEditTaskRequest, {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)$/,
    async handle({ body, params: [ref = ''] }, { tasks }) {
      return [200, await tasks.edit(ref, body)]
    },
  }),
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/descriptions$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.descriptions(ref)],
  },
  jsonRoute(parseArchiveTaskRequest, {
    optionalBody: true,
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/archive$/,
    async handle({ body, params: [ref = ''] }, { tasks }) {
      return [200, tasks.archive(ref, body)]
    },
  }),
  jsonRoute(parseSetPullRequestTitleRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/pull-request-title$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.setPullRequestTitle(ref, caller, body)]
    },
  }),
  jsonRoute(parseReportCleanupStepRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/cleanup-steps$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [201, await tasks.reportCleanupStep(ref, caller, body)]
    },
  }),
  jsonRoute(parseRequestArchiveRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/archive-request$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [201, await tasks.requestArchive(ref, caller, body)]
    },
  }),
  jsonRoute(parseFollowUpRequest, {
    optionalBody: true,
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/follow-up$/,
    async handle({ body, params: [ref = ''] }, { tasks, attachments }) {
      const files = await attachmentList(body.attachments, attachments)
      return [201, await tasks.followUp(ref, { ...body, attachments: files })]
    },
  }),
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/archive-done$/,
    handle: async ({ params: [key = ''] }, { tasks }) => [200, tasks.archiveDone(key)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/linear-sync$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.allowLinearSync(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/asana-sync$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.allowAsanaSync(ref)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/hierarchy$/,
    runToken: true,
    handle: async ({ params: [ref = ''], caller }, { tasks }) => [
      200,
      tasks.hierarchy(ref, caller),
    ],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/hierarchy\/preview$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.hierarchyPreview(ref)],
  },
  jsonRoute(parseSetTaskParentRequest, {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/parent$/,
    handle: async ({ params: [ref = ''], body }, { tasks }) => [200, tasks.setParent(ref, body)],
  }),
  jsonRoute(parseUnarchiveTaskRequest, {
    optionalBody: true,
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/unarchive$/,
    handle: async ({ params: [ref = ''], body }, { tasks }) => [
      200,
      await tasks.unarchive(ref, body),
    ],
  }),
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/reset$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.reset(ref)],
  },
  jsonRoute(parseDeleteTaskRequest, {
    optionalBody: true,
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/delete$/,
    async handle({ body, params: [ref = ''] }, { tasks }) {
      await tasks.delete(ref, body)
      return [200, {}]
    },
  }),
  jsonRoute(parseBlockTaskRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/blockers$/,
    fileToken: true,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.block(ref, caller, body.by)]
    },
  }),
  {
    method: 'DELETE',
    path: /^\/tasks\/([^/]+)\/blockers(?:\/([^/]+))?$/,
    fileToken: true,
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
  jsonRoute((value) => parseTaskLead(value), {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/lead$/,
    fileToken: true,
    async handle({ body, params: [ref = ''] }, { tasks }) {
      return [200, tasks.setLead(ref, body)]
    },
  }),
  jsonRoute(parseSetClarifyDepthRequest, {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/clarify-depth$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      if (caller.kind === 'run' && !body.why)
        throw new HttpError(400, 'say why you picked this depth')
      return [200, await tasks.setClarifyDepth(ref, caller, body)]
    },
  }),
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/lead\/use-default-model$/,
    fileToken: true,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.useDefaultModel(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/lead\/restart$/,
    fileToken: true,
    waits: true,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.restartLead(ref)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/comments$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listComments(task.id).filter((c) => !c.held)]
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
  jsonRoute(parseSetTaskReposRequest, {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/repos$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.setRepos(ref, caller, body)]
    },
  }),
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/repos\/([^/]+)\/setup$/,
    runToken: true,
    async handle({ params: [ref = '', name = ''], caller }, { tasks }) {
      return [200, await tasks.repoSetup(ref, name, caller)]
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
    path: /^\/tasks\/([^/?]+)\/files$/,
    async handle({ params: [ref = ''], caller }, { tasks }) {
      if (caller.kind !== 'app') throw new HttpError(403, 'only the Ted app can read files')
      return [200, await tasks.files(ref)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/?]+)\/repos\/([^/?]+)\/file(?:\?.*)?$/,
    async handle({ req, params: [ref = '', repo = ''], caller }, { tasks }) {
      if (caller.kind !== 'app') throw new HttpError(403, 'only the Ted app can read files')
      const relative = new URL(req.url ?? '/', 'http://localhost').searchParams.get('path') ?? ''
      return [200, await tasks.file(ref, repo, relative)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/?]+)\/pull-request-changes\/([^/?]+)$/,
    async handle({ params: [ref = '', repo = ''], caller }, { tasks }) {
      if (caller.kind !== 'app') throw new HttpError(403, 'only the Ted app can read PR changes')
      return [200, await tasks.pullRequestChanges(ref, repo)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/?]+)\/changes$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.changes(ref)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/?]+)\/changes\/([^/?]+)\/diffs(?:\?.*)?$/,
    async handle({ req, params: [ref = '', name = ''] }, { tasks }) {
      const file = new URL(req.url ?? '/', 'http://localhost').searchParams.get('path') ?? undefined
      return [200, await tasks.fileDiffs(ref, name, file)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/?]+)\/commits(?:\?.*)?$/,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      if (caller.kind !== 'app') throw new HttpError(403, 'only the Ted app can look up commits')
      const ids = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ids') ?? ''
      return [200, await tasks.commits(ref, ids.split(',').slice(0, maxCommitLookups))]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/?]+)\/commits\/([^/?]+)$/,
    async handle({ params: [ref = '', commit = ''], caller }, { tasks }) {
      if (caller.kind !== 'app') throw new HttpError(403, 'only the Ted app can read a commit')
      return [200, await tasks.commitChanges(ref, commit)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/line-comments$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.lineComments(ref)],
  },
  jsonRoute(parseDraftLineCommentRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/line-comments$/,
    async handle({ body, params: [ref = ''] }, { tasks }) {
      return [201, await tasks.draftLineComment(ref, body)]
    },
  }),
  {
    method: 'DELETE',
    path: /^\/tasks\/([^/]+)\/line-comments$/,
    async handle({ params: [ref = ''] }, { tasks }) {
      tasks.discardLineComments(ref)
      return [200, {}]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/line-comments\/send$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [201, await tasks.sendLineComments(ref)],
  },
  jsonRoute(parseEditLineCommentRequest, {
    method: 'PATCH',
    path: /^\/line-comments\/([^/]+)$/,
    async handle({ body, params: [id = ''] }, { tasks }) {
      return [200, tasks.editLineComment(id, body.body)]
    },
  }),
  {
    method: 'DELETE',
    path: /^\/line-comments\/([^/]+)$/,
    async handle({ params: [id = ''] }, { tasks }) {
      tasks.deleteLineComment(id)
      return [200, {}]
    },
  },
  jsonRoute(parsePostCommentRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/comments$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks, attachments }) {
      const files = await attachmentList(body.attachments, attachments)
      return [
        201,
        await tasks.comment(ref, caller, { ...body, body: body.body ?? '', attachments: files }),
      ]
    },
  }),
  jsonRoute(parseCancelMergeRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/cancel-merge$/,
    async handle({ body, params: [ref = ''] }, { tasks, attachments }) {
      const files = await attachmentList(body.attachments, attachments)
      return [201, await tasks.cancelMerge(ref, body.comment, files)]
    },
  }),
  jsonRoute(parseMarkDoneRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/mark-done$/,
    optionalBody: true,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.markDone(ref)],
  }),
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/done$/,
    runToken: true,
    handle: async ({ params: [ref = ''], caller }, { tasks }) => [
      200,
      await tasks.leadDone(ref, caller),
    ],
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
  jsonRoute(parseWriteBriefRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/brief$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [201, tasks.writeBrief(ref, caller, body.text)]
    },
  }),
  {
    method: 'GET',
    path: /^\/inbox$/,
    handle: async (_, { tasks }) => [200, tasks.inbox()],
  },
  {
    method: 'GET',
    path: /^\/inbox\/answered$/,
    handle: async (_, { tasks }) => [200, tasks.answered()],
  },
  {
    method: 'GET',
    path: /^\/inbox\/waiting$/,
    handle: async (_, { store }) => [200, store.waiting()],
  },
  {
    method: 'GET',
    path: /^\/inbox\/snoozed$/,
    handle: async (_, { store }) => [200, store.snoozed()],
  },
  jsonRoute(parseTalkThroughRequest, {
    method: 'POST',
    path: /^\/comments\/([^/]+)\/talk$/,
    optionalBody: true,
    handle: async ({ params: [id = ''], body }, { tasks }) => [
      200,
      await tasks.talkThrough(id, body),
    ],
  }),
  {
    method: 'POST',
    path: /^\/comments\/([^/]+)\/done-talking$/,
    handle: async ({ params: [id = ''] }, { tasks }) => [200, await tasks.doneTalking(id)],
  },
  jsonRoute(parseCloseRoundRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/rounds\/close$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.closeRound(ref, caller, body.summary)]
    },
  }),
  jsonRoute(parseAnswerRequest, {
    method: 'POST',
    path: /^\/comments\/([^/]+)\/answer$/,
    async handle({ body, params: [id = ''] }, { tasks }) {
      return [200, await tasks.answer(id, body)]
    },
  }),
  jsonRoute(parseSetActivityRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/activity$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [200, tasks.setActivity(ref, caller, body.text)]
    },
  }),
  jsonRoute(parseReportOutcomeRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/outcome$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks, attachments }) {
      const outcome = await outcomeRequest(body, attachments)
      return [200, await tasks.reportOutcome(ref, caller, outcome)]
    },
  }),
  jsonRoute(parseRunChecksRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/checks$/,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [201, await tasks.runChecks(ref, caller, body.name)]
    },
  }),
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
    path: /^\/tasks\/([^/]+)\/base-conflicts$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.baseConflicts(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/task-defaults$/,
    handle: async ({ params: [id = ''] }, { tasks }) => [200, await tasks.defaults(id)],
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/board$/,
    handle: async ({ params: [id = ''] }, { tasks }) => [200, await tasks.board(id)],
  },
]

async function attachmentList(
  value: import('@ted/protocol').AttachmentRef[] | undefined,
  attachments: Attachments,
): Promise<Attachment[]> {
  return Promise.all((value ?? []).map((file) => attachments.find(file)))
}

async function createTaskInput(
  parsed: import('@ted/protocol').CreateTaskRequest,
  attachments: Attachments,
): Promise<CreateTaskInput> {
  const { attachments: files, ...rest } = parsed
  return { ...rest, ...(files && { attachments: await attachmentList(files, attachments) }) }
}

async function taskDraftInput(
  parsed: import('@ted/protocol').SaveTaskDraftRequest,
  attachments: Attachments,
): Promise<NewTaskDraft> {
  return { ...parsed, attachments: await attachmentList(parsed.attachments, attachments) }
}

async function outcomeRequest(
  parsed: import('@ted/protocol').ReportOutcomeRequest,
  attachments: Attachments,
): Promise<OutcomeInput> {
  if (parsed.outcome !== 'advance') return parsed
  const { design: input, ...outcome } = parsed
  if (!input) return outcome
  const { screenshots, video, prototype, ...rest } = input
  const resolve = async (
    file: import('@ted/protocol').DesignFileInput,
    role: string,
    types: readonly string[],
  ): Promise<DesignSubmissionFile> => {
    const saved = await attachments.find(file)
    if (!types.includes(saved.mediaType))
      throw new HttpError(400, `${saved.name} can’t be the ${role}; ${roleTypes[role] ?? ''}`)
    return { ...saved, ...(file.caption !== undefined && { caption: file.caption }) }
  }
  const design: DesignSubmission = {
    ...rest,
    ...(screenshots && {
      screenshots: await Promise.all(
        screenshots.map((file) => resolve(file, 'screenshot', imageTypes)),
      ),
    }),
    ...(video && { video: await resolve(video, 'video', videoTypes) }),
    ...(prototype && { prototype: await resolve(prototype, 'prototype', ['text/html']) }),
  }
  return { ...outcome, design }
}
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']
const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime']
const roleTypes: Record<string, string> = {
  screenshot: 'a screenshot is a PNG, JPEG, GIF, WebP or SVG image',
  video: 'the video is an MP4, WebM or QuickTime file',
  prototype: 'the prototype is an HTML file',
}
