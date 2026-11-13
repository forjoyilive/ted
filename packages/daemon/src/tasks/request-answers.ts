import type {
  AgentStageId,
  AnswerRequest,
  Attachment,
  Comment,
  CommentAnswer,
  Run,
  SendBack,
  Task,
} from '@ted/protocol'
import { failureChoices, sizeChoices, validateFailureChoices } from '@ted/protocol'
import type { Simulators } from '../apps/simulators.ts'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'
import { backStageMessage, nextStageMessage, stageTitle } from '../workflow/workflow.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import { answerMessage } from './answer-message.ts'
import { type createFailureCases, failureText } from './failure-cases.ts'
import { mergeAnywayChoice, sendToLeadChoice } from './merge-watcher.ts'
import { checkPreparationWorkflow } from './preparation.ts'
import { approvedShape, createProposalTasks } from './proposal-tasks.ts'
import { createLinearConsent } from './request-linear-team.ts'
import { roundAnswerMessage, roundAnswers } from './rounds.ts'
import {
  grillAnywayMessage,
  planInChatMessage,
  proposalChangesMessage,
  splitApprovedMessage,
  splitChosenMessage,
} from './split.ts'

export interface RequestAnswerPort {
  store: TedStore
  untilFree(id: string): Promise<void>
  find(id: string): StoredTask
  holding<T>(task: Task, work: () => Promise<T>): Promise<T>
  holdingSignoff<T>(task: Task, work: () => Promise<T>): Promise<T>
  failures: Pick<ReturnType<typeof createFailureCases>, 'findDecision' | 'resolve'>
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
  gateWorkflow(task: StoredTask): Promise<WorkflowResolution>
  requireObligations(task: StoredTask, target?: AgentStageId | 'done'): Promise<void>
  bindApproval(task: StoredTask, comment: Comment, workflow: ResolvedWorkflow): Promise<void>
  liveLead(task: Task): Run | undefined
  startMerging(task: StoredTask, workflow: ResolvedWorkflow): void
  watchMerge(id: string): void
  deliver(task: Task, text: string): Promise<boolean>
  pullRequestWork(id: string, reason: 'signoff' | 'again'): void
  move(
    task: StoredTask,
    resolution: WorkflowResolution,
    next: AgentStageId | 'done',
    message: string | undefined,
    options?: { signedOff: boolean },
  ): Promise<Task>
  backMessage(
    workflow: ResolvedWorkflow,
    to: AgentStageId,
    from: AgentStageId,
    sendBack: SendBack,
  ): string
  leaveWorkToDiagnose(task: StoredTask): Promise<(message: string) => Promise<Task>>
  settleDependents(id: string, choice: 'unblock'): void
  beforeArchive?(task: StoredTask): void
  archiveNow(task: StoredTask, close: boolean): Task
  wake(): void
  sendNudge(task: StoredTask, run: Run): Promise<void>
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
}

