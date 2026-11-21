import {
  isObject,
  isOneOf,
  isString,
  type JsonObject,
  parseJson,
  reader,
  type Untyped,
} from './parse.ts'
import type { StageId } from './stage.ts'
import type { Task } from './task.ts'
import { RequestValidationError as HttpError } from './validation.ts'

export type MoveRefusal = 'archived' | 'done' | 'merged' | 'setup'

export const moveRefusals: Record<MoveRefusal, string> = {
  archived: 'is archived',
  done: 'is Done',
  merged: 'has a merged pull request',
  setup: 'is its Factory’s setup Task',
}

export function moveRefusal(
  task: Pick<Task, 'archived' | 'stage' | 'statuses' | 'merged' | 'repos' | 'setup'>,
): MoveRefusal | undefined {
  if (task.archived) return 'archived'
  if (task.stage === 'done') return 'done'
  if (
    task.merged ||
    task.statuses.includes('partly-merged') ||
    task.repos.some((r) => r.pullRequest?.state === 'merged')
  ) {
    return 'merged'
  }
  if (task.setup) return 'setup'
  return undefined
}

export interface MoveToFactoryRequest {
  factoryId: string
  planKey?: string
}

const maxPlanKey = 200_000

const read = reader((message) => {
  throw new HttpError(400, message)
})

export function parseMoveToFactoryRequest(value: Untyped): MoveToFactoryRequest {
  const body = read.object(value, 'move request')
  const factoryId = read.string(body, 'factoryId', 'factoryId must be a Factory ID').trim()
  if (factoryId === '') throw new HttpError(400, 'factoryId must be a Factory ID')
  const planKey = read.optional(body, 'planKey', (object, field) =>
    read.string(object, field, 'planKey must be text'),
  )
  if (planKey !== undefined && (planKey === '' || planKey.length > maxPlanKey))
    throw new HttpError(400, 'planKey must be the key of a move plan')
  return { factoryId, ...(planKey !== undefined && { planKey }) }
}

export interface TaskMoveRef {
  id: string
  displayId: string
  title: string
}

export interface TaskMoveUnlink extends TaskMoveRef {
  blocks: boolean
}

export interface TaskMovePullRequest {
  repo: string
  number: number
}

export interface TaskMovePlanTask extends TaskMoveRef {
  newDisplayId: string
  stage: StageId
  lands: StageId
  startsLead: boolean
  worktrees: number
  branches: string[]
  pullRequests: TaskMovePullRequest[]
  openRequests: number
  unlinked: TaskMoveUnlink[]
  trackerSync?: string
}

export interface TaskMovePlan {
  factoryId: string
  factoryName: string
  repos: string[]
  tasks: TaskMovePlanTask[]
  leavesParent?: TaskMoveRef
  refusal?: string
}

export interface TaskMoved {
  task: Task
  moved: { id: string; from: string; to: string }[]
}

export function movePlanKey(plan: TaskMovePlan): string {
  const sorted = (list: readonly string[]) => [...list].sort()
  return JSON.stringify({
    factoryId: plan.factoryId,
    repos: plan.repos,
    leavesParent: plan.leavesParent?.id ?? null,
    tasks: plan.tasks.map((t) => [
      t.id,
      t.stage,
      t.lands,
      t.startsLead,
      t.worktrees,
      sorted(t.branches),
      sorted(t.pullRequests.map((p) => `${p.repo}#${p.number}`)),
      t.openRequests,
      sorted(t.unlinked.map((u) => `${u.id}:${u.blocks}`)),
    ]),
  })
}

export const moveChoice = 'Move'
export const keepMoveChoice = 'Keep it'

export const moveAskers = ['task-lead', 'coordinator'] as const

export type MoveAsker = (typeof moveAskers)[number]

export interface MoveAsk {
  factoryId: string
  reason: string
  askedBy: MoveAsker
  chatId?: string
}

export interface RequestMoveRequest {
  factory: string
  reason: string
}

export interface MoveAnswer {
  factoryId: string
  planKey: string
}

export interface OtherFactory {
  id: string
  key: string
  name: string
  repos?: string
}

export const maxMoveReason = 300

export function readMoveReason(object: JsonObject, field: string): string {
  const line = read.string(object, field, `${field} must be text`).replace(/\s+/g, ' ').trim()
  if (line === '') throw new HttpError(400, `give a ${field}`)
  if (line.length > maxMoveReason)
    throw new HttpError(400, `the ${field} must be at most ${maxMoveReason} characters`)
  return line
}

export function parseRequestMoveRequest(value: Untyped): RequestMoveRequest {
  const body = read.object(value, 'move request')
  const factory = read.string(body, 'factory', 'factory must be a Factory key or ID').trim()
  if (factory === '') throw new HttpError(400, 'factory must be a Factory key or ID')
  return { factory, reason: readMoveReason(body, 'reason') }
}

