import type { ClarifyDepth, StageId } from '@ted/protocol'
import type { GitHubNotice } from '../tasks/github-activity.ts'
import type { LoggedEvent } from './index.ts'
import { isRunStarted } from './interval-schema.ts'

export interface MergeHistory {
  started: boolean
  canceledAt?: string
  latest?: 'started' | 'canceled'
}

export interface FailureHistory {
  at: string
  runId: string
  reason: string
  recovery: 'resume' | 'fresh' | 'failed'
  resumeFailed: boolean
}

export type FreshRunRequest = { pending: boolean } & (
  | { kind: 'resumed' }
  | { kind: 'overnight' }
  | { kind: 'planning' }
  | { kind: 'blockers' }
  | { kind: 'retried' }
  | { kind: 'unarchived' }
  | { kind: 'failure'; failure: FailureHistory }
  | { kind: 'github'; notices: GitHubNotice[] }
)

const asksForFreshRun = (entry: LoggedEvent): boolean =>
  entry.name === 'v1.TaskResumed' ||
  entry.name === 'v1.TaskResumedOvernight' ||
  entry.name === 'v1.TaskStartedAfterPlanning' ||
  entry.name === 'v1.TaskRequeuedAfterBlockers' ||
  entry.name === 'v1.TaskRetried' ||
  entry.name === 'v1.GitHubActivityQueued' ||
  (entry.name === 'v1.TaskUnarchived' && entry.data.queued === true) ||
  (entry.name === 'v1.TaskLeadFailed' && entry.data.recovery === 'fresh')

const failureOf = (entry: LoggedEvent): FailureHistory => ({
  at: entry.at,
  runId: String(entry.data.runId),
  reason: typeof entry.data.reason === 'string' ? entry.data.reason : 'exited',
  recovery: entry.data.recovery as FailureHistory['recovery'],
  resumeFailed: entry.data.resumeFailed === true,
})

