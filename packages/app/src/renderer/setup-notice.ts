import type { Factory, Task } from '@ted/protocol'
import { ted } from './ted.ts'

export type SetupNotice = { kind: 'open'; task: Task } | { kind: 'never' }

export const setupNoticeEvent = 'ted:setup-notice'

export interface SetupNoticeRequest {
  task: Task
  resolve: (start: boolean) => void
}

export function setupNotice(
  factory: Factory | undefined,
  tasks: readonly Task[],
  task?: Task,
): SetupNotice | undefined {
  if (!factory || factory.hasSettings || task?.setup) return undefined
  const mine = tasks.filter((t) => t.factoryId === factory.id)
  const setups = mine.filter((t) => t.setup)
  if (setups.length === 0 || setups.some((t) => t.merged)) return undefined
  const open = setups.find((t) => !t.archived && t.stage !== 'done')
  if (open) return { kind: 'open', task: open }
  const started = mine.some((t) => !t.setup && t.id !== task?.id && t.stage !== 'backlog')
  return started ? undefined : { kind: 'never' }
}

export function setupNoticeText(notice: SetupNotice): string {
  return notice.kind === 'open'
    ? 'Setup isn’t finished. This Task will use Ted’s defaults.'
    : 'This Factory hasn’t been set up. This Task will use Ted’s defaults.'
}

export function startTask(task: Task): Promise<Task | undefined> {
  return new Promise<boolean>((resolve) => {
    const event = new CustomEvent<SetupNoticeRequest>(setupNoticeEvent, {
      detail: { task, resolve },
      cancelable: true,
    })
    if (window.dispatchEvent(event)) resolve(true)
  }).then((start) => (start ? ted.startTask(task.id) : undefined))
}
