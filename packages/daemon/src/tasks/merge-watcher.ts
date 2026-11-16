import type { Comment, GitHubWait, SendBackCause, Task } from '@ted/protocol'
import { mergesHere } from '@ted/protocol/stage'
import type { Clock } from '../clock.ts'
import { RequestError } from '../errors.ts'
import * as git from '../git.ts'
import { type Gh, GhError } from '../github/gh.ts'
import { redactSecrets } from '../redact.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import { unscoped } from './ci-failures.ts'
import { checkList } from './github-activity.ts'
import {
  acceptedFailing,
  chooseMethod,
  ciState,
  deleteBranch,
  disableAutoMerge,
  failingChecks,
  type MergeTarget,
  mergePullRequest,
  nextStep,
  type PullRequestRead,
  type RemoteCheck,
  type RemotePullRequest,
  rebasePullRequest,
  relevantChecks,
} from './merge.ts'

export type MergeCycle = 'done' | 'wait' | 'busy'
export type MergeMode = 'off' | 'lead' | 'gate' | 'merge' | 'canceled'
export type MergeWork = MergeTarget & { url: string; worktree: string }

export interface MergePort {
  find(id: string): StoredTask
  busy(id: string): boolean
  held?(id: string): boolean
  untilFree(id: string): Promise<void>
  holding<T>(task: StoredTask, work: () => Promise<T>): Promise<T>
  resolve(task: StoredTask): Promise<WorkflowResolution>
  targets(task: StoredTask, resolution: WorkflowResolution): Promise<MergeWork[]>
  checks(id: string, resolution: WorkflowResolution): Promise<boolean>
  sendBack(
    id: string,
    findings: string,
    checkRunId?: string,
    toValidate?: boolean,
    options?: { cause?: SendBackCause },
  ): Promise<MergeCycle>
  finish(id: string): Promise<MergeCycle>
  postGate(
    task: StoredTask,
    ready: readonly { target: MergeWork; pr: RemotePullRequest }[],
  ): Promise<void>
  recordPullRequests(task: StoredTask, read: PullRequestRead): void
  requireObligations(task: StoredTask, read?: PullRequestRead): Promise<void>
  read(): Promise<PullRequestRead | undefined>
  ciFailures?(id: string, read: PullRequestRead): Promise<void>
  acceptedCi?(id: string): ReadonlySet<string>
  ciBlocked?(
    id: string,
    target: MergeWork,
    pr: RemotePullRequest,
    checks: readonly RemoteCheck[],
  ): Promise<void>
  beforeMerge?: ((id: string) => Promise<void>) | undefined
}

export interface MergeWatcherOptions {
  store: TedStore
  gh: Gh | undefined
  clock: Clock
  ciStuckMs: { noChecks: number; pending: number }
  port: MergePort
}