export function createTaskHistory(
  read: (taskId: string) => LoggedEvent[],
  mergeVisit: (taskId: string) => string,
) {
  return {
    mergeHistory(taskId: string): MergeHistory {
      const since = mergeVisit(taskId)
      const actions = read(taskId).filter(
        (e) => (e.name === 'v1.MergeStarted' || e.name === 'v1.MergeCanceled') && e.at >= since,
      )
      const last = actions.at(-1)
      const canceledAt = actions
        .filter((e) => e.name === 'v1.MergeCanceled')
        .reduce<string | undefined>(
          (latest, e) => (latest === undefined || e.at > latest ? e.at : latest),
          undefined,
        )
      return {
        started: actions.some((e) => e.name === 'v1.MergeStarted'),
        ...(canceledAt !== undefined && { canceledAt }),
        ...(last && { latest: last.name === 'v1.MergeStarted' ? 'started' : 'canceled' }),
      }
    },
    approvalsBoundToCommit(taskId: string, commit: string): string[] {
      return read(taskId)
        .filter((e) => e.name === 'v1.GateApprovalBound' && e.data.commit === commit)
        .map((e) => String(e.data.commentId))
    },
    gateRequestCommit(taskId: string, commentId: string): string | undefined {
      return read(taskId).find(
        (e) => e.name === 'v1.GateRequestedFor' && e.data.commentId === commentId,
      )?.data.commit as string | undefined
    },
    overnightGateHistory(
      taskId: string,
      stage: StageId,
      since: string,
    ): { kept: boolean; skipped: boolean } {
      const entries = read(taskId).filter((e) => e.data.stage === stage && e.at >= since)
      return {
        kept: entries.some((e) => e.name === 'v1.GateKeptOvernight'),
        skipped: entries.some((e) => e.name === 'v1.GateSkippedOvernight'),
      }
    },
    latestRebase(taskId: string, since: string): string | undefined {
      return read(taskId).findLast((e) => e.name === 'v1.TaskBranchRebased' && e.at >= since)?.at
    },
    signedOffCommit(taskId: string, repo: string, since: string): string | undefined {
      return read(taskId).find(
        (e) =>
          e.name === 'v1.PullRequestSignedOff' &&
          e.at >= since &&
          e.data.name === repo &&
          typeof e.data.commit === 'string',
      )?.data.commit as string | undefined
    },
    editedSince(taskId: string, since: string): boolean {
      return read(taskId).some((e) => e.name === 'v1.TaskEdited' && e.at >= since)
    },
    humanClarifyDepth(taskId: string): ClarifyDepth | undefined {
      const set = read(taskId).findLast(
        (e) =>
          (e.name === 'v1.ClarifyDepthSet' && e.data.by === 'human') ||
          e.name === 'v2.TaskCreated' ||
          e.name === 'v1.TaskReset',
      )
      const depth = (set?.data.depth ?? set?.data.clarifyDepth) as ClarifyDepth | undefined
      return depth === 'auto' ? undefined : depth
    },
    freshRunRequest(taskId: string): FreshRunRequest | undefined {
      const log = read(taskId)
      const asked = log.findLastIndex(asksForFreshRun)
      const last = log[asked]
      if (!last) return undefined
      const pending = asked > log.findLastIndex((e) => isRunStarted(e.name))
      switch (last.name) {
        case 'v1.TaskResumedOvernight':
          return { kind: 'overnight', pending }
        case 'v1.TaskResumed':
          return { kind: 'resumed', pending }
        case 'v1.TaskStartedAfterPlanning':
          return { kind: 'planning', pending }
        case 'v1.TaskRetried':
          return { kind: 'retried', pending }
        case 'v1.TaskUnarchived':
          return { kind: 'unarchived', pending }
        case 'v1.TaskLeadFailed':
          return { kind: 'failure', failure: failureOf(last), pending }
        case 'v1.GitHubActivityQueued':
          return {
            kind: 'github',
            pending,
            notices: Array.isArray(last.data.notices) ? (last.data.notices as GitHubNotice[]) : [],
          }
        default:
          return { kind: 'blockers', pending }
      }
    },
    heldBeforeWork(taskId: string): boolean {
      const log = read(taskId)
      const held = log.findLastIndex(
        (e) => e.name === 'v1.TaskPreparationChanged' && e.data.state === 'ready',
      )
      return (
        held >= 0 &&
        !log
          .slice(held + 1)
          .some((e) => isRunStarted(e.name) && typeof e.data.parentRunId !== 'string')
      )
    },
    failureHistory(
      taskId: string,
      now: number,
    ): { recent: FailureHistory[]; sinceFirst: FailureHistory[] } {
      const log = read(taskId)
      const reset = log.findLastIndex(
        (e) =>
          e.name === 'v1.TaskRetried' ||
          e.name === 'v1.TaskResumed' ||
          e.name === 'v1.TaskResumedOvernight',
      )
      const recent = log
        .slice(reset + 1)
        .filter(
          (e) =>
            e.name === 'v1.TaskLeadFailed' &&
            e.data.resumeFailed !== true &&
            now - Date.parse(e.at) < 30 * 60_000,
        )
      const first = recent[0]
      return {
        recent: recent.map(failureOf),
        sinceFirst: first
          ? log
              .slice(log.indexOf(first))
              .filter((e) => e.name === 'v1.TaskLeadFailed')
              .map(failureOf)
          : [],
      }
    },
    alreadyFailed(taskId: string, runId: string, since: string): boolean {
      return read(taskId).some(
        (e) => e.name === 'v1.TaskLeadFailed' && e.data.runId === runId && e.at >= since,
      )
    },
    latestLeadFailure(taskId: string): FailureHistory | undefined {
      const last = read(taskId).findLast((e) => e.name === 'v1.TaskLeadFailed')
      return last && failureOf(last)
    },
    latestNudge(taskId: string, runId: string): string | undefined {
      return read(taskId).findLast((e) => e.name === 'v1.TaskLeadNudged' && e.data.runId === runId)
        ?.at
    },
  }
}

export type TaskHistory = ReturnType<typeof createTaskHistory>