export function createRequestAnswers(
  port: RequestAnswerPort,
  automatic?: { guard(comment: Comment): Promise<void> },
) {
  const {
    store,
    untilFree,
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
    planning,
    resumeByHand,
    drafts,
    deliverAnswer,
    gateWorkflow,
    requireObligations,
    bindApproval,
    liveLead,
    startMerging,
    watchMerge,
    deliver,
    pullRequestWork,
    move,
    backMessage,
    leaveWorkToDiagnose,
    settleDependents,
    archiveNow,
    wake,
    sendNudge,
    useDefaultModel,
    linesText,
    gateName,
    firstLine,
    answerAsanaMissing,
  } = port
  const { answerLinearTeam } = createLinearConsent(store)
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
  const linearArchiveChoice = 'Archive'
  const nudgeAgainChoice = 'Nudge again'
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
    const answered = await holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn: CI reported before you answered')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      if (choice === mergeAnywayChoice) await requireObligations(find(task.id))
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
          `TED asked the human about CI at Merge: ${comment.title ?? ''}.`,
          comment.body.split('\n\n')[0] ?? '',
          'The human sent it to you. Find out why CI hasn’t reported (a workflow that doesn’t run on this branch, a missing runner, a check that hangs), fix what belongs in this Task, and say what you found in the brief. The Task comes back through Validate for a short re-sign-off.',
          ...(text !== '' ? [`The human added: ${text}`] : []),
        ].join('\n\n'),
      )
    } else if (choice === undefined && text !== '') {
      await deliverAnswer(task, answered, `The human answered “${comment.title ?? ''}”:\n\n${text}`)
    }
    return store.getComment(comment.id) ?? answered
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
    const { skip, shape: plan } = approvedShape(
      proposal,
      request.proposal?.skip,
      proposal.firstPiece && { name: 'this Task' },
    )
    const startUnblocked = request.proposal?.startUnblocked === true
    const first = proposal.rows[0]
    const result = await holding(task, async () => {
      unanswered(comment)
      const current = find(task.id)
      if (current.archived) throw new RequestError(409, `${task.displayId} is archived`)
      const created = await createProposalTasks(store, proposal, plan, {
        firstPieceId: proposal.firstPiece ? task.id : undefined,
        factoryId: current.factoryId,
        fields: () => ({ ...(current.lead && { lead: current.lead }), splitFrom: task.id }),
      })
      const narrowed =
        proposal.firstPiece && first
          ? { title: first.title, description: first.description ?? first.scope }
          : undefined
      if (narrowed) {
        store.taskSplit(task.id, {
          pieceIds: created.map((c) => c.id),
          narrowedTo: narrowed.title,
          description: narrowed.description,
        })
        if (first && first.priority !== current.priority) {
          store.setPriority(task.id, first.priority)
        }
      }
      const outcome = { tasks: created, skipped: skip, startUnblocked }
      const answered = answerRequest(task, comment, {
        kind: 'approved',
        at: new Date().toISOString(),
        ...(text !== '' && { text }),
        created: outcome,
      })
      await deliverAnswer(
        task,
        comment,
        splitApprovedMessage({
          displayId: task.displayId,
          proposal,
          created: outcome,
          ...(narrowed && { narrowed }),
          text,
        }),
      )
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
      if (find(task.id).stage !== 'clarify') {
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
    if (ask.from === 'work' && ask.to === 'work' && choice === diagnoseChoice) {
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
          `The human answered “${comment.title ?? firstLine(comment.body)}” with ${diagnoseChoice}, so TED moved this Task to Validate although the Checks didn’t pass in Work. TED runs the Checks at entry. A Check that fails there is a failure case: assess it as Validate’s instructions say, and the human can then choose Retry, Fix in this Task or Accept this failure.`,
          ...(text !== '' ? [`The human added:\n\n${text}`] : []),
        ].join('\n\n'),
      )
      return answered
    }
    if (!ask.loop || choice === undefined) return undefined
    const current = find(task.id)
    if (current.stage !== 'validate') return undefined
    const resolution = await gateWorkflow(current)
    const { workflow } = resolution
    const next = workflow.next('validate') as AgentStageId | 'done'
    const choices = loopChoices(workflow)
    if (!choices.includes(choice)) return undefined
    if (choice === tryAgainChoice) checkBack(workflow, 'validate', ask.to)
    if (choice === backToDesignChoice) checkBack(workflow, 'validate', 'design')
    if (choice !== tryAgainChoice && choice !== backToDesignChoice)
      await requireObligations(current)
    const added = text === '' ? '' : `\n\nThe human added:\n\n${text}`
    const answered = answerRequest(task, comment, {
      kind: 'answered',
      at,
      choice,
      ...(text !== '' && { text }),
    })
    if (choice === tryAgainChoice) {
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
        cause: ask.checkRunId !== undefined ? 'check' : 'review',
      })
      await move(
        current,
        resolution,
        ask.to,
        `The human chose Try again, so Validate’s count of send-backs starts over.${added}\n\n${backMessage(workflow, ask.to, 'validate', sentBack)}`,
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
        'design',
        `The human sent this Task back to Design from Validate.${added}\n\n${backStageMessage(workflow, 'design', 'validate', ask.findings)}`,
      )
    } else {
      pullRequestWork(task.id, 'again')
      const open = `# Open Findings\n\nThe human chose “${choice}” with Validate’s blocking Findings still open. Put them in the Task brief under “Current state” so the human sees them at ${stageTitle(next)}:\n\n${ask.findings}`
      await move(
        current,
        resolution,
        next,
        next === 'done'
          ? undefined
          : `The human moved this Task on from Validate.${added}\n\n${nextStageMessage(workflow, next)}\n\n${open}`,
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
          'The disk is almost full, so TED holds new Apps until there’s space',
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

  async function answerAs(
    id: string,
    request: AnswerRequest,
    sendDrafts: boolean,
    mark?: string,
  ): Promise<Comment> {
    const answering = store.getComment(id)
    if (answering && !answering.gate) await untilFree(answering.taskId)
    const comment = store.getComment(id)
    if (!comment) throw new RequestError(404, `no Comment ${id}`)
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
      const choices = { ...failureChoices, ...validateFailureChoices }
      const resolution = (Object.keys(choices) as (keyof typeof choices)[]).find(
        (key) => choices[key] === request.choice,
      )
      if (!resolution) throw new RequestError(400, 'choose a failure resolution')
      if (comment.choices && !comment.choices.includes(request.choice))
        throw new RequestError(400, `“${request.choice}” isn’t one of the question’s choices`)
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
      throw new RequestError(400, `TED can’t answer a ${comment.kind} request yet`)
    } else if (request.action !== 'answer') {
      throw new RequestError(400, 'answer a question with a choice or your own words')
    } else if (request.choice !== undefined && !comment.choices?.includes(request.choice)) {
      throw new RequestError(400, `“${request.choice}” isn’t one of the question’s choices`)
    } else if (request.choice === undefined && text === '') {
      throw new RequestError(400, 'pick a choice or write an answer')
    }
    if (comment.purpose?.kind === 'asana-missing' && request.action === 'answer') {
      return answerAsanaMissing(task, comment, request.choice, text)
    }
    if (comment.purpose?.kind === 'linear-team' && request.action === 'answer') {
      return answerLinearTeam(task, comment, request.choice, text)
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
      return answerCiStuck(task, comment, request.choice, text)
    }
    if (comment.purpose?.kind === 'failed-run' && comment.answer === undefined) {
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
        const picksStage = comment.stage === 'review' || comment.stage === 'merge'
        const lines = linesText(answered)
        await deliverAnswer(
          task,
          comment,
          [
            `The human asked for changes at the ${gateName(comment)}:`,
            text,
            ...(lines !== undefined ? [lines] : []),
            picksStage
              ? `Decide whether the fix belongs in Work or in Design, write the human’s request into a Findings file, and send the Task back with \`ted outcome back --to work --findings <file>\` (or \`--to design\`). The fix passes Validate again and comes back with a new sign-off.`
              : comment.stage === 'clarify'
                ? 'The Task stays in Clarify. Ask another round about it with `ted ask --round <file>`. When it’s answered, write the Task brief again with `ted brief write`, then run `ted outcome advance` for a new sign-off.'
                : `The Task stays in ${stageTitle(comment.stage ?? '')}. Make the changes, write the Task brief again with \`ted brief write\`, then run \`ted outcome advance\`.`,
          ].join('\n\n'),
        )
        return answered
      }
      if (request.action === 'approve') {
        const now = find(task.id)
        const resolution = await gateWorkflow(now)
        const next = resolution.workflow.next(now.stage) as AgentStageId | 'done'
        if (now.preparation === 'preparing') checkPreparationWorkflow(resolution.workflow)
        await requireObligations(now, next)
        if (automatic) await automatic.guard(comment)
        const answered = answerRequest(task, comment, {
          kind: 'approved',
          at,
          ...(text !== '' && { text }),
        })
        await bindApproval(now, comment, resolution.workflow)
        if (!liveLead(now)) store.holdAnswer(comment.id)
        const approved =
          text === ''
            ? `${automatic ? 'Autopilot' : 'The human'} approved the ${gateName(comment)}.`
            : `${automatic ? 'Autopilot' : 'The human'} approved the ${gateName(comment)} and added:\n\n${text}\n\n`
        if (now.stage === 'merge') {
          startMerging(find(task.id), resolution.workflow)
          watchMerge(task.id)
          await deliver(
            now,
            `${approved}${text === '' ? ' ' : ''}TED merges the pull requests now and moves the Task to Done when they’ve merged. There’s nothing for you to report.`,
          )
          return answered
        }
        const signedOff = next === 'merge'
        if (signedOff) pullRequestWork(task.id, 'signoff')
        await move(
          now,
          resolution,
          next,
          next === 'done'
            ? undefined
            : `${approved}${text === '' ? ' ' : ''}${nextStageMessage(resolution.workflow, next)}`,
          { signedOff },
        )
        return answered
      }
      if (automatic) await automatic.guard(comment)
      const choice = request.choice
      if (comment.purpose?.kind === 'send-back') {
        const answered = await answerLoopAsk(find(task.id), comment, choice, text, at)
        if (answered) return answered
      }
      if (comment.purpose?.kind === 'linear-closed' && choice !== undefined) {
        if (choice === linearArchiveChoice && !find(task.id).archived)
          port.beforeArchive?.(find(task.id))
        const answered = answerRequest(task, comment, {
          kind: 'answered',
          at,
          choice,
          ...(text !== '' && { text }),
        })
        if (choice === linearArchiveChoice && !find(task.id).archived) {
          settleDependents(task.id, 'unblock')
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
          ...(choice !== undefined && { choice }),
          ...(text !== '' && { text }),
        },
        text !== '' && !aboutModel && sendDrafts ? drafts(task.id) : undefined,
        !aboutModel,
      )
      if (aboutModel) return answered
      const lines = linesText(answered)
      await deliverAnswer(task, comment, answerMessage(answered, lines))
      return store.getComment(comment.id) ?? answered
    })
  }

  return answerAs
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

export const tryAgainChoice = 'Try again'
export const backToDesignChoice = 'Back to Design'
export const diagnoseChoice = 'Diagnose in Validate'

export function loopChoices(workflow: ResolvedWorkflow): string[] {
  const next = workflow.next('validate')
  const design =
    workflow.stages.includes('design') &&
    workflow.order.indexOf('design') < workflow.order.indexOf('validate')
  return [
    tryAgainChoice,
    ...(design ? [backToDesignChoice] : []),
    `Move to ${stageTitle(next)} anyway`,
  ]
}

export function checkBack(workflow: ResolvedWorkflow, from: AgentStageId, to: AgentStageId): void {
  if (!workflow.stages.includes(to)) {
    throw new RequestError(409, `${stageTitle(to)} isn’t on in this Factory’s Workflow`)
  }
  if (workflow.order.indexOf(to) >= workflow.order.indexOf(from)) {
    throw new RequestError(
      409,
      `\`back\` goes only to an earlier Stage; ${stageTitle(to)} isn’t before ${stageTitle(from)}`,
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
