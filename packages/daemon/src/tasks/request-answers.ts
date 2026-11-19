import type {
  AgentStageId,
  AnswerRequest,
  ArchiveTaskRequest,
  Attachment,
  Comment,
  CommentAnswer,
  FailureCase,
  PullRequestCiMode,
  ResolveFailureRequest,
  Run,
  SaveSettingsResult,
  SendBack,
  Task,
  TaskRepo,
} from '@ted/protocol'
import {
  archiveChoice,
  failureChoiceKeys,
  failureChoiceLabels,
  isTrackerClosedQuestion,
  keepArchiveChoice,
  namedRepairChoice,
  sizeChoices,
} from '@ted/protocol'
import {
  bindsApproval,
  handsOff,
  hasClarifyRounds,
  mergesHere,
  signsOffCode,
  stageWith,
  validates,
} from '@ted/protocol/stage'
import { keepMoveChoice, moveChoice, type TaskMoved } from '@ted/protocol/task-move'
import type { Simulators } from '../apps/simulators.ts'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import { isEarlierStage, type ResolvedWorkflow } from '../workflow/resolve.ts'
import { backStageMessage, nextStageMessage, stageTitle } from '../workflow/workflow.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import { answerMessage } from './answer-message.ts'
import { entersMerge } from './cleanup.ts'
import { type createFailureCases, failureText } from './failure-cases.ts'
import { leadPending, mergeAnywayChoice, noCiAgainRepo, sendToLeadChoice } from './merge-watcher.ts'
import { checkPreparationWorkflow } from './preparation.ts'
import { approvedShape, createProposalTasks } from './proposal-tasks.ts'
import { roundAnswerMessage, roundAnswers } from './rounds.ts'
import {
  grillAnywayMessage,
  planInChatMessage,
  proposalChangesMessage,
  splitApprovedMessage,
  splitChosenMessage,
} from './split.ts'
import type { TrackerConsent } from './tracker-sync/consent.ts'
import { archiveChoice as trackerArchiveChoice } from './tracker-sync/sync.ts'
import { StaleCoverageError } from './validation.ts'
import { type WorktreeReads, worktreeReads } from './worktree-reads.ts'