export function createMergeWatcher(options: MergeWatcherOptions) {
  const { store, clock, ciStuckMs, port } = options
  const {
    find,
    untilFree,
    holding,
    targets: mergeTargets,
    checks: mergeChecks,
    sendBack: mergeSendBack,
    finish: finishMerge,
    postGate: postMergeGate,
    recordPullRequests,
    requireObligations,
  } = port
  const rebaseAsked = new Map<string, { from: string; to: string }>()
  const autoMergeTried = new Set<string>()
  const inFlight = new Map<string, Promise<MergeCycle>>()
  const held = new Map<string, string>()
  const visitStart = (task: Task) =>
    store.listStageEntries(task.id).findLast((e) => e.stage === task.stage)?.at ?? ''
  const needsSignOff = (target: MergeWork, why: string) =>
    `${why} TED merges only the commits the human signed off (${target.expectedHead || 'none recorded'} on ${target.repo}#${target.number}). Bring the Task back through Validate for a new sign-off.`
  const mergeSplit = (task: StoredTask) => {
    const repos = task.repos.filter((r) => !r.removed && r.pullRequest)
    return (
      repos.some((r) => r.pullRequest?.state === 'merged') &&
      repos.some((r) => r.pullRequest?.state !== 'merged')
    )
  }
  const conflictSendBack = (taskId: string, target: MergeWork) =>
    mergeSendBack(taskId, conflictFindings(target), undefined, false, { cause: 'base-conflict' })
  function setWait(taskId: string, name: string, on: GitHubWait | undefined): void {
    const repo = find(taskId).repos.find((r) => r.name === name)
    if (repo?.pullRequest && repo.pullRequest.waiting !== on) {
      store.pullRequestWaiting(taskId, name, on)
    }
  }

  function clearSignIn(taskId: string, read: PullRequestRead | undefined): void {
    if (!read) return
    for (const repo of store.getTask(taskId)?.repos ?? []) {
      const pr = repo.pullRequest
      if (
        pr?.waiting === 'sign-in' &&
        pr.state !== 'merged' &&
        read.pulls.has(`${taskId}:${repo.name}`)
      )
        store.pullRequestWaiting(taskId, repo.name, undefined)
    }
  }

  async function obligations(taskId: string, read?: PullRequestRead): Promise<void> {
    try {
      await requireObligations(find(taskId), read)
      held.delete(taskId)
    } catch (error) {
      const why = redactSecrets(textOf(error))
      if (held.get(taskId) !== why) {
        held.set(taskId, why)
        console.error(`${store.getTask(taskId)?.displayId ?? taskId}’s merge is waiting: ${why}`)
      }
      throw error
    }
  }

  async function adoptRebase(
    task: StoredTask,
    target: MergeWork,
    head: string,
  ): Promise<MergeCycle> {
    rebaseAsked.delete(`${task.id}:${target.name}`)
    const signedOff = target.expectedHead
    const fetched = await git.fetchBranch(target.worktree, {
      url: target.url,
      branch: target.branch,
      haves: [signedOff],
    })
    const baseTip = await git.fetchBranch(target.worktree, {
      url: target.url,
      branch: target.base,
      haves: [signedOff],
    })
    const oldBase = await git.mergeBase(target.worktree, signedOff, baseTip)
    const pureRebase =
      fetched === head &&
      (await git.isAncestor(target.worktree, baseTip, head)) &&
      (await git.replayedTree(target.worktree, {
        from: oldBase,
        to: signedOff,
        onto: baseTip,
      })) === (await git.treeOf(target.worktree, head))
    if (!pureRebase) {
      return mergeSendBack(
        task.id,
        needsSignOff(
          target,
          `The branch on GitHub after TED’s rebase isn’t the signed-off work rebased onto ${target.base}.`,
        ),
        undefined,
        true,
      )
    }
    if ((await git.headCommit(target.worktree)) !== signedOff) {
      return mergeSendBack(
        task.id,
        needsSignOff(
          target,
          `The worktree for ${target.name} has commits that weren’t signed off.`,
        ),
        undefined,
        true,
      )
    }
    await git.moveBranchTo(target.worktree, head)
    store.branchRebased(task.id, target.name, { commit: head, onto: target.base })
    return 'busy'
  }

  async function enableAutoMerge(
    gh: Gh,
    task: StoredTask,
    target: MergeWork,
    pr: RemotePullRequest,
  ): Promise<void> {
    const key = `${task.id}:${target.name}:${target.expectedHead}`
    const method = chooseMethod(target.method, pr.allowed)
    if (!method || autoMergeTried.has(key)) return
    try {
      await holding(find(task.id), async () => {
        await obligations(task.id)
        autoMergeTried.add(key)
        await mergePullRequest(gh, target, method, { auto: true })
        store.autoMergeEnabled(task.id, target.name, { method, requested: target.method })
        await store.persisted()
      })
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) return
      console.error(
        `couldn’t turn on auto-merge for ${target.repo}#${target.number}:`,
        redactSecrets(textOf(error)),
      )
    }
  }

  async function removeMergedBranch(
    gh: Gh,
    target: Pick<MergeTarget, 'repo' | 'branch'>,
    pr: RemotePullRequest,
  ) {
    if (pr.deleteBranchOnMerge) return
    await deleteBranch(gh, target).catch((error: unknown) =>
      console.error(
        `couldn’t delete the branch ${target.branch} on ${target.repo}:`,
        redactSecrets(textOf(error)),
      ),
    )
  }

  function ciStuckQuestions(task: Task): Comment[] {
    const since = visitStart(task)
    return store.listComments(task.id).filter((c) => isCiStuck(c) && c.createdAt >= since)
  }

  function lastPushAt(task: Task): string {
    return task.repos
      .flatMap((r) => (r.removed || !r.pushed ? [] : [r.pushed.at]))
      .reduce(latest, visitStart(task))
  }

  function mergeAnyway(task: Task): boolean {
    const pushed = lastPushAt(task)
    return ciStuckQuestions(task).some(
      (c) =>
        c.createdAt >= pushed && c.answer?.kind === 'answered' && mergesWithoutCi(c.answer.choice),
    )
  }

  async function watchCi(
    task: StoredTask,
    waiting: readonly { target: MergeWork; pr: RemotePullRequest }[],
  ): Promise<void> {
    const asked = ciStuckQuestions(task)
    const open = asked.filter((c) => c.answer === undefined)
    if (waiting.length === 0) {
      const at = new Date().toISOString()
      for (const c of open) store.answerComment(c.id, { kind: 'withdrawn', at, ciReported: true })
      return
    }
    if (open.length > 0) return
    const pushed = lastPushAt(task)
    const answeredAt = asked
      .filter((c) => c.createdAt >= pushed)
      .flatMap((c) => (c.answer ? [c.answer.at] : []))
      .reduce(latest, '')
    const now = clock.now()
    const stuck = waiting.find(({ pr }) => {
      const from = answeredAt !== '' ? answeredAt : pushed
      const wait =
        answeredAt === '' && pr.checks.length === 0 ? ciStuckMs.noChecks : ciStuckMs.pending
      return now - Date.parse(from) >= wait
    })
    if (!stuck) return
    const { target, pr } = stuck
    const pending = relevantChecks(pr).filter((c) => c.state === 'pending')
    const requiredPending = pr.checks.some((c) => c.required && c.state === 'pending')
    const where = `${target.repo}#${target.number}`
    const required = task.repos
      .find((r) => r.name === target.name)
      ?.pushed?.ciSignals.includes('required-checks')
    const offerNoCi = pr.checks.length === 0 && !requiredPending && required !== true
    const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`
    const what =
      pr.checks.length === 0
        ? `No CI check has appeared on ${where} ${minutes(answeredAt === '' ? ciStuckMs.noChecks : ciStuckMs.pending)} after ${answeredAt === '' ? 'TED pushed' : 'you said to keep waiting'}.`
        : `${checkList(pr, pending)} ${pending.length === 1 ? 'is' : 'are'} still queued or pending on ${where} after ${minutes(ciStuckMs.pending)}.`
    store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      purpose: { kind: 'ci-stuck' },
      title: pr.checks.length === 0 ? `CI hasn’t started on ${where}` : `CI is stuck on ${where}`,
      body: [
        what,
        `**${sendToLeadChoice}** sends the Task back to Work so the Task Lead can find out why. **${keepWaitingChoice}** waits another ${minutes(ciStuckMs.pending)}.${
          requiredPending
            ? ' A required check is still pending, so TED can’t merge without it.'
            : ` **${mergeAnywayChoice}** merges without waiting for the checks.`
        }${
          offerNoCi
            ? ` **${noCiAgainChoice(target.name)}** merges now and saves “Pull request CI: None” for ${target.name} in the Factory settings, through a settings pull request TED merges.`
            : ''
        }`,
      ].join('\n\n'),
      choices: [
        sendToLeadChoice,
        keepWaitingChoice,
        ...(requiredPending ? [] : [mergeAnywayChoice]),
        ...(offerNoCi ? [noCiAgainChoice(target.name)] : []),
      ],
    })
  }

  async function turnOffAutoMerge(taskId: string): Promise<string[]> {
    const gh = options.gh
    const stillOn: string[] = []
    for (const repo of find(taskId).repos) {
      const pr = repo.pullRequest
      if (repo.removed || !pr || pr.autoMerge === undefined || pr.state === 'merged') continue
      const where = `${repo.repo}#${pr.number}`
      if (!gh) {
        stillOn.push(where)
        continue
      }
      try {
        await disableAutoMerge(gh, { repo: repo.repo, number: pr.number })
        store.autoMergeDisabled(taskId, repo.name)
      } catch (error) {
        console.error(`couldn’t turn off auto-merge for ${where}:`, redactSecrets(textOf(error)))
        stillOn.push(where)
      }
    }
    return stillOn
  }

  function remoteOf(
    taskId: string,
    targets: readonly { name: string }[],
    read: PullRequestRead,
  ): Map<string, RemotePullRequest> {
    const found = new Map<string, RemotePullRequest>()
    for (const target of targets) {
      const key = `${taskId}:${target.name}`
      const host = read.hostOf.get(key)
      const failure = host === undefined ? undefined : read.failed.get(host)
      if (failure !== undefined) throw failure
      const pr = read.pulls.get(key)
      if (pr) found.set(target.name, pr)
    }
    return found
  }

  async function mergedOutside(
    taskId: string,
    read: PullRequestRead | undefined,
  ): Promise<boolean> {
    const opened = find(taskId).repos.filter((r) => !r.removed && r.pullRequest !== undefined)
    if (opened.length === 0) return false
    const open = opened.filter((r) => r.pullRequest?.state !== 'merged')
    if (open.length === 0) return true
    if (!read) return false
    let remote: Map<string, RemotePullRequest>
    try {
      remote = remoteOf(taskId, open, read)
    } catch {
      return false
    }
    if (!open.every((r) => remote.get(r.name)?.state === 'MERGED')) return false
    for (const repo of open) {
      const method = repo.pullRequest?.autoMerge
      rebaseAsked.delete(`${taskId}:${repo.name}`)
      store.pullRequestMerged(taskId, repo.name, {
        ...(method !== undefined && { method }),
        noCi: false,
        byTed: false,
      })
    }
    const gh = options.gh
    if (gh) {
      for (const repo of open) {
        const pr = remote.get(repo.name)
        if (pr) await removeMergedBranch(gh, repo, pr)
      }
    }
    return true
  }

  async function watchOnlyCycle(
    taskId: string,
    read: PullRequestRead | undefined,
    {
      markWaiting = true,
      deleteBranches = false,
    }: { markWaiting?: boolean; deleteBranches?: boolean } = {},
  ): Promise<MergeCycle> {
    const task = find(taskId)
    const open = task.repos.filter(
      (r) => !r.removed && r.pullRequest !== undefined && r.pullRequest.state !== 'merged',
    )
    if (open.length === 0) return mergesHere(task.stage) ? finishMerge(taskId) : 'done'
    if (!read) return 'wait'
    const targets = open.flatMap((r) =>
      r.pullRequest
        ? [
            {
              name: r.name,
              repo: r.repo,
              number: r.pullRequest.number,
              branch: r.branch,
              base: r.pullRequest.base,
              expectedHead: '',
              hasCi: false,
              method: 'squash' as const,
            },
          ]
        : [],
    )
    let remote: Map<string, RemotePullRequest>
    try {
      remote = remoteOf(taskId, targets, read)
    } catch (error) {
      if (needsSignIn(error)) {
        if (mergesHere(task.stage)) {
          for (const target of targets) setWait(taskId, target.name, 'sign-in')
        }
      }
      throw error
    }
    let left = 0
    for (const target of targets) {
      const pr = remote.get(target.name)
      if (pr?.state === 'MERGED') {
        store.pullRequestMerged(taskId, target.name, { noCi: false, byTed: false })
        if (deleteBranches && options.gh) await removeMergedBranch(options.gh, target, pr)
        continue
      }
      left++
      if (markWaiting && mergesHere(task.stage)) setWait(taskId, target.name, 'merge')
    }
    if (left > 0) return 'wait'
    return mergesHere(task.stage) ? finishMerge(taskId) : 'done'
  }

  async function mergeCycle(
    taskId: string,
    read: PullRequestRead | undefined,
    onlyMergedOutside: boolean,
  ): Promise<MergeCycle> {
    if (store.failures.list(taskId).length > 0) await untilFree(taskId)
    const task = find(taskId)
    if (port.busy(taskId)) return 'busy'
    if (task.stage === 'done') return watchOnlyCycle(taskId, read)
    if (mergesHere(task.stage) && !task.archived && (await mergedOutside(taskId, read)))
      return finishMerge(taskId)
    if (onlyMergedOutside) return 'wait'
    const resolution = await port.resolve(task)
    const mode = mergeMode(store, task, resolution.workflow)
    if (mode === undefined) return 'done'
    if (mode === 'canceled') {
      if ((await turnOffAutoMerge(taskId)).length > 0) return 'wait'
      return watchOnlyCycle(taskId, read, { markWaiting: false, deleteBranches: true })
    }
    if ((mode === 'gate' || mode === 'lead') && (await turnOffAutoMerge(taskId)).length > 0)
      return 'wait'
    if (mode !== 'off' && read && port.ciFailures) {
      await port.ciFailures(taskId, read)
      if (!mergesHere(find(taskId).stage)) return 'done'
    }
    if (mode !== 'off') {
      if (read) recordPullRequests(task, read)
      // Adopt our verified rebase before checking consent: the new remote head can
      // invalidate consent for the old revision before its local worktree moves.
      if (read && task.repos.some((repo) => rebaseAsked.has(`${taskId}:${repo.name}`))) {
        const targets = await mergeTargets(task, resolution)
        const remote = remoteOf(taskId, targets, read)
        for (const target of targets) {
          const asked = rebaseAsked.get(`${taskId}:${target.name}`)
          const pr = remote.get(target.name)
          if (!asked || asked.from !== target.expectedHead || !pr) continue
          const step = nextStep(target, pr, { mergeAnyway: mergeAnyway(task) })
          if (step.kind === 'changed' && asked.to === step.head)
            return adoptRebase(task, target, step.head)
        }
      }
      if (!(await mergeChecks(taskId, resolution))) return 'wait'
      const current = find(taskId)
      if (mergeMode(store, current, (await port.resolve(current)).workflow) !== mode) return 'busy'
    }
    if (port.held?.(taskId)) return 'wait'
    if (store.failures.list(task.id).length > 0) {
      if (read) recordPullRequests(task, read)
      try {
        await holding(task, async () => {
          read = await port.read()
          await obligations(taskId, read)
        })
      } catch {
        return 'wait'
      }
    }
    if (mode === 'off') return watchOnlyCycle(taskId, read)
    if (mode === 'merge') startMerging(store, task, resolution.workflow)
    const targets = await mergeTargets(find(taskId), resolution)
    if (targets.length === 0) return finishMerge(taskId)
    const unsigned = targets.find((t) => t.expectedHead === '')
    if (unsigned) {
      return mergeSendBack(
        taskId,
        needsSignOff(
          unsigned,
          `TED has no signed-off commit for ${unsigned.name}: its branch couldn’t be pushed at sign-off.`,
        ),
        undefined,
        true,
      )
    }
    const gh = options.gh
    if (!gh || !read) return 'wait'
    let remote: Map<string, RemotePullRequest>
    try {
      remote = remoteOf(taskId, targets, read)
    } catch (error) {
      if (needsSignIn(error)) {
        for (const target of targets) setWait(taskId, target.name, 'sign-in')
      }
      throw error
    }
    const ready: { target: MergeWork; pr: RemotePullRequest; noCi: boolean }[] = []
    const waitingForCi: { target: MergeWork; pr: RemotePullRequest }[] = []
    const anyway = mergeAnyway(task)
    const accepted = port.acceptedCi?.(taskId) ?? new Set<string>()
    const ci = { mergeAnyway: anyway, accepted }
    let open = 0
    for (const target of targets) {
      const pr = remote.get(target.name)
      if (!pr) {
        open++
        continue
      }
      const key = `${taskId}:${target.name}`
      const step = nextStep(target, pr, ci)
      if (step.kind !== 'merged') open++
      switch (step.kind) {
        case 'merged': {
          rebaseAsked.delete(key)
          const method = find(taskId).repos.find((r) => r.name === target.name)?.pullRequest
            ?.autoMerge
          store.pullRequestMerged(taskId, target.name, {
            ...(method !== undefined && { method }),
            noCi: false,
            byTed: false,
          })
          await removeMergedBranch(gh, target, pr)
          break
        }
        case 'closed':
          setWait(taskId, target.name, 'merge')
          break
        case 'changed': {
          const asked = rebaseAsked.get(key)
          if (asked?.from === target.expectedHead && asked.to === step.head) {
            return adoptRebase(task, target, step.head)
          }
          return mergeSendBack(
            taskId,
            needsSignOff(
              target,
              `The pull request’s branch changed on GitHub after sign-off: it’s at ${step.head}.`,
            ),
            undefined,
            true,
          )
        }
        case 'ready':
          return mergeSendBack(
            taskId,
            needsSignOff(target, `${target.repo}#${target.number} is still a draft.`),
            undefined,
            true,
          )
        case 'conflict':
          return conflictSendBack(taskId, target)
        case 'behind':
          if (rebaseAsked.get(key)?.from !== target.expectedHead) {
            try {
              const to = await holding(find(taskId), async () => {
                await obligations(taskId)
                return rebasePullRequest(gh, pr)
              })
              if (to !== undefined) rebaseAsked.set(key, { from: target.expectedHead, to })
            } catch (error) {
              if (/conflict/i.test(textOf(error))) {
                return conflictSendBack(taskId, target)
              }
              throw error
            }
          }
          setWait(taskId, target.name, 'ci')
          break
        case 'ci-failed':
          // Without an attempt identity for every check, a decision can’t be tied to one
          // attempt, so the failure is sent back as before.
          if (!port.ciFailures || [...remote.values()].some(unscoped)) {
            return mergeSendBack(
              taskId,
              `CI failed on ${target.repo}#${target.number} at Merge: ${checkList(
                pr,
                failingChecks(pr, ci),
              )}. Fix it, and the Task comes back through Validate for a short re-sign-off.`,
            )
          }
          setWait(taskId, target.name, 'ci')
          return 'wait'
        case 'wait':
          if (
            mode === 'gate' &&
            step.on === 'review' &&
            ciState(target, pr, ci) === 'passed' &&
            pr.mergeable === 'MERGEABLE'
          ) {
            ready.push({ target, pr, noCi: !target.hasCi })
            break
          }
          setWait(taskId, target.name, step.on)
          if (step.on === 'required-check')
            await port.ciBlocked?.(taskId, target, pr, acceptedFailing(pr, ci))
          if (ciState(target, pr, ci) === 'pending') {
            waitingForCi.push({ target, pr })
          }
          if (step.autoMerge && mode === 'merge' && targets.length === 1)
            await enableAutoMerge(gh, task, target, pr)
          break
        case 'merge':
          ready.push({ target, pr, noCi: step.noCi })
          break
      }
    }
    await watchCi(task, waitingForCi)
    if (ready.length === 0 || ready.length !== open) {
      return open === 0 ? finishMerge(taskId) : 'wait'
    }
    if (mode === 'lead') return 'wait'
    if (mode === 'gate') {
      for (const { target } of ready) setWait(taskId, target.name, undefined)
      const kept = resolution.workflow.overnightKept
      if (kept && !store.overnightGateHistory(taskId, 'merge', visitStart(find(taskId))).kept)
        store.gateKeptOvernight(taskId, 'merge', kept.reason)
      await holding(find(taskId), () => postMergeGate(find(taskId), ready))
      return 'wait'
    }
    for (const { target, pr, noCi } of ready) {
      await port.beforeMerge?.(taskId)
      const fresh = await port.resolve(find(taskId))
      const now = mergeMode(store, find(taskId), fresh.workflow)
      if (now !== 'merge') return 'busy'
      const method = chooseMethod(target.method, pr.allowed)
      if (!method) {
        console.error(`GitHub allows no merge method on ${target.repo}`)
        setWait(taskId, target.name, 'merge')
        return 'wait'
      }
      try {
        await holding(find(taskId), async () => {
          await obligations(taskId)
          await mergePullRequest(gh, target, method, { auto: false })
        })
      } catch (error) {
        if (error instanceof RequestError && error.status === 409) throw error
        if (needsSignIn(error)) {
          setWait(taskId, target.name, 'sign-in')
          throw error
        }
        const reread = await port.read()
        const now = reread
          ? (() => {
              try {
                return remoteOf(taskId, [target], reread).get(target.name)
              } catch {
                return undefined
              }
            })()
          : undefined
        if (now?.state !== 'MERGED') {
          if (!mergeSplit(find(taskId))) throw error
          return mergeSendBack(
            taskId,
            `TED couldn’t merge ${target.repo}#${target.number}: ${redactSecrets(textOf(error))}`,
          )
        }
      }
      store.pullRequestMerged(taskId, target.name, {
        method,
        requested: target.method,
        noCi,
        byTed: true,
      })
      await removeMergedBranch(gh, target, pr)
    }
    return finishMerge(taskId)
  }

  return {
    cycle(
      taskId: string,
      read: PullRequestRead | undefined,
      { onlyMergedOutside = false }: { onlyMergedOutside?: boolean } = {},
    ): Promise<MergeCycle> {
      if (inFlight.has(taskId)) return Promise.resolve('busy')
      const cycle = Promise.resolve()
        .then(() => mergeCycle(taskId, read, onlyMergedOutside))
        .then(
          (next) => {
            if (next === 'done') held.delete(taskId)
            clearSignIn(taskId, read)
            return next
          },
          (error: unknown) => {
            if (!needsSignIn(error)) clearSignIn(taskId, read)
            throw error
          },
        )
      inFlight.set(taskId, cycle)
      return cycle.finally(() => inFlight.delete(taskId))
    },
    inFlight: (id: string) => inFlight.has(id),
    inFlightCount: () => inFlight.size,
    settled: (id: string) =>
      inFlight.get(id)?.then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve(),
    disableAutoMerge: turnOffAutoMerge,
  }
}

