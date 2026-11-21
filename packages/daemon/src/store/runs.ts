import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { queryDb } from '@livestore/livestore'
import type {
  AgentApiCost,
  AgentKind,
  ApiCostReport,
  Attachment,
  Comment,
  CommentAnswer,
  Effort,
  PermissionMode,
  Run,
  RunMessage,
  Task,
} from '@ted/protocol'
import { isArray, isNumber, isObject, isString, parseJson } from '@ted/protocol/parse'
import { runRows, type StoreContext, storedPermission } from './context.ts'
import { type PhoneChatRetry, phoneChatCommit } from './phones.ts'
import { joinPrompt, type PromptPart, splitPrompt } from './prompt-parts.ts'
import {
  comments,
  conversationTabs,
  events,
  heldRuns,
  promptTexts,
  runInterrupts,
  runMessages,
  runs,
  runUsage,
  subAgentInstructions,
  subAgentRequests,
  taskRepos,
} from './schema.ts'
import type {
  HeldRun,
  NewPermissionPrompt,
  PermissionTarget,
  RunFlags,
  RunInterrupt,
  RunOutput,
  RunSteeringRelease,
  SubAgentRequest,
} from './types.ts'

function realPath(dir: string): string {
  const resolved = path.resolve(dir)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export interface RunsArea {
  startRun(input: {
    id: string
    agent: AgentKind
    sessionId?: string
    prompt: string
    cwd: string
    taskId?: string
    model?: string
    effort?: Effort
    parentRunId?: string
    name?: string
    permissions?: PermissionMode
    shared?: readonly string[]
  }): Run
  runPrompt(runId: string): string
  failRun(runId: string, error: string): void
  requestSubAgent(request: Omit<SubAgentRequest, 'at'>): SubAgentRequest
  subAgentRequests(taskId?: string): SubAgentRequest[]
  dropSubAgentRequest(id: string): void
  setOnSubAgents(runId: string, on: boolean): void
  onSubAgents(runId: string): boolean
  reconcileRunState(runId: string): void
  recordRunOutput(runId: string, output: RunOutput): boolean
  holdRunOutput(
    runId: string,
    read: { from: number; toOffset: number; lastOutputAt?: string },
  ): void
  savedReadOffset(id: string): number
  permissionTarget(commentId: string): PermissionTarget | undefined
  answerPermission(commentId: string, answer: CommentAnswer): Comment
  setRunPermissions(runId: string, permissions: PermissionMode): void
  setRunAsleep(runId: string, asleep: boolean): void
  setLiveTokens(runId: string, tokens: number | undefined): void
  restartRun(runId: string, flags: RunFlags): Run
  reviveRun(runId: string, flags?: RunFlags): Run
  lastOutputAt(runId: string): string | undefined
  getRun(id: string): Run | undefined
  runProblemAt(runId: string): string | undefined
  listRuns(): Run[]
  liveRuns(): Run[]
  busyTaskIds(): string[]
  runReadOffset(id: string): number
  recordRunUsage(usage: {
    runId: string
    agent: AgentKind
    model?: string
    input: number
    output: number
    cost?: number
  }): void
  apiCost(days: number, now?: Date): ApiCostReport
  taskRunList(taskId: string): Run[]
  recordRunMessage(input: {
    runId: string
    text: string
    lead: boolean
    phoneChat?: RunPhoneChat | undefined
    files?: readonly Attachment[]
  }): RunMessage
  queueRunMessage(input: {
    runId: string
    text: string
    from?: 'ted'
    phoneChat?: RunPhoneChat | undefined
    files?: readonly Attachment[]
  }): RunMessage
  deliverRunMessages(runId: string, ids: readonly string[], lead: boolean): void
  deleteRunMessage(runId: string, id: string): RunMessage | undefined
  releaseRunSteering(runId: string, release: RunSteeringRelease): void
  runSteeringRelease(runId: string): RunSteeringRelease | undefined
  recordTurnInterrupted(runId: string, hold: boolean): RunInterrupt
  runMessages(runId: string): RunMessage[]
  runMessageFiles(ids: readonly string[]): Map<string, Attachment[]>
  runInterrupts(runId: string): RunInterrupt[]
  openTab(taskId: string, runId: string): Task
  closeTab(taskId: string, runId: string): Task
  pauseAgent(agent: AgentKind, reason: string | undefined): void
  agentPauses(): Partial<Record<AgentKind, string>>
  holdTaskRun(held: HeldRun): void
  releaseTaskRun(taskId: string): void
  heldRuns(): HeldRun[]
  pausedRunCount(agent: AgentKind): number
}

export interface RunPhoneChat {
  retry: PhoneChatRetry
  chatId: string
}

export function queuedPhoneChatMessage(runId: string, text: string, files: readonly Attachment[]) {
  const message: RunMessage = {
    id: randomUUID(),
    runId,
    text,
    at: new Date().toISOString(),
    queued: true,
    ...(files.length > 0 && { attachments: [...files] }),
  }
  return {
    message,
    writes: [
      events.runMessageQueued({ id: message.id, at: message.at, runId, text, taskId: null }),
      ...filesAttached(message.id, runId, files),
    ],
  }
}

export function runsArea(ctx: StoreContext): RunsArea {
  const {
    storeState,
    store,
    waitingOnSubAgents,
    asleepRuns,
    liveTokens,
    commit,
    liveRuns,
    taskRuns,
    queue,
    reposOf,
    pauses,
    heldRows,
    toRun,
    taskRow,
    runRow,
    taskIdOfRun,
    emit,
    requireComment,
    emitComment,
    updatedTask,
    noteActivity,
  } = ctx
  const allRuns = queryDb(runRows.orderBy('startedAt', 'asc'))

  const toSubAgentRequest = ({
    model,
    effort,
    ...row
  }: typeof subAgentRequests.Type): SubAgentRequest => ({
    ...row,
    agent: row.agent as AgentKind,
    ...(model !== null && { model }),
    ...(effort !== null && { effort: effort as Effort }),
  })

  const heldRow = (taskId: string) => heldRows(taskId).at(0)

  const promptTextCache = new Map<string, string>()
  const promptText = (hash: string): string | undefined => {
    const cached = promptTextCache.get(hash)
    if (cached !== undefined) return cached
    const text = store.query(queryDb(promptTexts.select('text').where({ hash }))).at(0)
    if (text !== undefined) promptTextCache.set(hash, text)
    return text
  }

  const openPermissionRows = (runId: string, requestId?: string) =>
    store
      .query(queryDb(comments.where({ authorRunId: runId, kind: 'permission' })))
      .filter(
        (row) =>
          row.answer === null &&
          (requestId === undefined
            ? row.permission !== null || row.simulator !== null
            : row.permission !== null && storedPermission(row.permission).requestId === requestId),
      )

  const heldOutput = new Map<string, { toOffset: number; lastOutputAt?: string }>()

  const repoAt = (taskId: string, cwd: string) => {
    if (!path.isAbsolute(cwd)) return undefined
    const real = realPath(cwd)
    return reposOf(taskId).find((r) => {
      const inside = path.relative(realPath(r.worktree), real)
      return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))
    })?.name
  }
  const askedEvent = (taskId: string, runId: string, prompt: NewPermissionPrompt, at: string) => {
    const id = randomUUID()
    const task = taskRow(taskId)
    const run = runRow(runId)
    const repo = task && run ? repoAt(taskId, prompt.cwd ?? run.cwd) : undefined
    return {
      id,
      event: events.permissionRequested({
        id,
        taskId,
        runId,
        requestId: prompt.requestId,
        stage: task?.stage ?? null,
        title: prompt.title,
        body: prompt.reason ?? '',
        command: prompt.command,
        details: prompt.details ?? null,
        generation: prompt.generation,
        repo: repo ?? null,
        input: prompt.input === undefined ? null : JSON.stringify(prompt.input),
        createdAt: at,
      }),
    }
  }

  const observedRuns = new Set<string>()

  return {
    startRun({
      taskId,
      sessionId,
      model,
      effort,
      permissions = 'auto',
      parentRunId,
      name,
      prompt,
      shared = [],
      ...input
    }) {
      const instructions = store
        .query(queryDb(subAgentInstructions.select('text').where({ id: input.id })))
        .at(0)
      const { parts, texts } = splitPrompt(
        prompt,
        shared,
        instructions === undefined ? undefined : { id: input.id, text: instructions },
      )
      const row = {
        ...input,
        sessionId: sessionId ?? '',
        taskId: taskId ?? null,
        model: model ?? null,
        effort: effort ?? null,
        parentRunId: parentRunId ?? null,
        name: name ?? null,
        startedAt: new Date().toISOString(),
      }
      const unseen = [...texts].filter(([hash]) => promptText(hash) === undefined)
      commit(
        ...unseen.map(([hash, text]) => events.promptTextSeen({ hash, text, at: row.startedAt })),
        events.runStartedV5({ ...row, promptParts: parts }),
        events.runPermissionsSet({ runId: row.id, permissions, at: row.startedAt }),
      )
      observedRuns.add(row.id)
      const run = toRun({
        ...row,
        retrying: false,
        steeringRelease: null,
        usesDefaultModel: false,
        problem: null,
        problemAt: null,
        failure: null,
        permissions,
        manualPermissions: false,
        state: 'working',
        readOffset: 0,
        lastOutputAt: null,
        revivedAt: null,
        ended: null,
      })
      emit({ type: 'run-updated', run })
      if (taskId !== undefined) updatedTask(taskId)
      noteActivity()
      return run
    },
    runPrompt(runId) {
      const row = store
        .query(queryDb(runs.select('prompt', 'promptParts').where({ id: runId })))
        .at(0)
      if (row === undefined) return ''
      if (row.promptParts === null) return row.prompt
      return joinPrompt(JSON.parse(row.promptParts) as PromptPart[], promptText, (id) =>
        store.query(queryDb(subAgentInstructions.select('text').where({ id }))).at(0),
      )
    },
    failRun(runId, error) {
      commit(events.runFailed({ runId, error, at: new Date().toISOString() }))
      const row = runRow(runId)
      if (row) emit({ type: 'run-updated', run: toRun(row) })
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined) updatedTask(taskId)
    },
    requestSubAgent({ model, effort, ...request }) {
      const at = new Date().toISOString()
      commit(
        events.subAgentRequestedV2({
          ...request,
          model: model ?? null,
          effort: effort ?? null,
          at,
        }),
      )
      updatedTask(request.taskId)
      return {
        ...request,
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
        at,
      }
    },
    subAgentRequests: (taskId) =>
      store
        .query(
          queryDb(
            (taskId === undefined ? subAgentRequests : subAgentRequests.where({ taskId })).orderBy(
              'at',
              'asc',
            ),
          ),
        )
        .map(toSubAgentRequest),
    dropSubAgentRequest(id) {
      const row = store.query(queryDb(subAgentRequests.where({ id }))).at(0)
      if (!row) return
      commit(events.subAgentRequestDropped({ id, at: new Date().toISOString() }))
      updatedTask(row.taskId)
    },
    setOnSubAgents(runId, on) {
      if (waitingOnSubAgents.has(runId) === on) return
      storeState.stateCommits += 1
      if (on) waitingOnSubAgents.add(runId)
      else waitingOnSubAgents.delete(runId)
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined) updatedTask(taskId)
      noteActivity()
    },
    onSubAgents: (runId) => waitingOnSubAgents.has(runId),
    reconcileRunState(runId) {
      if (observedRuns.has(runId)) return
      const run = runRow(runId)
      if (!run || run.state === 'finished') return
      commit(events.runStateObserved({ runId, state: run.state, at: new Date().toISOString() }))
      observedRuns.add(runId)
    },
    recordRunOutput(
      runId,
      {
        toOffset,
        output,
        state,
        sessionId,
        problem,
        permissionPrompts = [],
        closedPermissions = [],
        autoModeUnavailable,
        agentRestarted,
        ending,
        memoryKilled,
        retrying,
      },
    ) {
      const current = runRow(runId)
      if (!current) throw new Error(`no Run ${runId}`)
      const at = new Date().toISOString()
      const taskId = current.taskId
      const asked =
        taskId === null
          ? []
          : permissionPrompts.map((prompt) => askedEvent(taskId, runId, prompt, at))
      const answeredAtOnce = asked.flatMap(({ id }, index) =>
        state === 'finished'
          ? [{ id, answer: { kind: 'withdrawn', at, runStopped: true } as CommentAnswer }]
          : closedPermissions.includes(permissionPrompts[index]?.requestId ?? '')
            ? [{ id, answer: { kind: 'withdrawn', at, cancelled: true } as CommentAnswer }]
            : [],
      )
      const withdrawn = [
        ...closedPermissions.flatMap((requestId) =>
          openPermissionRows(runId, requestId).map((row) => ({
            id: row.id,
            answer: { kind: 'withdrawn', at, cancelled: true } as CommentAnswer,
          })),
        ),
        ...(state === 'finished' || agentRestarted
          ? openPermissionRows(runId).map((row) => ({
              id: row.id,
              answer: { kind: 'withdrawn', at, runStopped: true } as CommentAnswer,
            }))
          : []),
      ]
      withdrawn.push(...answeredAtOnce)
      const withdrawnOnce = withdrawn.filter(
        ({ id }, index) => withdrawn.findIndex((w) => w.id === id) === index,
      )
      const unavailable =
        autoModeUnavailable === true && current.permissions === 'auto' && !current.manualPermissions
      const newProblem = problem !== undefined && current.problem === null
      const holding = (current.problem !== null || newProblem) && state === 'idle'
      const target = holding ? 'waiting' : state
      const stateChanged = target !== undefined && target !== current.state
      const nowRetrying = state === 'finished' ? false : (retrying ?? current.retrying)
      const retryChanged = nowRetrying !== current.retrying
      const held = heldOutput.get(runId)
      const lastOutputAt = output ? (output.lastAt ?? at) : held?.lastOutputAt
      const changes = [
        ...(sessionId !== undefined && sessionId !== current.sessionId
          ? [events.runSessionIdentified({ runId, sessionId })]
          : []),
        ...(newProblem ? [events.runProblemFound({ runId, problem, at })] : []),
        ...(retryChanged ? [events.runRetryingChanged({ runId, retrying: nowRetrying, at })] : []),
        ...(ending ? [events.runEnded({ runId, ending: JSON.stringify(ending), at })] : []),
        ...(ending && memoryKilled
          ? [
              events.runKilledForMemory({
                runId,
                taskId,
                lowestMemory: memoryKilled.lowestMemory,
                at,
              }),
            ]
          : []),
        ...(stateChanged && target !== undefined
          ? [events.runStateChanged({ runId, state: target, at })]
          : []),
        ...(unavailable ? [events.runAutoModeUnavailable({ runId, taskId, at })] : []),
        ...asked.flatMap(({ id, event }) => [
          event,
          events.commentPurposeRecorded({
            commentId: id,
            purpose: JSON.stringify({ kind: 'permission' }),
          }),
        ]),
        ...withdrawnOnce.map(({ id, answer }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      ]
      if (changes.length === 0) {
        heldOutput.set(runId, { toOffset, ...(lastOutputAt !== undefined && { lastOutputAt }) })
        if (output) emit({ type: 'run-output', runId, lines: true })
        return false
      }
      storeState.waitingUnchanged = asked.length === 0 && withdrawnOnce.length === 0
      try {
        commit(
          events.runOutputReadV3({ runId, toOffset, lastOutputAt: lastOutputAt ?? null }),
          ...changes,
        )
      } finally {
        storeState.waitingUnchanged = false
      }
      heldOutput.delete(runId)
      if (output) emit({ type: 'run-output', runId, lines: true })
      for (const { id } of asked) emit({ type: 'comment-posted', comment: requireComment(id) })
      for (const { id } of withdrawnOnce) emitComment(id)
      if (asked.length > 0 || withdrawnOnce.length > 0 || retryChanged) {
        if (taskId !== null && !(newProblem || stateChanged)) updatedTask(taskId)
      }
      if (newProblem || stateChanged || unavailable) {
        const row = runRow(runId)
        if (row) emit({ type: 'run-updated', run: toRun(row) })
        const taskId = taskIdOfRun(runId)
        if (taskId !== undefined) updatedTask(taskId)
      }
      if (stateChanged) {
        observedRuns.add(runId)
        noteActivity()
      }
      return true
    },
    holdRunOutput(runId, { from, toOffset, lastOutputAt }) {
      if (runRow(runId)?.readOffset !== from || toOffset <= from) return
      heldOutput.set(runId, { toOffset, ...(lastOutputAt !== undefined && { lastOutputAt }) })
    },
    savedReadOffset: (id) => runRow(id)?.readOffset ?? 0,
    setRunPermissions(runId, permissions) {
      const row = runRow(runId)
      if (!row || row.permissions === permissions) return
      commit(events.runPermissionsSet({ runId, permissions, at: new Date().toISOString() }))
      emit({ type: 'run-updated', run: toRun(runRow(runId) ?? row) })
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined) updatedTask(taskId)
    },
    setLiveTokens(runId, tokens) {
      if (liveTokens.get(runId) === tokens) return
      if (tokens === undefined) liveTokens.delete(runId)
      else liveTokens.set(runId, tokens)
      storeState.stateCommits += 1
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined && taskRow(taskId)) updatedTask(taskId)
    },
    setRunAsleep(runId, asleep) {
      if (asleepRuns.has(runId) === asleep) return
      if (asleep) asleepRuns.add(runId)
      else asleepRuns.delete(runId)
      const row = runRow(runId)
      if (row) emit({ type: 'run-updated', run: toRun(row) })
    },
    restartRun(runId, { model, effort, usesDefaultModel = false }) {
      const at = new Date().toISOString()
      const withdrawn = openPermissionRows(runId)
      const answer: CommentAnswer = { kind: 'withdrawn', at, runStopped: true }
      commit(
        events.runRestarted({
          runId,
          model: model ?? null,
          effort: effort ?? null,
          usesDefaultModel,
          at,
        }),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const row = runRow(runId)
      if (!row) throw new Error(`no Run ${runId}`)
      const run = toRun(row)
      emit({ type: 'run-updated', run })
      const taskId = taskIdOfRun(runId)
      noteActivity()
      if (taskId !== undefined) updatedTask(taskId)
      return run
    },
    reviveRun(runId, flags) {
      const at = new Date().toISOString()
      commit(
        ...(flags
          ? [
              events.runRestarted({
                runId,
                model: flags.model ?? null,
                effort: flags.effort ?? null,
                usesDefaultModel: flags.usesDefaultModel ?? false,
                at,
              }),
            ]
          : []),
        events.runRevived({ runId, taskId: taskIdOfRun(runId) ?? null, at }),
      )
      const row = runRow(runId)
      if (!row) throw new Error(`no Run ${runId}`)
      const run = toRun(row)
      emit({ type: 'run-updated', run })
      const taskId = taskIdOfRun(runId)
      noteActivity()
      if (taskId !== undefined) updatedTask(taskId)
      return run
    },
    lastOutputAt: (runId) =>
      heldOutput.get(runId)?.lastOutputAt ?? runRow(runId)?.lastOutputAt ?? undefined,
    getRun(id) {
      const row = runRow(id)
      return row && toRun(row)
    },
    permissionTarget(commentId) {
      const row = store.query(queryDb(comments.where({ id: commentId }))).at(0)
      if (!row?.permission || row.authorRunId === null) return undefined
      const { requestId, generation, command, input } = storedPermission(row.permission)
      return {
        runId: row.authorRunId,
        requestId,
        generation: generation ?? 1,
        command,
        ...(input !== undefined && { input: JSON.parse(input) as unknown }),
      }
    },
    answerPermission(commentId, answer) {
      const row = store.query(queryDb(comments.where({ id: commentId }))).at(0)
      const runId = row?.authorRunId ?? undefined
      const run = runId === undefined ? undefined : runRow(runId)
      const othersOpen =
        runId === undefined
          ? false
          : openPermissionRows(runId).some((other) => other.id !== commentId)
      const resume =
        run !== undefined && run.state === 'waiting' && run.problem === null && !othersOpen
      commit(
        events.commentAnswered({ id: commentId, answer: JSON.stringify(answer), at: answer.at }),
        ...(resume && run
          ? [events.runStateChanged({ runId: run.id, state: 'working', at: answer.at })]
          : []),
      )
      if (resume && run) {
        const updated = runRow(run.id)
        if (updated) emit({ type: 'run-updated', run: toRun(updated) })
        noteActivity()
      }
      const comment = emitComment(commentId)
      updatedTask(comment.taskId)
      return comment
    },
    runProblemAt: (runId) => runRow(runId)?.problemAt ?? undefined,
    listRuns: () => store.query(allRuns).map(toRun),
    liveRuns: () => store.query(liveRuns).map(toRun),
    busyTaskIds: () => [
      ...store.query(queryDb(runRows.where({ state: 'working' }))).flatMap((r) => r.taskId ?? []),
      ...store.query(queryDb(taskRepos.where({ setupState: 'running' }))).map((r) => r.taskId),
    ],
    runReadOffset: (id) => Math.max(runRow(id)?.readOffset ?? 0, heldOutput.get(id)?.toOffset ?? 0),
    recordRunUsage({ runId, agent, model, input, output, cost }) {
      commit(
        events.runUsageRecorded({
          runId,
          agent,
          model: model ?? null,
          input,
          output,
          cost: cost ?? null,
          at: new Date().toISOString(),
        }),
      )
      const row = runRow(runId)
      if (row) emit({ type: 'run-updated', run: toRun(row) })
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined && taskRow(taskId)) updatedTask(taskId)
    },
    apiCost(days, now = new Date()) {
      const since = new Date(now.getTime() - days * 86_400_000).toISOString()
      const rows = store.query(queryDb(runUsage.orderBy('at', 'asc')))
      const agents = new Map<AgentKind, AgentApiCost>()
      for (const row of rows) {
        if (row.at < since) continue
        const agent = row.agent as AgentKind
        const sum = agents.get(agent) ?? {
          agent,
          runs: 0,
          pricedRuns: 0,
          cost: 0,
          input: 0,
          output: 0,
        }
        sum.runs += 1
        sum.input += row.input
        sum.output += row.output
        if (row.cost !== null) {
          sum.pricedRuns += 1
          sum.cost += row.cost
        }
        agents.set(agent, sum)
      }
      const first = rows[0]?.at
      return {
        days,
        since,
        ...(first !== undefined && { countedFrom: first }),
        agents: [...agents.values()],
      }
    },
    taskRunList: (taskId) => taskRuns(taskId).map(toRun),
    recordRunMessage({ runId, text, lead, phoneChat, files = [] }) {
      const taskId = taskIdOfRun(runId) ?? null
      const message = { id: randomUUID(), runId, text, at: new Date().toISOString() }
      const sent = events.runMessageSent({ ...message, taskId, lead: lead && taskId !== null })
      const attachments = filesAttached(message.id, runId, files)
      if (phoneChat) {
        commit(
          phoneChatCommit(
            { ...phoneChat.retry, chatKind: 'plan', chatId: phoneChat.chatId, queued: false },
            [sent, ...attachments],
          ),
        )
      } else {
        commit(sent, ...attachments)
      }
      emit({ type: 'run-output', runId })
      if (taskId !== null && lead) updatedTask(taskId)
      return { ...message, ...(files.length > 0 && { attachments: [...files] }) }
    },
    queueRunMessage({ runId, text, from, phoneChat, files = [] }) {
      if (phoneChat) {
        const { message, writes } = queuedPhoneChatMessage(runId, text, files)
        commit(
          phoneChatCommit(
            { ...phoneChat.retry, chatKind: 'plan', chatId: phoneChat.chatId, queued: true },
            writes,
          ),
        )
        emit({ type: 'run-output', runId })
        return message
      }
      const taskId = taskIdOfRun(runId) ?? null
      const message = { id: randomUUID(), runId, text, at: new Date().toISOString() }
      commit(
        from === 'ted'
          ? events.runMessageQueuedV2({ ...message, taskId, from })
          : events.runMessageQueued({ ...message, taskId }),
        ...filesAttached(message.id, runId, files),
      )
      emit({ type: 'run-output', runId })
      return {
        ...message,
        ...(files.length > 0 && { attachments: [...files] }),
        queued: true,
        ...(from && { from }),
      }
    },
    deliverRunMessages(runId, ids, lead) {
      if (ids.length === 0) return
      const taskId = taskIdOfRun(runId) ?? null
      const at = new Date().toISOString()
      commit(
        ...ids.map((id) =>
          events.runMessageDelivered({ id, runId, taskId, lead: lead && taskId !== null, at }),
        ),
      )
      emit({ type: 'run-output', runId })
      if (taskId !== null && lead) updatedTask(taskId)
    },
    deleteRunMessage(runId, id) {
      const row = store.query(queryDb(runMessages.where({ id, runId }))).at(0)
      if (!row?.queued) return undefined
      commit(events.runMessageDeleted({ id, runId, at: new Date().toISOString() }))
      emit({ type: 'run-output', runId })
      const files = storedFiles(row.files)
      return {
        id,
        runId,
        text: row.text,
        ...(files.length > 0 && { attachments: files }),
        at: row.at,
      }
    },
    releaseRunSteering(runId, release) {
      commit(events.runSteeringReleased({ runId, release: JSON.stringify(release) }))
    },
    runSteeringRelease(runId) {
      const release = runRow(runId)?.steeringRelease
      return release ? (JSON.parse(release) as RunSteeringRelease) : undefined
    },
    recordTurnInterrupted(runId, hold) {
      const taskId = taskIdOfRun(runId) ?? null
      const interrupt = { id: randomUUID(), runId, hold, at: new Date().toISOString() }
      commit(events.runTurnInterrupted({ ...interrupt, taskId }))
      emit({ type: 'run-output', runId })
      return interrupt
    },
    runMessages: (runId) =>
      store
        .query(queryDb(runMessages.where({ runId, deletedAt: null }).orderBy('at', 'asc')))
        .map(({ id, text, at, queued, fromTed, files }) => {
          const attachments = storedFiles(files)
          return {
            id,
            runId,
            text,
            ...(attachments.length > 0 && { attachments }),
            at,
            ...(queued && { queued }),
            ...(fromTed && { from: 'ted' as const }),
          }
        }),
    runMessageFiles(ids) {
      const found = new Map<string, Attachment[]>()
      if (ids.length === 0) return found
      const rows = store.query(
        queryDb(
          runMessages
            .select('id', 'files')
            .where({ id: { op: 'IN', value: [...ids] }, files: { op: '!=', value: null } }),
        ),
      )
      for (const row of rows) {
        const files = storedFiles(row.files)
        if (files.length > 0) found.set(row.id, files)
      }
      return found
    },
    runInterrupts: (runId) =>
      store
        .query(queryDb(runInterrupts.where({ runId }).orderBy('at', 'asc')))
        .map(({ id, hold, at }) => ({ id, runId, hold, at })),
    openTab(taskId, runId) {
      const at = new Date().toISOString()
      if (store.query(queryDb(conversationTabs.where({ id: `${taskId}:${runId}` }))).length === 0) {
        commit(events.conversationTabOpened({ taskId, runId, at }))
      }
      return updatedTask(taskId)
    },
    closeTab(taskId, runId) {
      if (store.query(queryDb(conversationTabs.where({ id: `${taskId}:${runId}` }))).length > 0) {
        commit(events.conversationTabClosed({ taskId, runId, at: new Date().toISOString() }))
      }
      return updatedTask(taskId)
    },
    pauseAgent(agent, reason) {
      const current = pauses()[agent]
      if (current === reason) return
      const at = new Date().toISOString()
      commit(
        reason === undefined
          ? events.agentResumed({ agent, at })
          : events.agentPaused({ agent, reason, at }),
      )
      const affected = new Set([
        ...store
          .query(queryDb(runRows.where({ agent })))
          .filter((r) => r.state !== 'finished' && r.taskId !== null)
          .map((r) => r.taskId as string),
        ...store.query(queryDb(heldRuns.where({ agent }))).map((h) => h.taskId),
        ...queue()
          .filter((q) => taskRow(q.id)?.leadAgent === agent)
          .map((q) => q.id),
      ])
      for (const taskId of affected) updatedTask(taskId)
      noteActivity()
    },
    agentPauses: pauses,
    holdTaskRun({ taskId, agent, sessionId, pickUp, carried }) {
      const current = heldRow(taskId)
      if (
        current &&
        current.agent === agent &&
        (current.sessionId ?? undefined) === sessionId &&
        (current.pickUp ?? undefined) === pickUp &&
        (current.carriedRunId ?? undefined) === carried?.runId &&
        (current.carriedMessageIds ?? []).join('\n') === (carried?.messageIds ?? []).join('\n')
      ) {
        return
      }
      commit(
        events.taskRunHeldV2({
          taskId,
          agent,
          sessionId: sessionId ?? null,
          pickUp: pickUp ?? null,
          carried: carried ? { runId: carried.runId, messageIds: [...carried.messageIds] } : null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
      noteActivity()
    },
    releaseTaskRun(taskId) {
      if (!heldRow(taskId)) return
      commit(events.taskRunReleased({ taskId, at: new Date().toISOString() }))
      updatedTask(taskId)
      noteActivity()
    },
    heldRuns: () =>
      store.query(queryDb(heldRuns.orderBy('at', 'asc'))).map((row) => ({
        taskId: row.taskId,
        agent: row.agent as AgentKind,
        ...(row.sessionId !== null && { sessionId: row.sessionId }),
        ...(row.pickUp !== null && { pickUp: row.pickUp }),
        ...(row.carriedRunId !== null && {
          carried: { runId: row.carriedRunId, messageIds: row.carriedMessageIds ?? [] },
        }),
      })),
    pausedRunCount: (agent) =>
      store.query(queryDb(runRows.where({ agent }))).filter((r) => r.state !== 'finished').length +
      store.query(queryDb(heldRuns.where({ agent }))).length,
  }
}

function filesAttached(id: string, runId: string, files: readonly Attachment[]) {
  return files.length > 0 ? [events.runMessageFilesAttached({ id, runId, files: [...files] })] : []
}

export function storedFiles(text: string | null): Attachment[] {
  if (text === null) return []
  const value = parseJson(text)
  if (!isArray(value)) return []
  return value.flatMap((item) =>
    isObject(item) &&
    isString(item.hash) &&
    isString(item.name) &&
    isNumber(item.size) &&
    isString(item.mediaType)
      ? [{ hash: item.hash, name: item.name, size: item.size, mediaType: item.mediaType }]
      : [],
  )
}