export interface RequestAnswerPort {
  store: TedStore
  untilFree(id: string): Promise<void>
  untilChecksReported(id: string): Promise<void>
  find(id: string): StoredTask
  holding<T>(task: Task, work: () => Promise<T>): Promise<T>
  holdingSignoff<T>(task: Task, work: () => Promise<T>): Promise<T>
  failures: Pick<ReturnType<typeof createFailureCases>, 'findDecision' | 'resolve'>
  waitForRepair(
    taskId: string,
    failureId: string,
    input: ResolveFailureRequest,
  ): Promise<FailureCase>
  humanComment(
    task: StoredTask,
    text: string,
    files: readonly Attachment[],
    sendDrafts: boolean,
  ): Promise<Comment>
  answerRunPermission: RunManager['answerPermission']
  withSimulatorRequest: Simulators['withRequest']
  mergeSendBack(id: string, findings: string): Promise<unknown>
  startTask(id: string): Promise<unknown>
  planOutside(task: StoredTask, comment: Comment): void
  stopLeadForChildren(taskId: string): Promise<void>
  waitForChildren(taskId: string, childIds: readonly string[], from: 'split'): void
  planning?: () =>
    | {
        fromTask(input: {
          taskId: string
          sizeCheckId: string
          text: string
        }): Promise<{ id: string; title: string }>
      }
    | undefined
  resumeByHand(id: string, options: { comment: string; sendDrafts: boolean }): Promise<Task>
  drafts(id: string): string[]
  deliverAnswer(task: Task, comment: Comment, text: string): Promise<void>
  gateWorkflow(task: StoredTask, options?: { reads?: WorktreeReads }): Promise<WorkflowResolution>
  requireObligations(
    task: StoredTask,
    target?: AgentStageId | 'done',
    reads?: WorktreeReads,
  ): Promise<void>
  checksThen(taskId: string, action: () => Promise<unknown>): Promise<void>
  bindApproval(task: StoredTask, comment: Comment, workflow: ResolvedWorkflow): Promise<void>
  requireSetupAgents(task: StoredTask): Promise<void>
  liveLead(task: Task): Run | undefined
  startMerging(task: StoredTask, workflow: ResolvedWorkflow): void
  watchMerge(id: string): void
  deliver(task: Task, text: string): Promise<boolean>
  move(
    task: StoredTask,
    resolution: WorkflowResolution,
    next: AgentStageId | 'done',
    message: string | undefined,
    options?: { signedOff?: boolean; reads?: WorktreeReads },
  ): Promise<Task>
  backMessage(
    workflow: ResolvedWorkflow,
    to: AgentStageId,
    from: AgentStageId,
    sendBack: SendBack,
  ): string
  leaveWorkToDiagnose(task: StoredTask): Promise<(message: string) => Promise<Task>>
  diagnoseInValidate(task: StoredTask, message: string): void
  stop(id: string): Promise<Task>
  settleDependents(id: string): void
  beforeArchive?(task: StoredTask): void
  archiveNow(task: StoredTask, close: boolean): Task
  archiveAsked(task: StoredTask, options: ArchiveTaskRequest): () => Task
  movePlanKey(
    taskId: string,
    factoryId: string,
    requestId: string,
  ): Promise<{ key: string; refusal?: string }>
  moveTask(taskId: string, factoryId: string, planKey: string): Promise<TaskMoved>
  tellChat(chatId: string, text: string): Promise<void>
  wake(): void
  sendNudge(task: StoredTask, run: Run): Promise<void>
  restartFromBrief(task: StoredTask, asked: Comment, answer: () => void): Promise<void>
  useDefaultModel(id: string): Promise<Task>
  linesText(comment: Comment): string | undefined
  gateName(comment: Comment): string
  firstLine(text: string): string
  answerAsanaMissing(
    task: Task,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment>
  answerAsanaUnfinished(
    task: Task,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment>
  trackerConsents: readonly TrackerConsent[]
  answerCleanupFailure(
    task: StoredTask,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment>
  answerMemoryKill(
    task: StoredTask,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment>
  answerCheckReport(
    task: StoredTask,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment>
  setPullRequestCi?(
    factoryId: string,
    repo: string,
    mode: PullRequestCiMode,
  ): Promise<SaveSettingsResult>
}

export function createRequestAnswers(
  port: RequestAnswerPort,
  automatic?: { guard(comment: Comment): Promise<void> },
) {
  const {
    store,
    untilFree,
    untilChecksReported,
    find,
    holding,
    holdingSignoff,
    failures,
    humanComment,
    answerRunPermission,
    withSimulatorRequest,
    mergeSendBack,
    startTask,
    planOutside,
    stopLeadForChildren,
    waitForChildren,
    planning,
    resumeByHand,
    drafts,
    deliverAnswer,
    gateWorkflow,
    requireObligations,
    checksThen,
    bindApproval,
    requireSetupAgents,
    liveLead,
    startMerging,
    watchMerge,
    deliver,
    move,
    backMessage,
    leaveWorkToDiagnose,
    diagnoseInValidate,
    stop,
    settleDependents,
    archiveNow,
    archiveAsked,
    movePlanKey,
    moveTask,
    tellChat,
    wake,
    sendNudge,
    restartFromBrief,
    useDefaultModel,
    linesText,
    gateName,
    firstLine,
    answerAsanaMissing,
    answerAsanaUnfinished,
    trackerConsents,
    answerCleanupFailure,
    answerMemoryKill,
    answerCheckReport,
  } = port
  const answerRequest = (
    task: Task,
    comment: Comment,
    answer: CommentAnswer,
    lineComments?: readonly string[],
    queueAnswer = false,
  ) =>
    answerTaskRequest(
      store,
      task,
      comment,
      answer,
      lineComments,
      automatic !== undefined,
      queueAnswer,
    )
  const nudgeAgainChoice = 'Nudge again'
  const restartFromBriefChoice = 'Restart from the brief'
  const useDefaultChoice = 'Use the default model'
  const retryChoice = 'Retry'
  function unanswered(comment: Comment): void {
    const current = store.getComment(comment.id)
    if (current?.answer?.kind === 'withdrawn') {
      throw new RequestError(409, 'this request was withdrawn')
    }
    if (current?.answer?.kind === 'superseded') {
      throw new RequestError(409, 'this request was replaced by a newer one')
    }
    if (current?.answer) throw new RequestError(409, 'this request has already been answered')
  }

  async function answerCiStuck(
    task: StoredTask,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment> {
    const noCiRepo = comment.choices?.includes(choice ?? '')
      ? noCiAgainRepo(task.repos, choice)
      : undefined
    const answered = await holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn: CI reported before you answered')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      if (choice === mergeAnywayChoice || noCiRepo) await requireObligations(find(task.id))
      return store.answerComment(comment.id, {
        kind: 'answered',
        at: new Date().toISOString(),
        ...(choice !== undefined && { choice }),
        ...(text !== '' && { text }),
      })
    })
    if (choice === sendToLeadChoice) {
      await mergeSendBack(
        task.id,
        [
          `Ted asked the human about CI at Merge: ${comment.title ?? ''}.`,
          comment.body.split('\n\n')[0] ?? '',
          'The human sent it to you. Find out why CI hasn’t reported (a workflow that doesn’t run on this branch, a missing runner, a check that hangs), fix what belongs in this Task, and say what you found in the brief. The Task comes back through Validate for a short re-sign-off.',
          ...(text !== '' ? [`The human added: ${text}`] : []),
        ].join('\n\n'),
      )
    } else if (noCiRepo) {
      void saveNoPullRequestCi(task, noCiRepo)
    } else if (choice === undefined && text !== '') {
      await deliverAnswer(task, answered, `The human answered “${comment.title ?? ''}”:\n\n${text}`)
    }
    return store.getComment(comment.id) ?? answered
  }

  async function saveNoPullRequestCi(task: StoredTask, repo: TaskRepo): Promise<void> {
    const setting = `“Pull request CI: None” for ${repo.name}`
    const note = (body: string) => {
      if (store.getTask(task.id))
        store.postComment({ taskId: task.id, author: { kind: 'ted' }, body })
    }
    if (!port.setPullRequestCi) {
      note(
        `Ted couldn’t save ${setting}: Factory settings aren’t available. This Task still merges without waiting for CI.`,
      )
      return
    }
    try {
      const saved = await port.setPullRequestCi(task.factoryId, repo.repo, 'none')
      const link = `[#${saved.pullRequest.number}](${saved.pullRequest.url})`
      note(
        saved.merged
          ? `Saved ${setting} in the Factory settings through ${link}, which Ted merged. Ted won’t wait for CI on ${repo.name}’s pull requests from now on; change Pull request CI in Factory settings to undo it.`
          : `Ted opened ${link} to save ${setting}, but couldn’t merge it${saved.reason ? `: ${saved.reason}` : '.'} Merge it on GitHub to keep the setting. This Task still merges without waiting for CI.`,
      )
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error))
      note(
        `Ted couldn’t save ${setting}: ${message} This Task still merges without waiting for CI.`,
      )
    }
  }

  async function mergeAnywayAfterFailure(
    task: StoredTask,
    comment: Comment,
    text: string,
  ): Promise<Comment> {
    const answered = await holding(task, async () => {
      const current = find(task.id)
      if (store.getComment(comment.id)?.answer)
        throw new RequestError(409, 'this request has already been answered')
      if (!mergesHere(current.stage) || !leadPending(store, task.id))
        throw new RequestError(
          409,
          `Merge anyway applies only while ${task.displayId} is at Merge and its Merge work isn’t done`,
        )
      const reply = store.answerComment(comment.id, {
        kind: 'answered',
        at: new Date().toISOString(),
        choice: mergeAnywayChoice,
        ...(text !== '' && { text }),
      })
      store.mergeLeadAdvanced(task.id, 'human')
      store.postComment({
        taskId: task.id,
        author: { kind: 'ted' },
        body: 'The human chose Merge anyway, so the Task Lead’s Merge work was skipped. Ted merges as it would after the Task Lead’s advance: once CI passes, and after the Merge sign-off if it is on.',
      })
      return reply
    })
    watchMerge(task.id)
    return answered
  }

  async function answerProposal(
    task: StoredTask,
    comment: Comment,
    request: AnswerRequest,
  ): Promise<Comment> {
    const proposal = comment.proposal
    if (!proposal) throw new RequestError(409, 'this proposal has no rows')
    const text = 'text' in request ? (request.text?.trim() ?? '') : ''
    if (request.action === 'request-changes') {
      if (text === '') throw new RequestError(400, 'Request changes needs your comment')
      return holding(task, async () => {
        unanswered(comment)
        const at = new Date().toISOString()
        const answered = answerRequest(task, comment, { kind: 'changes-requested', at, text })
        await deliverAnswer(task, comment, proposalChangesMessage(text))
        return answered
      })
    }
    if (request.action !== 'approve') {
      throw new RequestError(400, 'answer a proposal with Create Tasks or Request changes')
    }
    const { skip, shape: plan } = approvedShape(proposal, request.proposal?.skip)
    const startUnblocked = request.proposal?.startUnblocked === true
    const result = await holding(task, async () => {
      unanswered(comment)
      const current = find(task.id)
      if (current.archived) throw new RequestError(409, `${task.displayId} is archived`)
      await stopLeadForChildren(task.id)
      const created = await createProposalTasks(store, proposal, plan, {
        parentId: task.id,
        factoryId: current.factoryId,
        fields: () => ({ ...(current.lead && { lead: current.lead }), splitFrom: task.id }),
      })
      waitForChildren(
        task.id,
        created.map((c) => c.id),
        'split',
      )
      const outcome = { tasks: created, skipped: skip, startUnblocked }
      const answered = answerRequest(task, comment, {
        kind: 'approved',
        at: new Date().toISOString(),
        ...(text !== '' && { text }),
        created: outcome,
      })
      await deliverAnswer(task, comment, splitApprovedMessage({ proposal, created: outcome, text }))
      return { answered, created }
    })
    if (startUnblocked) {
      for (const piece of result.created) {
        if (!plan.unblocked.includes(piece.row)) continue
        await startTask(piece.id).catch((error: unknown) => {
          console.error(redactSecrets(`couldn’t start ${piece.displayId}: ${String(error)}`))
        })
      }
    }
    wake()
    return store.getComment(comment.id) ?? result.answered
  }

  async function answerSizeCheck(
    task: StoredTask,
    comment: Comment,
    choice: string,
    text: string,
  ): Promise<Comment> {
    if (!comment.sizeCheck) throw new RequestError(400, 'this question has no size check')
    if (!Object.values(sizeChoices).some((value) => value === choice))
      throw new RequestError(400, 'choose a size-check option')
    if (choice === sizeChoices.chat) return planInChat(task, comment, text)
    return holding(task, async () => {
      unanswered(comment)
      const at = new Date().toISOString()
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at,
        choice,
        ...(text !== '' && { text }),
      })
      if (choice === sizeChoices.split) {
        await deliverAnswer(task, comment, splitChosenMessage(text))
      } else if (choice === sizeChoices.grill) {
        store.setClarifyDepth(task.id, { depth: 'grilling', by: 'human' })
        await deliverAnswer(task, comment, grillAnywayMessage(text))
      } else {
        planOutside(find(task.id), comment)
      }
      return store.getComment(comment.id) ?? answered
    })
  }

