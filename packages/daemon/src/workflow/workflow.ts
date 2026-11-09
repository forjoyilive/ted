import { readFile } from 'node:fs/promises'
import type { StageId, Task } from '@ted/protocol'

export type AgentStageId = Exclude<StageId, 'backlog' | 'done'>

const order: AgentStageId[] = ['work']

const defaults = new URL('./defaults/', import.meta.url)

export function firstStage(): AgentStageId {
  return order[0] ?? 'work'
}

export function nextStage(current: StageId): StageId {
  if (current === 'backlog') return firstStage()
  if (current === 'done') return 'done'
  return order[order.indexOf(current) + 1] ?? 'done'
}

export async function taskLeadPrompt(task: Task, stage: AgentStageId): Promise<string> {
  const [preamble, stageFile] = await Promise.all([
    readFile(new URL('preamble.md', defaults), 'utf8'),
    readFile(new URL(`stages/${stage}.md`, defaults), 'utf8'),
  ])
  return [
    preamble.trim(),
    stageFile.trim(),
    `# Your Task: ${task.displayId}\n\n${task.title}`,
  ].join('\n\n')
}