const needsSignIn = (error: unknown) =>
  error instanceof GhError && (error.kind === 'auth' || error.kind === 'missing')
const textOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const latest = (a: string, b: string) => (a > b ? a : b)

export function isCiStuck(comment: Comment): boolean {
  return comment.purpose?.kind === 'ci-stuck'
}

function conflictFindings(target: { repo: string; number: number; base: string }): string {
  return `${target.repo}#${target.number} conflicts with ${target.base}, so TED couldn’t rebase it. Rebase onto origin/${target.base} and resolve the conflicts; the Task then comes back through Validate for a short re-sign-off.`
}

export const sendToLeadChoice = 'Send to Task Lead'

export const keepWaitingChoice = 'Keep waiting'

export const mergeAnywayChoice = 'Merge anyway'

export function noCiAgainChoice(repoName: string): string {
  return `Merge, and don’t wait for CI on ${repoName} again`
}

export function noCiAgainRepo<R extends { name: string }>(
  repos: readonly R[],
  choice: string | undefined,
): R | undefined {
  return repos.find((r) => noCiAgainChoice(r.name) === choice)
}

function mergesWithoutCi(choice: string | undefined): boolean {
  return (
    choice === mergeAnywayChoice ||
    (choice !== undefined && /^Merge, and don’t wait for CI on .+ again$/.test(choice))
  )
}