  async function planInChat(task: StoredTask, comment: Comment, text: string): Promise<Comment> {
    const planner = planning?.()
    if (!planner) throw new RequestError(503, 'Planning chats aren’t ready yet. Try again.')
    return holding(task, async () => {
      unanswered(comment)
      if (!hasClarifyRounds(find(task.id).stage)) {
        throw new RequestError(409, `${task.displayId} has left Clarify`)
      }
      const plan = await planner.fromTask({ taskId: task.id, sizeCheckId: comment.id, text })
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at: new Date().toISOString(),
        choice: sizeChoices.chat,
        ...(text !== '' && { text }),
        planId: plan.id,
      })
      await deliverAnswer(task, comment, planInChatMessage(plan.title))
      return store.getComment(comment.id) ?? answered
    })
  }

  async function answerLoopAsk(
    task: StoredTask,
    comment: Comment,
    choice: string | undefined,
    text: string,
    at: string,
  ): Promise<Comment | undefined> {
    const ask = store.sendBackAsk(comment.id)
    if (!ask) throw new RequestError(409, 'this send-back request has no recorded decision')
    if (handsOff(ask.from) && handsOff(ask.to) && choice === diagnoseChoice) {
      const current = find(task.id)
      const enterValidate = await leaveWorkToDiagnose(current)
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at,
        choice,
        ...(text !== '' && { text }),
      })
      if (!liveLead(current)) store.holdAnswer(comment.id)
      await enterValidate(
        [
          `The human answered “${comment.title ?? firstLine(comment.body)}” with ${diagnoseChoice}, so Ted moved this Task to Validate although the checks didn’t pass in Work. Ted runs the checks at entry. A check that fails there is a failure case: assess it as Validate’s instructions say, and the human can then choose Retry, Fix in this Task or Accept this failure.`,
          ...(text !== '' ? [`The human added:\n\n${text}`] : []),
        ].join('\n\n'),
      )
      return answered
    }
    if (handsOff(ask.from) && handsOff(ask.to) && choice === tryAgainChoice) {
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at,
        choice,
        ...(text !== '' && { text }),
      })
      await deliverAnswer(
        task,
        comment,
        [
          `The human answered “${comment.title ?? firstLine(comment.body)}” with ${tryAgainChoice}. The Task stays in Work. Fix what the check reports and nothing else, commit, then report \`ted outcome advance\` again. Ted now runs the Factory’s checks when the Task enters Validate; if one fails, the Task comes back to Work with the output.`,
          ...(text !== '' ? [`The human added:\n\n${text}`] : []),
        ].join('\n\n'),
      )
      return answered
    }
    if (!ask.loop || choice === undefined) return undefined
    if (!(comment.choices ?? []).includes(choice)) return undefined
    const current = find(task.id)
    if (!validates(current.stage)) return undefined
    const reads = worktreeReads()
    const resolution = await gateWorkflow(current, { reads })
    const { workflow } = resolution
    const next = workflow.next(stageWith('validates')) as AgentStageId | 'done'
    if (choice === diagnoseChoice) {
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at,
        choice,
        ...(text !== '' && { text }),
      })
      if (!liveLead(current)) store.holdAnswer(comment.id)
      diagnoseInValidate(
        current,
        [
          `The human answered “${comment.title ?? firstLine(comment.body)}” with ${diagnoseChoice}, so the Task stays in Validate with the check failing. Ted runs the checks again now. A check that fails stays in Validate as a failure case: assess it as Validate’s instructions say, and the human can then choose Retry, Fix in this Task or Accept this failure.`,
          ...(text !== '' ? [`The human added:\n\n${text}`] : []),
        ].join('\n\n'),
      )
      return answered
    }
    const stopping = choice === stopTaskChoice
    const keepGoing = choice === keepGoingChoice || choice === tryAgainChoice
    const legacy = !keepGoing && !stopping
    if (legacy && !legacyLoopChoices(workflow).includes(choice)) return undefined
    if (keepGoing || stopping) checkBack(workflow, stageWith('validates'), ask.to)
    if (choice === backToDesignChoice)
      checkBack(workflow, stageWith('validates'), stageWith('designReview'))
    if (legacy && choice !== backToDesignChoice) await requireObligations(current, undefined, reads)
    const added = text === '' ? '' : `\n\nThe human added:\n\n${text}`
    const answered = answerRequest(task, comment, {
      kind: 'answered',
      at,
      choice,
      ...(text !== '' && { text }),
    })
    if (stopping && !find(task.id).stopped) await stop(task.id)
    if (keepGoing || stopping) {
      const limit = workflow.settings.stages.validate?.max_back
      const sentBack = store.recordSendBack({
        taskId: task.id,
        from: 'validate',
        to: ask.to,
        findings: ask.findings,
        counted: true,
        round: 1,
        ...(limit !== undefined && { limit }),
        ...(ask.checkRunId !== undefined && { checkRunId: ask.checkRunId }),
        cause: ask.cause ?? (ask.checkRunId !== undefined ? 'check' : 'review'),
      })
      const back = backMessage(workflow, ask.to, stageWith('validates'), sentBack)
      if (stopping) {
        await move(find(task.id), resolution, ask.to, undefined)
        store.holdLeadMessage(
          task.id,
          `The human answered “${comment.title ?? firstLine(comment.body)}” with ${stopTaskChoice}, so Ted moved the Task back to Work and stopped it there. Validate’s count of returns to Work starts over.${added}\n\n${back}`,
        )
        await store.persisted()
        return answered
      }
      await move(
        current,
        resolution,
        ask.to,
        `The human chose ${choice}, so Validate’s count of returns to Work starts over.${added}\n\n${back}`,
      )
    } else if (choice === backToDesignChoice) {
      store.recordSendBack({
        taskId: task.id,
        from: 'validate',
        to: 'design',
        findings: ask.findings,
        counted: false,
        cause: 'human',
      })
      await move(
        current,
        resolution,
        stageWith('designReview'),
        `The human sent this Task back to Design from Validate.${added}\n\n${backStageMessage(workflow, stageWith('designReview'), stageWith('validates'), ask.findings)}`,
      )
    } else {
      const open = `# Open findings\n\nThe human chose “${choice}” with Validate’s blocking findings still open. Put them in the Task brief under “Current state” so the human sees them at ${stageTitle(next)}:\n\n${ask.findings}`
      await move(
        current,
        resolution,
        next,
        next === 'done'
          ? undefined
          : `The human moved this Task on from Validate.${added}\n\n${nextStageMessage(workflow, next)}\n\n${open}`,
        { reads },
      )
    }
    return answered
  }

  async function answerSimulator(
    comment: Comment,
    request: AnswerRequest,
    text: string,
  ): Promise<Comment> {
    if (!comment.simulator) throw new RequestError(400, 'this request has no simulator')
    return withSimulatorRequest(comment, async (simulator) => {
      unanswered(comment)
      const at = new Date().toISOString()
      if (request.action === 'deny') {
        return store.answerPermission(comment.id, {
          kind: 'denied',
          at,
          ...(text !== '' && { text }),
        })
      }
      if (request.action !== 'approve')
        throw new RequestError(
          400,
          'answer a simulator request with a simulator to shut down, or Deny',
        )
      simulator.assertApp()
      if (store.newWorkHold() !== undefined) {
        throw new RequestError(
          409,
          'The disk is almost full, so Ted holds new Apps until there’s space',
        )
      }
      if (await simulator.hasRoom()) {
        await simulator.boot()
        return store.answerPermission(comment.id, { kind: 'withdrawn', at, slotFreed: true })
      }
      if (request.simulator === undefined)
        throw new RequestError(400, 'pick the simulator to shut down')
      const owner = await simulator.shutDown(request.simulator)
      await simulator.boot()
      return store.answerPermission(comment.id, {
        kind: 'approved',
        at,
        shutDown: owner,
        ...(text !== '' && { text }),
      })
    })
  }

  async function answerRound(task: Task, comment: Comment, request: AnswerRequest, mark?: string) {
    if (!comment.round) throw new RequestError(409, 'this round has no questions')
    const answers = roundAnswers(comment.round, request)
    return holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn')
      }
      if (current?.answer?.kind === 'superseded') {
        throw new RequestError(409, 'this request was replaced by a newer one')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      if (automatic) await automatic.guard(comment)
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at: new Date().toISOString(),
        answers,
        ...(mark !== undefined && { text: mark }),
      })
      const message = roundAnswerMessage(comment, answers, find(task.id).clarifyDepth).replaceAll(
        'The human',
        automatic ? 'Autopilot' : 'The human',
      )
      await deliverAnswer(task, comment, mark === undefined ? message : `${mark}\n\n${message}`)
      return answered
    })
  }

  async function answerPermission(
    task: Task,
    comment: Comment,
    request: AnswerRequest,
    text: string,
  ): Promise<Comment> {
    if (request.action !== 'approve' && request.action !== 'deny') {
      throw new RequestError(400, 'answer a permission request with Approve or Deny')
    }
    const target = store.permissionTarget(comment.id)
    if (!target) throw new RequestError(409, 'this request can’t be answered')
    return holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      if (store.getRun(target.runId)?.state === 'finished') {
        throw new RequestError(409, 'the Run that asked has stopped')
      }
      const approved = request.action === 'approve'
      const at = new Date().toISOString()
      const answered = store.answerPermission(comment.id, {
        kind: approved ? 'approved' : 'denied',
        at,
        ...(text !== '' && { text }),
      })
      const said = permissionMessage(approved, target.command, text)
      await answerRunPermission(target.runId, target.generation, {
        requestId: target.requestId,
        approved,
        ...(target.input !== undefined && { input: target.input }),
        ...(said !== undefined && { text: said }),
      })
      return answered
    })
  }

  async function answerMove(
    task: StoredTask,
    comment: Comment,
    request: AnswerRequest,
    sendDrafts: boolean,
  ): Promise<Comment> {
    const ask = comment.move
    if (
      !ask ||
      request.action !== 'answer' ||
      (request.choice !== moveChoice && request.choice !== keepMoveChoice)
    )
      throw new RequestError(400, `answer with ${moveChoice} or ${keepMoveChoice}`)
    const choice = request.choice
    const text = request.text?.trim() ?? ''
    const record = () =>
      holding(task, async () => {
        unanswered(comment)
        return answerRequest(
          task,
          comment,
          { kind: 'answered', at: new Date().toISOString(), choice, ...(text !== '' && { text }) },
          text !== '' && sendDrafts ? drafts(task.id) : undefined,
        )
      })
    const added = text === '' ? [] : [`They added:\n\n${text}`]
    if (choice === keepMoveChoice) {
      const answered = await record()
      const now = find(task.id)
      const where = store.getFactory(now.factoryId)?.name ?? 'this Factory'
      if (ask.askedBy === 'coordinator') {
        if (ask.chatId !== undefined)
          await tellChat(
            ask.chatId,
            [
              `The user chose ${keepMoveChoice} on your request to move ${now.displayId}, so it stays in ${where}.`,
              ...added,
            ].join('\n\n'),
          )
      } else {
        await deliverAnswer(
          now,
          answered,
          [
            `The user chose ${keepMoveChoice} on your request to move ${now.displayId}, so it stays in ${where}.`,
            ...added,
            `Carry on with ${stageTitle(now.stage)}’s work here. Ask to move it again only if something new comes up.`,
          ].join('\n\n'),
        )
      }
      return store.getComment(comment.id) ?? answered
    }
    const chosen = request.move
    if (!chosen) throw new RequestError(400, 'choose the Factory to move the Task to')
    const planned = await movePlanKey(task.id, chosen.factoryId, comment.id)
    if (planned.refusal !== undefined) throw new RequestError(409, planned.refusal)
    if (planned.key !== chosen.planKey)
      throw new RequestError(
        409,
        `${task.displayId} or a Task under it changed since the move was shown, so nothing was moved. Look at the move again.`,
      )
    const answered = await record()
    let result: string
    try {
      const { moved } = await moveTask(task.id, chosen.factoryId, chosen.planKey)
      const where = store.getFactory(chosen.factoryId)?.name ?? 'the other Factory'
      const to = moved.find((m) => m.id === task.id)?.to ?? task.displayId
      result = `The user approved your request: ${task.displayId} moved to ${where} as ${to}.`
    } catch (error) {
      const why = redactSecrets(error instanceof Error ? error.message : String(error))
      store.postComment({
        taskId: task.id,
        kind: 'note',
        author: { kind: 'ted' },
        body: `Ted couldn’t move ${task.displayId}: ${why} Use Move to Factory… in the Task’s menu to try again.`,
      })
      await store.persisted()
      if (ask.askedBy === 'coordinator' && ask.chatId !== undefined)
        await tellChat(
          ask.chatId,
          `The user approved moving ${task.displayId}, but Ted couldn’t move it: ${why}`,
        )
      throw error
    }
    if (ask.askedBy === 'coordinator' && ask.chatId !== undefined)
      await tellChat(ask.chatId, [result, ...added].join('\n\n'))
    return store.getComment(comment.id) ?? answered
  }

  async function answerAs(
    id: string,
    request: AnswerRequest,
    sendDrafts: boolean,
    mark?: string,
  ): Promise<Comment> {
    const answering = store.getComment(id)
    if (answering && !answering.gate) await untilFree(answering.taskId)
    const comment = store.getComment(id)
    if (!comment) throw new RequestError(404, `no comment ${id}`)
    if (comment.kind === 'note') throw new RequestError(400, 'a note has nothing to answer')
    const task = find(comment.taskId)
    if (automatic) await automatic.guard(comment)
    const failure = failures.findDecision(id)
    if (comment.purpose?.kind === 'failure') {
      if (!failure) throw new RequestError(409, 'this failure decision can’t be answered')
      if (comment.answer)
        throw new RequestError(409, 'this failure decision is stale or already answered')
      if (request.action === 'answer' && request.choice === undefined && request.text?.trim()) {
        await holding(task, () =>
          humanComment(find(task.id), failureText(request.text ?? ''), [], sendDrafts),
        )
        return store.getComment(id) as Comment
      }
      if (request.action !== 'answer' || request.choice === undefined)
        throw new RequestError(400, 'choose a failure resolution')
      const named = failure.decisions.find((d) => d.commentId === id)?.repairTask
      if (named && request.choice === namedRepairChoice(named.displayId)) {
        if (comment.choices && !comment.choices.includes(request.choice))
          throw new RequestError(400, `“${request.choice}” isn’t one of the question’s choices`)
        await port.waitForRepair(task.id, failure.id, {
          requestId: id,
          resolution: 'repair',
          repair: { kind: 'existing', taskId: named.id },
          ...(request.text?.trim() && { reason: request.text.trim() }),
        })
        const answered = store.getComment(id)
        if (!answered) throw new RequestError(404, `no comment ${id}`)
        return answered
      }
      const resolution = failureChoiceKeys.find(
        (key) => failureChoiceLabels[key] === request.choice,
      )
      if (!resolution) throw new RequestError(400, 'choose a failure resolution')
      if (comment.choices && !comment.choices.includes(request.choice))
        throw new RequestError(400, `“${request.choice}” isn’t one of the question’s choices`)
      await untilChecksReported(task.id)
      await untilFree(task.id)
      return holding(task, async () => {
        await failures.resolve(
          find(task.id),
          failure.id,
          {
            requestId: id,
            resolution,
            ...(request.text !== undefined && { reason: request.text }),
          },
          sendDrafts,
        )
        return store.getComment(id) as Comment
      })
    }
    if (comment.purpose?.kind === 'move') {
      if (mark !== undefined || automatic)
        throw new RequestError(403, 'only the user answers a move request')
      return answerMove(task, comment, request, sendDrafts)
    }
    if (comment.purpose?.kind === 'round') return answerRound(task, comment, request, mark)
    if (comment.purpose?.kind === 'proposal') {
      if (request.action !== 'approve' && request.action !== 'request-changes')
        throw new RequestError(400, 'answer a proposal with Create Tasks or Request changes')
      if (request.action === 'request-changes' && !request.text?.trim())
        throw new RequestError(400, 'Request changes needs your comment')
      return answerProposal(task, comment, request)
    }
    if (request.action === 'answer-round' || request.action === 'accept-recommended') {
      throw new RequestError(400, `a ${comment.kind} request isn’t a round`)
    }
    const text = request.text?.trim() ?? ''
    if (comment.purpose?.kind === 'simulator') {
      if (request.action !== 'approve' && request.action !== 'deny')
        throw new RequestError(
          400,
          'answer a simulator request with a simulator to shut down, or Deny',
        )
      return holding(task, () => answerSimulator(comment, request, text))
    }
    if (comment.purpose?.kind === 'permission')
      return answerPermission(task, comment, request, text)
    if (comment.gate) {
      if (request.action === 'request-changes') {
        if (text === '') throw new RequestError(400, 'Request changes needs your comment')
      } else if (request.action !== 'approve') {
        throw new RequestError(400, 'answer a sign-off request with Approve or Request changes')
      }
    } else if (comment.kind !== 'question') {
      throw new RequestError(400, `Ted can’t answer a ${comment.kind} request yet`)
    } else if (request.action !== 'answer') {
      throw new RequestError(400, 'answer a question with a choice or your own words')
    } else if (request.choices !== undefined && !comment.multiple) {
      throw new RequestError(400, 'this question takes one choice')
    } else if (request.choice !== undefined && !comment.choices?.includes(request.choice)) {
      throw new RequestError(400, `“${request.choice}” isn’t one of the question’s choices`)
    } else if (request.choices?.some((c) => !comment.choices?.includes(c))) {
      const outside = request.choices.find((c) => !comment.choices?.includes(c))
      throw new RequestError(400, `“${outside}” isn’t one of the question’s choices`)
    } else if (
      request.choice === undefined &&
      !request.choices?.length &&
      text === '' &&
      !(comment.multiple && request.choices !== undefined)
    ) {
      throw new RequestError(400, 'pick a choice or write an answer')
    }
    if (
      comment.purpose?.kind === 'archive' &&
      (request.action !== 'answer' || request.choice === undefined)
    ) {
      throw new RequestError(400, `answer with ${archiveChoice} or ${keepArchiveChoice}`)
    }
    if (comment.purpose?.kind === 'cleanup-failure' && request.action === 'answer') {
      return answerCleanupFailure(find(task.id), comment, request.choice, text)
    }
    if (comment.purpose?.kind === 'memory-kill' && request.action === 'answer') {
      return answerMemoryKill(find(task.id), comment, request.choice, text)
    }
    if (comment.purpose?.kind === 'check-report' && request.action === 'answer') {
      return answerCheckReport(find(task.id), comment, request.choice, text)
    }
    if (comment.purpose?.kind === 'asana-missing' && request.action === 'answer') {
      return answerAsanaMissing(task, comment, request.choice, text)
    }
    if (comment.purpose?.kind === 'asana-unfinished' && request.action === 'answer') {
      return answerAsanaUnfinished(task, comment, request.choice, text)
    }
    const consent = trackerConsents.find((c) => c.asks(comment))
    if (consent && request.action === 'answer') {
      return consent.answerGroup(task, comment, request.choice, text)
    }
    if (
      comment.purpose?.kind === 'size-check' &&
      comment.answer === undefined &&
      request.action === 'answer' &&
      request.choice !== undefined
    ) {
      return answerSizeCheck(task, comment, request.choice, text)
    }
    if (
      comment.purpose?.kind === 'ci-stuck' &&
      comment.answer === undefined &&
      request.action === 'answer'
    ) {
      if (mark !== undefined && noCiAgainRepo(task.repos, request.choice)) {
        throw new RequestError(403, 'only the human can change a repo’s Pull request CI setting')
      }
      return answerCiStuck(task, comment, request.choice, text)
    }
    if (comment.purpose?.kind === 'failed-run' && comment.answer === undefined) {
      if (request.action === 'answer' && request.choice === mergeAnywayChoice) {
        if (mark !== undefined)
          throw new RequestError(403, 'only the human can choose Merge anyway')
        return mergeAnywayAfterFailure(task, comment, text)
      }
      if (request.action === 'answer' && request.choice === retryChoice) {
        await resumeByHand(task.id, { comment: text, sendDrafts })
      } else {
        await humanComment(find(task.id), text, [], sendDrafts)
      }
      return store.getComment(id) ?? comment
    }
    const hold = comment.gate ? holdingSignoff : holding
    return hold(task, async () => {
      const current = store.getComment(id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn')
      }
      if (current?.answer?.kind === 'superseded') {
        throw new RequestError(409, 'this request was replaced by a newer one')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      const at = new Date().toISOString()
      if (request.action === 'request-changes') {
        const answered = answerRequest(
          task,
          comment,
          { kind: 'changes-requested', at, text },
          sendDrafts ? drafts(task.id) : undefined,
        )
        const picksStage = bindsApproval(comment.stage ?? '')
        const lines = linesText(answered)
        await deliverAnswer(
          task,
          comment,
          [
            `The human asked for changes at the ${gateName(comment)}:`,
            text,
            ...(lines !== undefined ? [lines] : []),
            picksStage
              ? `Decide whether the fix belongs in Work or in Design, write the human’s request into a findings file, and send the Task back with \`ted outcome back --to work --findings <file>\` (or \`--to design\`). The fix passes Validate again and comes back with a new sign-off.`
              : hasClarifyRounds(comment.stage ?? '')
                ? 'The Task stays in Clarify. Ask another round about it with `ted ask --round <file>`. When it’s answered, write the Task brief again with `ted brief write`, then run `ted outcome advance` for a new sign-off.'
                : `The Task stays in ${stageTitle(comment.stage ?? '')}. Make the changes, write the Task brief again with \`ted brief write\`, then run \`ted outcome advance\`.`,
          ].join('\n\n'),
        )
        return answered
      }
      if (request.action === 'approve') {
        const now = find(task.id)
        const removedAgents = removedSetupAgents(comment, request.removeAgents)
        if (now.setup && signsOffCode(now.stage)) await requireSetupAgents(now)
        const reads = worktreeReads()
        const resolution = await gateWorkflow(now, { reads })
        const next = resolution.workflow.next(now.stage) as AgentStageId | 'done'
        if (now.preparation === 'preparing') checkPreparationWorkflow(resolution.workflow)
        const stale = await requireObligations(now, next, reads).then(
          () => false,
          (error: unknown) => {
            if (error instanceof StaleCoverageError) return true
            throw error
          },
        )
        if (automatic) await automatic.guard(comment)
        const removedLine =
          removedAgents.length === 0
            ? ''
            : ` They removed ${removedAgents.length === 1 ? 'this Agent' : 'these Agents'} from the setup proposal, so don’t write ${removedAgents.length === 1 ? 'it' : 'them'}: ${removedAgents.join(', ')}.`
        const approved =
          text === ''
            ? `${automatic ? 'Autopilot' : 'The human'} approved the ${gateName(comment)}.${removedLine}`
            : removedLine === ''
              ? `${automatic ? 'Autopilot' : 'The human'} approved the ${gateName(comment)} and added:\n\n${text}\n\n`
              : `${automatic ? 'Autopilot' : 'The human'} approved the ${gateName(comment)}.${removedLine} They added:\n\n${text}\n\n`
        const carryOut = async (
          from: StoredTask,
          using: WorkflowResolution,
          reads?: WorktreeReads,
        ) => {
          const to = using.workflow.next(from.stage) as AgentStageId | 'done'
          if (mergesHere(from.stage)) {
            startMerging(find(task.id), using.workflow)
            watchMerge(task.id)
            await deliver(
              from,
              `${approved}${text === '' ? ' ' : ''}Ted merges the pull requests now and moves the Task to Done when they’ve merged. There’s nothing for you to report.`,
            )
            return
          }
          const signedOff = entersMerge(from.stage, to, using.workflow.stages)
          await move(
            from,
            using,
            to,
            to === 'done'
              ? undefined
              : `${approved}${text === '' ? ' ' : ''}${nextStageMessage(using.workflow, to)}`,
            { signedOff, ...(reads !== undefined && { reads }) },
          )
        }
        if (stale) {
          const stage = now.stage
          await checksThen(task.id, () =>
            hold(task, async () => {
              const later = find(task.id)
              if (later.stage !== stage) return
              const using = await gateWorkflow(later)
              await requireObligations(later, using.workflow.next(stage) as AgentStageId | 'done')
              await carryOut(later, using)
            }),
          )
        }
        const answered = answerRequest(task, comment, {
          kind: 'approved',
          at,
          ...(text !== '' && { text }),
          ...(removedAgents.length > 0 && { removedAgents }),
        })
        await bindApproval(now, comment, resolution.workflow)
        if (!liveLead(now)) store.holdAnswer(comment.id)
        if (!stale) await carryOut(now, resolution, reads)
        return answered
      }
      if (automatic) await automatic.guard(comment)
      const choice = request.choice
      const picks = comment.multiple
        ? (comment.choices ?? []).filter(
            (c) => c === choice || (request.action === 'answer' && request.choices?.includes(c)),
          )
        : undefined
      if (comment.purpose?.kind === 'send-back') {
        const answered = await answerLoopAsk(find(task.id), comment, choice, text, at)
        if (answered) return answered
      }
      if (comment.purpose?.kind === 'archive' && choice === archiveChoice) {
        const now = find(task.id)
        if (now.archived) throw new RequestError(409, `${now.displayId} is already archived`)
        const archive = archiveAsked(
          now,
          request.action === 'answer' ? (request.archive ?? {}) : {},
        )
        const answered = answerRequest(
          task,
          comment,
          { kind: 'answered', at, choice, ...(text !== '' && { text }) },
          text !== '' && sendDrafts ? drafts(task.id) : undefined,
        )
        archive()
        wake()
        return store.getComment(comment.id) ?? answered
      }
      if (isTrackerClosedQuestion(comment) && choice !== undefined) {
        if (choice === trackerArchiveChoice && !find(task.id).archived)
          port.beforeArchive?.(find(task.id))
        const answered = answerRequest(task, comment, {
          kind: 'answered',
          at,
          choice,
          ...(text !== '' && { text }),
        })
        if (choice === trackerArchiveChoice && !find(task.id).archived) {
          settleDependents(task.id)
          archiveNow(find(task.id), false)
          wake()
        }
        return answered
      }
      if (comment.purpose?.kind === 'idle-run' && choice === nudgeAgainChoice) {
        const answered = answerRequest(task, comment, {
          kind: 'answered',
          at,
          choice,
          ...(text !== '' && { text }),
        })
        const run = liveLead(find(task.id))
        if (run) await sendNudge(task, run)
        return answered
      }
      if (comment.purpose?.kind === 'idle-run' && choice === restartFromBriefChoice) {
        const answered: Comment[] = []
        await restartFromBrief(find(task.id), comment, () => {
          answered.push(
            answerRequest(task, comment, {
              kind: 'answered',
              at,
              choice,
              ...(text !== '' && { text }),
            }),
          )
        })
        return answered[0] ?? store.getComment(comment.id) ?? comment
      }
      const aboutModel = comment.purpose?.kind === 'model'
      if (comment.purpose?.kind === 'model' && choice === useDefaultChoice) {
        const run = liveLead(find(task.id))
        if (
          run?.id !== comment.purpose.runId ||
          run.problem !== 'model-unavailable' ||
          comment.createdAt < (store.runProblemAt(run.id) ?? '')
        ) {
          throw new RequestError(
            409,
            'this model request no longer belongs to the waiting Task Lead',
          )
        }
        await useDefaultModel(task.id)
      }
      const answered = answerRequest(
        task,
        comment,
        {
          kind: 'answered',
          at,
          ...(picks
            ? (picks.length > 0 ||
                (request.action === 'answer' && request.choices !== undefined)) && {
                choices: picks,
              }
            : choice !== undefined && { choice }),
          ...(text !== '' && { text }),
        },
        text !== '' && !aboutModel && sendDrafts ? drafts(task.id) : undefined,
        !aboutModel,
      )
      if (aboutModel) return answered
      const lines = linesText(answered)
      await deliverAnswer(
        task,
        comment,
        comment.purpose?.kind === 'archive'
          ? archiveKeptMessage(find(task.id), answered)
          : answerMessage(answered, lines),
      )
      return store.getComment(comment.id) ?? answered
    })
  }

  return answerAs
}