export function parseMoveAnswer(value: Untyped): MoveAnswer {
  const body = read.object(value, 'move')
  const factoryId = read.string(body, 'factoryId', 'move.factoryId must be a Factory ID').trim()
  if (factoryId === '') throw new HttpError(400, 'move.factoryId must be a Factory ID')
  const planKey = read.string(body, 'planKey', 'move.planKey must be the key of a move plan')
  if (planKey === '' || planKey.length > maxPlanKey)
    throw new HttpError(400, 'move.planKey must be the key of a move plan')
  return { factoryId, planKey }
}

export function readMoveAsk(text: string): MoveAsk | undefined {
  const value = parseJson(text)
  if (!isObject(value)) return undefined
  const { factoryId, reason, askedBy, chatId } = value
  if (!isString(factoryId) || !isString(reason) || !isOneOf(askedBy, moveAskers)) return undefined
  return { factoryId, reason, askedBy, ...(isString(chatId) && { chatId }) }
}

export interface MovePlanRow extends TaskMoveRef {
  note: string
}

export interface MovePlanView {
  root: TaskMovePlanTask
  landing: { before: string; newDisplayId: string; after: string }
  movesWith: MovePlanRow[]
  leavesParent?: string
  unlinked: MovePlanRow[]
  changesHeading: 'What is lost' | 'What changes'
  changes: string[]
  throwsAwayWork: boolean
}

export const movePlanKept =
  'Kept: the title, description and its edits, comments, questions and answers, attachments, the Task brief, priority, source link, Task Lead field and Autopilot choice.'

function joinAnd(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

const started = (task: TaskMovePlanTask) => task.startsLead || task.worktrees > 0

export function throwsAwayWork(plan: TaskMovePlan): boolean {
  return plan.tasks.some(started)
}

export function movePlanView(
  plan: TaskMovePlan,
  stageName: (stage: StageId) => string,
): MovePlanView | undefined {
  const [root, ...others] = plan.tasks
  if (!root) return undefined
  const id = root.displayId
  const lands = stageName(root.lands)
  const landing = {
    before: `${id} becomes `,
    newDisplayId: root.newDisplayId,
    after: root.startsLead
      ? ` in ${lands}. A new Task Lead starts there at once, with a copy of the conversation so far.`
      : ` in ${lands}. Nothing starts until you start it.`,
  }
  const movesWith = others.map((t) => ({
    id: t.id,
    displayId: t.displayId,
    title: t.title,
    note: t.startsLead ? `to ${stageName(t.lands)}` : `stays in ${stageName('backlog')}`,
  }))
  const unlinked = plan.tasks.flatMap((t) =>
    t.unlinked.map((u) => ({
      ...u,
      note: u.blocks ? `blocks ${t.displayId}` : `blocked by ${t.displayId}`,
    })),
  )
  const parent = plan.leavesParent?.displayId
  const changes: string[] = []
  if (root.worktrees > 0) {
    changes.push(
      root.worktrees === 1
        ? 'The worktree and any uncommitted work in it'
        : 'The worktrees and any uncommitted work in them',
    )
  }
  if (root.startsLead && root.branches.length > 0) {
    changes.push(
      root.branches.length === 1
        ? `The branch ${root.branches[0]} and its commits, here and on GitHub`
        : `The branches ${joinAnd(root.branches)} and their commits, here and on GitHub`,
    )
  }
  const startedOthers = others.filter(started).map((t) => t.displayId)
  if (startedOthers.length > 0) {
    changes.push(
      `The same for ${joinAnd(startedOthers)}, which ${startedOthers.length === 1 ? 'moves' : 'move'} with it`,
    )
  }
  const prs = plan.tasks.flatMap((t) => t.pullRequests.map((p) => `${p.repo} #${p.number}`))
  if (prs.length > 0) {
    changes.push(
      `${prs.length === 1 ? 'Pull request' : 'Pull requests'} ${joinAnd(prs)}, which Ted closes on GitHub`,
    )
  }
  const requests = plan.tasks.reduce((n, t) => n + t.openRequests, 0)
  if (requests > 0) {
    changes.push(
      requests === root.openRequests
        ? requests === 1
          ? 'Its open request is withdrawn from your Inbox'
          : `Its ${requests} open requests are withdrawn from your Inbox`
        : `${requests} open requests are withdrawn from your Inbox`,
    )
  }
  changes.push(
    plan.repos.length > 0
      ? `Repos becomes ${plan.factoryName}’s: ${plan.repos.join(', ')}`
      : `Repos becomes ${plan.factoryName}’s, which has none yet`,
  )
  for (const tracker of new Set(plan.tasks.flatMap((t) => t.trackerSync ?? []))) {
    changes.push(`Sync with ${tracker} asks for your permission again`)
  }
  const work = throwsAwayWork(plan)
  return {
    root,
    landing,
    movesWith,
    ...(parent !== undefined && {
      leavesParent: `${id} is a child of ${parent}. It leaves ${parent}, which stops waiting for it. Ted notes this on both Tasks.`,
    }),
    unlinked,
    changesHeading: work ? 'What is lost' : 'What changes',
    changes,
    throwsAwayWork: work,
  }
}