export function mergeMode(
  store: TedStore,
  task: Task,
  workflow: ResolvedWorkflow,
): MergeMode | undefined {
  if (!mergesHere(task.stage) || task.archived) return undefined
  if (!workflow.stages.some(mergesHere)) return 'off'
  const since = mergeVisit(store, task)
  if (
    store.mergeHistory(task.id).canceledAt !== undefined ||
    store
      .listComments(task.id)
      .some(
        (c) =>
          c.gate &&
          mergesHere(c.stage ?? '') &&
          c.answer?.kind === 'changes-requested' &&
          c.answer.at >= since,
      )
  )
    return 'canceled'
  if (leadPending(store, task.id)) return 'lead'
  const kept = workflow.overnightKept
  if (kept?.unseen) return 'gate'
  if (
    !(
      workflow.settings.stages.merge?.gate === true ||
      (workflow.overnightGates?.some(mergesHere) === true && mergeGateRequested(store, task))
    )
  )
    return 'merge'
  if (kept === undefined && store.overnightGateHistory(task.id, task.stage, since).skipped)
    return 'merge'
  const approved = store
    .listComments(task.id)
    .some(
      (c) =>
        c.gate &&
        mergesHere(c.stage ?? '') &&
        c.answer?.kind === 'approved' &&
        c.createdAt >= since,
    )
  return approved ? 'merge' : 'gate'
}