function archiveKeptMessage(task: Task, comment: Comment): string {
  const who = comment.autopilotAnswered ? 'Autopilot' : 'The user'
  const text = comment.answer?.kind === 'answered' ? comment.answer.text : undefined
  return [
    `${who} chose ${keepArchiveChoice} on your request to archive ${task.displayId}, so Ted won’t archive it.`,
    ...(text !== undefined ? [`They added:\n\n${text}`] : []),
    `The Task stays in ${stageTitle(task.stage)}. Carry on with this Stage’s work. Ask to archive it again only if something new comes up.`,
  ].join('\n\n')
}

function permissionMessage(approved: boolean, command: string, text: string): string | undefined {
  if (approved) {
    return text === ''
      ? undefined
      : `The human approved your permission request for \`${oneLine(command)}\` and added:\n\n${text}`
  }
  return text === ''
    ? 'The human denied this request. Don’t retry it; find another way or ask with `ted ask`.'
    : `The human denied this request and said:\n\n${text}`
}

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const keepGoingChoice = 'Keep going'
export const stopTaskChoice = 'Stop the Task'
export const tryAgainChoice = 'Try again'
export const backToDesignChoice = 'Back to Design'
export const diagnoseChoice = 'Diagnose in Validate'

function legacyLoopChoices(workflow: ResolvedWorkflow): string[] {
  const next = workflow.next(stageWith('validates'))
  const design =
    workflow.stages.includes(stageWith('designReview')) &&
    workflow.order.indexOf(stageWith('designReview')) <
      workflow.order.indexOf(stageWith('validates'))
  return [
    tryAgainChoice,
    ...(design ? [backToDesignChoice] : []),
    `Move to ${stageTitle(next)} anyway`,
  ]
}

