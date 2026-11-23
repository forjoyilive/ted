import type { AgentStageId, Comment, DeclaredSendBackCause, SendBack, Task } from '@ted/protocol'
import { handsOff, stageWith, validates } from '@ted/protocol/stage'
import * as git from '../git.ts'
import { redactSecrets } from '../redact.ts'
import type { FoundConflict, LoopCheck, LoopVerdict, StoredTask, TedStore } from '../store/index.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'
import { loopCheckInstructions } from '../workflow/workflow.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import type { ReviewerChoice, SubAgents } from './sub-agents.ts'

export const keepGoingChoice = 'Keep going'
export const stopTaskChoice = 'Stop the Task'
export const diagnoseChoice = 'Diagnose in Validate'

export const reviewReturn = (sendBack: SendBack) =>
  sendBack.checkRunId === undefined && sendBack.cause !== 'base-conflict'

const timesText = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`

interface HeldReturn {
  to: AgentStageId
  findings: string
  checkRunId?: string
  cause?: DeclaredSendBackCause
}

type HoldDecision =
  | { kind: 'proceed' }
  | { kind: 'checking'; message: string }
  | { kind: 'asked'; message: string; request: Comment }

interface SendBackHoldOptions {
  store: TedStore
  subAgents: Pick<SubAgents, 'requestForTed' | 'result'>
  reviewerFor(task: StoredTask): Promise<ReviewerChoice>
  find(taskId: string): StoredTask
  taskWorkflow(task: StoredTask): Promise<WorkflowResolution>
  stopRun(runId: string): Promise<void>
  closed(): boolean
  inBackground(what: string, work: () => Promise<void>): void
  move(
    task: StoredTask,
    resolution: WorkflowResolution,
    to: AgentStageId,
    message: string,
  ): Promise<Task>
  backMessage(
    workflow: ResolvedWorkflow,
    to: AgentStageId,
    from: AgentStageId,
    sendBack: SendBack,
  ): string
  deliver(task: StoredTask, message: string): Promise<boolean>
}

export function createSendBackHold(options: SendBackHoldOptions) {
  const {
    store,
    subAgents,
    reviewerFor,
    find,
    taskWorkflow,
    stopRun,
    closed,
    inBackground,
    move,
    backMessage,
    deliver,
  } = options

  async function decide(
    task: StoredTask,
    workflow: ResolvedWorkflow,
    input: HeldReturn & {
      counted: boolean
      count: number
      limit?: number
      conflict?: FoundConflict
    },
  ): Promise<HoldDecision> {
    if (!input.counted) return { kind: 'proceed' }
    const { to, findings, count, limit, checkRunId, cause, conflict } = input
    const held = {
      ...(checkRunId !== undefined && { checkRunId }),
      ...(cause !== undefined && { cause }),
    }
    const loopAt = workflow.settings.stages.validate?.loop_check
    const keepConflict = () => {
      if (conflict !== undefined) store.recordBaseConflict(task.id, conflict)
    }
    if (limit !== undefined && count >= limit) {
      keepConflict()
      const times = timesText(count)
      if (
        loopAt !== false &&
        (await startLoopCheck(task, {
          to,
          findings,
          round: count + 1,
          limit,
          ...held,
        }))
      ) {
        return {
          kind: 'checking',
          message: 'Ted is checking progress before asking the human. The Task stays in Validate.',
        }
      }
      const request = askAboutLoop(task, workflow, {
        to,
        findings,
        title: `Validate sent this Task back to Work ${timesText(count)}, its limit`,
        intro:
          loopAt === false
            ? ''
            : 'A Loop check couldn’t start, so Ted couldn’t check whether the rounds are making progress.',
        ...held,
      })
      return {
        kind: 'asked',
        message: `Validate has sent this Task back ${times}, its limit, so Ted asked the human instead. Ted sends you their answer.`,
        request,
      }
    }
    if (loopAt !== undefined && loopAt !== false && count + 1 === loopAt) {
      const started = await startLoopCheck(task, {
        to,
        findings,
        round: count + 1,
        ...(limit !== undefined && { limit }),
        ...held,
      })
      if (started) {
        keepConflict()
        return {
          kind: 'checking',
          message: `This is Validate’s send-back number ${count + 1}, so Ted started a loop check to see whether the rounds are converging. The Task stays in Validate until it answers; Ted sends you the result.`,
        }
      }
    }
    return { kind: 'proceed' }
  }

  function countedValidateSendBacks(taskId: string) {
    const count = store.sendBackCount(taskId, stageWith('validates'))
    if (count === 0) return []
    return store
      .listSendBacks(taskId)
      .filter((b) => validates(b.from) && b.counted)
      .slice(-count)
  }

  function roundsText(rounds: readonly string[]): string {
    return rounds.map((findings, i) => `## Round ${i + 1}\n\n${findings.trim()}`).join('\n\n')
  }

  function returnsText(taskId: string, limit: number | undefined): string {
    const returns = countedValidateSendBacks(taskId)
    const count = (cause: (b: SendBack) => boolean) => returns.filter(cause).length
    const parts = [
      [count(reviewReturn), 'review findings', 'review findings'],
      [count((b) => b.checkRunId !== undefined), 'a failed check', 'failed checks'],
      [
        count((b) => b.cause === 'base-conflict'),
        'a conflict with the base branch',
        'conflicts with the base branch',
      ],
    ] as const
    const listed = parts.flatMap(([n, one, many]) =>
      n === 0 ? [] : [`${n} for ${n === 1 ? one : many}`],
    )
    const why =
      listed.length < 2
        ? listed.join('')
        : `${listed.slice(0, -1).join(', ')} and ${listed.at(-1) ?? ''}`
    return `Validate has sent the Task back to Work ${timesText(returns.length)}${why === '' ? '' : `: ${why}`}.${limit === undefined ? '' : ` Its limit is ${limit}.`}`
  }

  function askAboutLoop(
    task: StoredTask,
    workflow: ResolvedWorkflow,
    input: {
      to: AgentStageId
      findings: string
      title: string
      intro: string
      checkRunId?: string
      cause?: DeclaredSendBackCause
    },
  ): Comment {
    const limit = workflow.settings.stages.validate?.max_back
    const held =
      input.cause === 'base-conflict'
        ? 'the branch conflicted with its base branch'
        : input.checkRunId === undefined
          ? 'Validate found more problems to fix'
          : 'a check failed'
    const request = store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: input.title,
      purpose: { kind: 'send-back' },
      body: [
        ...(input.intro === '' ? [] : [input.intro]),
        `${returnsText(task.id, limit)} This time ${held}, and the Task is waiting in Validate for your decision. The findings are in the Task’s history.`,
        `**${keepGoingChoice}** sends the Task back to Work with these findings and starts the count again.`,
        `**${stopTaskChoice}** sends the Task back to Work with these findings and stops it, as the Stop button does. When you resume it, the Task Lead starts on the findings and the count starts again.`,
        'To give the Task Lead guidance instead, reply in your own words. The Task stays in Validate.',
      ].join('\n\n'),
      choices: [keepGoingChoice, stopTaskChoice],
    })
    store.askAboutSendBack({
      commentId: request.id,
      taskId: task.id,
      from: 'validate',
      to: input.to,
      findings: input.findings,
      loop: true,
      ...(input.checkRunId !== undefined && { checkRunId: input.checkRunId }),
      ...(input.cause !== undefined && { cause: input.cause }),
    })
    return request
  }

  async function roundCommits(task: StoredTask): Promise<string[]> {
    const worktree = task.repos.find((r) => !r.removed)?.worktree
    if (worktree === undefined) return []
    const commits = await Promise.all(
      countedValidateSendBacks(task.id).map((b) =>
        git.commitAt(worktree, b.at).catch(() => undefined),
      ),
    )
    const head = await git.revParse(worktree, 'HEAD').catch(() => undefined)
    return [...commits, head].map((c, i) => `- Round ${i + 1}: ${c ?? 'unknown'}`)
  }

  async function startLoopCheck(
    task: StoredTask,
    input: {
      to: AgentStageId
      findings: string
      round: number
      limit?: number
      checkRunId?: string
      cause?: DeclaredSendBackCause
    },
  ): Promise<boolean> {
    const rounds = [...countedValidateSendBacks(task.id).map((b) => b.findings), input.findings]
    const prompt = [
      await loopCheckInstructions(),
      roundsText(rounds),
      `# Commits\n\n${(await roundCommits(task)).join('\n')}`,
      `# The Task: ${task.displayId}\n\n${task.title}`,
    ].join('\n\n')
    const runId = subAgents.requestForTed(task, {
      name: 'Loop check · Validate',
      prompt,
      choice: await reviewerFor(task),
      purpose: 'loop-check',
    })
    if (runId === undefined) return false
    const check = store.startLoopCheck({
      runId,
      taskId: task.id,
      to: input.to,
      findings: input.findings,
      round: input.round,
      ...(input.limit !== undefined && { limit: input.limit }),
      ...(input.checkRunId !== undefined && { checkRunId: input.checkRunId }),
      ...(input.cause !== undefined && { cause: input.cause }),
    })
    inBackground(`run ${task.displayId}’s loop check`, () => awaitLoopCheck(check))
    return true
  }

  function pendingLoopCheck(taskId: string): LoopCheck | undefined {
    return store.loopChecks(taskId).find((c) => c.verdict === undefined)
  }

  async function awaitLoopCheck(check: LoopCheck): Promise<void> {
    const result = await subAgents.result(check.runId)
    if (closed()) return
    const said = result.message?.trim() ?? ''
    const finished = result.error === undefined && result.state !== 'stopped'
    const verdict: LoopVerdict = finished ? (verdictIn(said) ?? 'failed') : 'failed'
    const reason =
      verdict !== 'failed'
        ? reasonIn(said)
        : finished
          ? 'the loop check gave no verdict'
          : 'the loop check didn’t finish'
    const run = store.getRun(check.runId)
    if (run && run.state !== 'finished') await stopRun(run.id).catch(() => undefined)
    const resolution = await taskWorkflow(find(check.taskId))
    const { workflow } = resolution
    store.finishLoopCheck(check.runId, verdict, reason)
    const task = find(check.taskId)
    if (!validates(task.stage) || task.archived) return
    const atLimit = check.limit !== undefined && check.round > check.limit
    if (verdict === 'converging' && !atLimit) {
      const sentBack = store.recordSendBack({
        taskId: task.id,
        from: 'validate',
        to: check.to,
        findings: check.findings,
        counted: true,
        round: check.round,
        ...(check.limit !== undefined && { limit: check.limit }),
        ...(check.checkRunId !== undefined && { checkRunId: check.checkRunId }),
        cause: check.cause ?? (check.checkRunId !== undefined ? 'check' : 'review'),
      })
      await move(
        task,
        resolution,
        check.to,
        [
          backMessage(workflow, check.to, stageWith('validates'), sentBack),
          `# Loop check\n\nTed checked Validate’s ${check.round} rounds of findings and the changes between them. Verdict: converging. ${reason}`,
        ].join('\n\n'),
      )
      return
    }
    const looping = verdict === 'looping'
    const returns = timesText(check.round - 1)
    const request = askAboutLoop(task, workflow, {
      to: check.to,
      findings: check.findings,
      title: atLimit
        ? `Validate sent this Task back to Work ${returns}, its limit`
        : looping
          ? `Validate sent this Task back to Work ${returns} without getting closer to done`
          : `Back to Work ${returns}, and Ted couldn’t check progress`,
      intro: looping
        ? `Ted’s Loop check found that the rounds aren’t getting closer to done. ${reason} If you keep going, add guidance that breaks the pattern.`
        : verdict === 'converging'
          ? `Ted’s Loop check found that the rounds are making progress. ${reason}`
          : `Ted couldn’t check whether the rounds are making progress: ${reason}.`,
      ...(check.checkRunId !== undefined && { checkRunId: check.checkRunId }),
      ...(check.cause !== undefined && { cause: check.cause }),
    })
    if (check.checkRunId !== undefined) return
    await deliver(
      task,
      `Ted’s loop check ${looping ? 'found Validate’s rounds are looping' : verdict === 'converging' ? 'found progress, but the send-back limit still needs a human decision' : 'gave no verdict'}, so Ted asked the human what to do (request ${request.id}). The Task stays in Validate; Ted sends you their answer.`,
    )
  }

  function openSendBackAsk(task: Task): Comment | undefined {
    const asks = new Set(store.sendBackAsks(task.id).map((a) => a.commentId))
    return store
      .listComments(task.id)
      .find((c) => asks.has(c.id) && c.answer === undefined && c.stage === task.stage)
  }

  function handOffAsks(taskId: string): Comment[] {
    const asks = new Set(
      store
        .sendBackAsks(taskId)
        .filter((a) => handsOff(a.from) && handsOff(a.to))
        .map((a) => a.commentId),
    )
    return store.listComments(taskId).filter((c) => asks.has(c.id))
  }

  function seen(
    taskId: string,
    matches: (record: { findings: string; checkRunId?: string }) => boolean,
  ): boolean {
    return store.sendBackAsks(taskId).some(matches) || store.loopChecks(taskId).some(matches)
  }

  function heldFor(taskId: string, checkRunId: string): boolean {
    return seen(taskId, (record) => record.checkRunId === checkRunId)
  }

  function heldForFindings(taskId: string, matches: (findings: string) => boolean): boolean {
    return seen(taskId, (record) => matches(record.findings))
  }

  function checking(taskId: string): boolean {
    return pendingLoopCheck(taskId) !== undefined
  }

  function pending(taskId: string): boolean {
    return (
      checking(taskId) ||
      store.sendBackAsks(taskId).some((ask) => !store.getComment(ask.commentId)?.answer)
    )
  }

  function refuseOutcome(task: Task): string | undefined {
    if (checking(task.id)) {
      return 'Ted is checking whether Validate’s rounds are converging; wait for its verdict before reporting an outcome'
    }
    const asked = openSendBackAsk(task)
    if (asked === undefined) return undefined
    return handOffAsks(task.id).some((c) => c.id === asked.id)
      ? `Ted asked the human about ${task.displayId}’s failing checks (request ${asked.id}); wait for their answer before reporting an outcome`
      : `Ted asked the human whether to keep sending ${task.displayId} back (request ${asked.id}); wait for their answer before reporting an outcome`
  }

  function diagnosing(taskId: string, since: string): boolean {
    return store.sendBackAsks(taskId).some((ask) => {
      const answer = validates(ask.from) ? store.getComment(ask.commentId)?.answer : undefined
      return answer?.kind === 'answered' && answer.choice === diagnoseChoice && answer.at >= since
    })
  }

  function recover(): void {
    for (const check of store.loopChecks().filter((c) => c.verdict === undefined)) {
      inBackground('wait for a loop check', () => awaitLoopCheck(check))
    }
  }

  return {
    decide,
    heldFor,
    heldForFindings,
    checking,
    pending,
    openSendBackAsk,
    refuseOutcome,
    diagnosing,
    recover,
    countedValidateSendBacks,
  }
}

function verdictIn(text: string): LoopVerdict | undefined {
  const found = [...text.matchAll(/verdict:\s*\**\s*(converging|looping)/gi)].at(-1)?.[1]
  const verdict = found?.toLowerCase()
  return verdict === 'converging' || verdict === 'looping' ? verdict : undefined
}

function reasonIn(text: string): string {
  const reason = text
    .split('\n')
    .filter((line) => !/verdict:/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const line = redactSecrets(reason === '' ? 'no reason given' : reason)
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}