export function startMerging(store: TedStore, task: Task, workflow: ResolvedWorkflow): void {
  if (store.mergeHistory(task.id).started) return
  if (workflow.overnightGates?.some(mergesHere) && !mergeGateRequested(store, task)) {
    store.gateSkippedOvernight(task.id, 'merge')
  }
  store.mergeStarted(task.id)
}

export function leadPending(store: TedStore, taskId: string): boolean {
  const { awaitsLead, leadAdvanced } = store.mergeHistory(taskId)
  if (!awaitsLead) return false
  if (leadAdvanced === undefined) return true
  if (leadAdvanced.by === 'human') return false
  return openMergeFailures(store, taskId).some((f) => f.createdAt > leadAdvanced.at)
}

const closedResolutions = ['accepted', 'fixed', 'no-longer-applicable']

export function openMergeFailures(store: TedStore, taskId: string) {
  const since = store.listStageEntries(taskId).findLast((e) => mergesHere(e.stage))?.at ?? ''
  return store.failures
    .list(taskId)
    .filter(
      (f) =>
        (f.source.kind === 'github-ci' || f.source.kind === 'post-rebase-check') &&
        f.createdAt >= since &&
        !f.verifications?.length &&
        !closedResolutions.includes(f.resolutions.at(-1)?.resolution ?? ''),
    )
}

function mergeVisit(store: TedStore, task: Task): string {
  return store.listStageEntries(task.id).findLast((e) => e.stage === task.stage)?.at ?? ''
}
function mergeGateRequested(store: TedStore, task: Task): boolean {
  const since = mergeVisit(store, task)
  return store
    .listComments(task.id)
    .some((c) => c.gate && c.stage === task.stage && c.createdAt >= since)
}