export function checkBack(workflow: ResolvedWorkflow, from: AgentStageId, to: AgentStageId): void {
  if (!workflow.stages.includes(to)) {
    throw new RequestError(409, `${workflow.name(to)} isn’t on in this Factory’s Workflow`)
  }
  if (!isEarlierStage(workflow, to, from)) {
    throw new RequestError(
      409,
      `\`back\` goes only to an earlier Stage; ${workflow.name(to)} isn’t before ${workflow.name(from)}`,
    )
  }
}

export function answerTaskRequest(
  store: TedStore,
  task: Task,
  comment: Comment,
  answer: CommentAnswer,
  lineComments?: readonly string[],
  autopilot = false,
  queueAnswer = false,
): Comment {
  const answered = store.answerComment(comment.id, answer, lineComments, autopilot, queueAnswer)
  if (comment.stage !== undefined) store.resetSendBacks(task.id, comment.stage)
  return answered
}

function removedSetupAgents(
  comment: Comment,
  removeAgents: readonly string[] | undefined,
): string[] {
  if (removeAgents === undefined || removeAgents.length === 0) return []
  const suggested = comment.design?.setup?.agents?.map((agent) => agent.id) ?? []
  const unknown = removeAgents.filter((id) => !suggested.includes(id))
  if (unknown.length > 0) {
    throw new RequestError(
      400,
      `the setup proposal doesn’t suggest ${unknown.join(', ')}, so it can’t be removed`,
    )
  }
  return [...removeAgents]
}
