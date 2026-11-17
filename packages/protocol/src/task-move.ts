import { reader, type Untyped } from './parse.ts'
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
