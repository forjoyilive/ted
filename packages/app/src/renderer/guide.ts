import type { Comment, Factory, FactoryGuide, Task } from '@ted/protocol'

export type GuideButton =
  | { label: string; open: 'task' }
  | { label: string; open: 'request'; requestId: string }
  | { label: string; open: 'new-task' }

export interface GuideCardView {
  factoryId: string
  factoryName: string
  taskId?: string
  text: string
  button?: GuideButton
}

const openTask: GuideButton = { label: 'Open the Task', open: 'task' }

export function shownGuide(
  guides: readonly FactoryGuide[],
  factories: readonly Factory[],
): { factory: Factory; guide: FactoryGuide } | undefined {
  const live = [...guides].sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  for (const guide of live) {
    const factory = factories.find((f) => f.id === guide.factoryId)
    if (factory) return { factory, guide }
  }
  return undefined
}

export function setupTaskOf(factoryId: string, tasks: readonly Task[]): Task | undefined {
  return tasks
    .filter((task) => task.factoryId === factoryId && task.setup && !task.archived)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
}

export function guideCard(
  { factory, guide }: { factory: Factory; guide: FactoryGuide },
  task: Task | undefined,
  requests: readonly Comment[],
): GuideCardView {
  const card = (text: string, button?: GuideButton): GuideCardView => ({
    factoryId: factory.id,
    factoryName: factory.name,
    ...(task && { taskId: task.id }),
    text,
    ...(button && { button }),
  })
  if (!factory.cloned || task === undefined) {
    return factory.setup?.some((repo) => repo.state === 'failed')
      ? card('TED couldn’t clone your repos. See the Banner at the top.')
      : card('TED is cloning your repos.')
  }
  if (guide.setUp) {
    return card('Your Factory is set up. Create your first Task.', {
      label: 'New Task…',
      open: 'new-task',
    })
  }
  if (task.status?.kind === 'failed') {
    return card('Setup failed. Open the Task to see what went wrong.', openTask)
  }
  const open = requests.filter((r) => r.taskId === task.id && r.kind !== 'note' && !r.answer)
  const round = open.find((r) => r.kind === 'round')
  if (round) {
    return card('The Task Lead has questions for you.', {
      label: 'Open questions',
      open: 'request',
      requestId: round.id,
    })
  }
  const signOff = (stage: Task['stage']) =>
    open.find((r) => r.stage === stage && (r.kind === 'review' || r.kind === 'signoff'))
  const proposal = signOff('design')
  if (proposal) {
    return card('Review the proposed setup.', {
      label: 'Open the proposal',
      open: 'request',
      requestId: proposal.id,
    })
  }
  const approval = signOff('review')
  if (approval) {
    return card('Approve the settings to merge them.', {
      label: 'Open the Sign-Off',
      open: 'request',
      requestId: approval.id,
    })
  }
  const other = open[0]
  if (other) {
    return card('The Task Lead needs you.', {
      label: 'Open the request',
      open: 'request',
      requestId: other.id,
    })
  }
  if (task.status?.kind === 'stopped') {
    return card('Setup is stopped. Open the Task to start it again.', openTask)
  }
  if (task.stage === 'merge') return card('TED is merging the pull request.')
  if (task.stage === 'design')
    return card('The Task Lead is trying your Checks and Apps.', openTask)
  if (task.stage === 'work' || task.stage === 'validate' || task.stage === 'review') {
    return card('The Task Lead is writing the settings and checking them.', openTask)
  }
  return card('The Task Lead is reading your repos. It will ask how you work.', openTask)
}
