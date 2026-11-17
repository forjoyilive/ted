import type { StageId, TaskMovePlan, TaskMovePlanTask, TaskMoveRef } from '@ted/protocol'

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
  'Kept: the title, description and its edits, Comments, questions and answers, attachments, the Task brief, priority, source link, Task Lead field and Autopilot choice.'

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
