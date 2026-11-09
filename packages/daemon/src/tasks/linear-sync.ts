import { type LinearUrl, parseLinearUrl, type Task } from '@ted/protocol'
import {
  type Linear,
  type LinearIssueState,
  type LinearWorkflowState,
  linearIssueKey,
} from '../linear/linear.ts'
import { redactSecrets } from '../redact.ts'
import {
  type LinearStep,
  type LinearSyncRecord,
  linearSteps,
  type TedStore,
} from '../store/index.ts'
import { clean } from './github-activity.ts'

export type LinearSyncApi = Pick<Linear, 'issueStates' | 'teamStates' | 'moveIssue' | 'linkUrl'>

export interface LinearClosed {
  identifier: string
  state: string
  stateType: string
}

export interface LinearSync {
  close(): void
}

export interface LinearSyncOptions {
  store: TedStore
  linear: LinearSyncApi
  everyMs: number
  closed(taskId: string, issue: LinearClosed): Promise<void>
  settled(taskId: string, why: 'reopened' | 'done'): void
  inBackground(what: string, work: () => Promise<void>): void
}

interface Watched {
  task: Task
  link: LinearUrl
  merged: boolean
  record: LinearSyncRecord
}

const maxStateName = 80

export function isClosedType(type: string): boolean {
  return type === 'completed' || type === 'canceled'
}

const isReviewName = (name: string) => /\breview\b/i.test(name)

function rankOf(state: Pick<LinearWorkflowState, 'name' | 'type'>): number {
  if (isClosedType(state.type)) return 3
  if (state.type === 'started') return isReviewName(state.name) ? 2 : 1
  return 0
}

const stepRank = (step: LinearStep | undefined) =>
  step === undefined ? 0 : linearSteps.indexOf(step) + 1

export function pickState(
  states: readonly LinearWorkflowState[],
  step: LinearStep,
): LinearWorkflowState | undefined {
  const byPosition = [...states].sort((a, b) => a.position - b.position)
  const prefer = (list: LinearWorkflowState[], name: RegExp) =>
    list.find((s) => name.test(s.name)) ?? list[0]
  if (step === 'done') {
    return prefer(
      byPosition.filter((s) => s.type === 'completed'),
      /^done$/i,
    )
  }
  const started = byPosition.filter((s) => s.type === 'started')
  if (step === 'review') {
    return prefer(
      started.filter((s) => isReviewName(s.name)),
      /^in review$/i,
    )
  }
  return prefer(
    started.filter((s) => !isReviewName(s.name)),
    /^in progress$/i,
  )
}

function targetStep(task: Task, merged: boolean): LinearStep | undefined {
  if (merged) return 'done'
  if (task.archived || task.stage === 'done') return undefined
  if (task.stage === 'merge') return 'review'
  if (task.stage !== 'backlog') return 'started'
  return undefined
}

function pullRequestLinks(task: Task): { url: string; title: string }[] {
  return task.repos.flatMap((repo) => {
    const pr = repo.pullRequest
    return pr && !repo.removed ? [{ url: pr.url, title: `${repo.repo}#${pr.number}` }] : []
  })
}

export function createLinearSync(options: LinearSyncOptions): LinearSync {
  const { store, linear } = options
  let timer: NodeJS.Timeout | undefined
  let closed = false

  function schedule(): void {
    if (closed) return
    timer = setTimeout(() => {
      options.inBackground('sync Tasks with Linear', () => cycle().finally(schedule))
    }, options.everyMs)
    timer.unref()
  }

  function watched(): Watched[] {
    return store.listTasks().flatMap((task): Watched[] => {
      const link = task.source && parseLinearUrl(task.source.url)
      if (!link) return []
      const merged = store.isMerged(task.id)
      const record = store.linearSync(task.id)
      if (merged) {
        const linked = pullRequestLinks(task).every((l) => record.linked.has(l.url))
        return record.step === 'done' && linked ? [] : [{ task, link, merged, record }]
      }
      if (task.archived || task.stage === 'done') return []
      return [{ task, link, merged, record }]
    })
  }

  async function cycle(): Promise<void> {
    if (closed || !store.settings().linearSync) return
    const list = watched()
    if (list.length === 0) return
    const issues = await linear.issueStates(list.map((w) => w.link))
    if (!issues) return
    for (const item of list) {
      if (closed) return
      const issue = issues.get(linearIssueKey(item.link.workspace, item.link.identifier))
      if (!issue) continue
      await syncOne(item, issue).catch((error: unknown) =>
        console.error(
          redactSecrets(`couldn’t sync ${item.task.displayId} with Linear: ${String(error)}`),
        ),
      )
    }
  }

  async function syncOne({ task, link, merged, record }: Watched, issue: LinearIssueState) {
    const identifier = link.identifier
    const state = clean(issue.state.name, maxStateName)
    const stateType = issue.state.type
    const before = record.seen
    const team = issue.teamKey
    if (before?.stateType !== stateType || before.state !== state || before.team !== team) {
      store.linearIssueSeen(task.id, identifier, { stateType, state, team })
    }
    if (store.getTask(task.id)?.linearSync !== 'on') return
    const open = !task.archived && task.stage !== 'done'
    const issueClosed = open && isClosedType(stateType)
    if (issueClosed && before !== undefined && !isClosedType(before.stateType)) {
      await options.closed(task.id, { identifier, state, stateType })
    }
    if (!open) options.settled(task.id, 'done')
    else if (!issueClosed && before !== undefined && isClosedType(before.stateType)) {
      options.settled(task.id, 'reopened')
    }
    if (!merged && store.getTask(task.id)?.archived) return
    const target = issueClosed ? undefined : targetStep(task, merged)
    if (target && stepRank(target) > stepRank(record.step)) {
      let moved: string | undefined
      if (rankOf(issue.state) < stepRank(target)) {
        const next = pickState(await linear.teamStates(issue.teamId), target)
        if (next) {
          await linear.moveIssue(issue.id, next.id)
          moved = clean(next.name, maxStateName)
        }
      }
      store.linearIssueMoved(task.id, identifier, target, moved)
    }
    const fresh = pullRequestLinks(task).filter((l) => !record.linked.has(l.url))
    const linked: string[] = []
    try {
      for (const { url, title } of fresh) {
        await linear.linkUrl(issue.id, url, title)
        linked.push(url)
      }
    } finally {
      if (linked.length > 0) store.linearPullRequestsLinked(task.id, identifier, linked)
    }
  }

  schedule()

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
    },
  }
}
