import { readFile } from 'node:fs/promises'
import type { AgentStageId, Task } from '@ted/protocol'
import type { ResolvedWorkflow } from './resolve.ts'

const defaults = new URL('./defaults/', import.meta.url)

export function stageTitle(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

function stageFileText(workflow: ResolvedWorkflow, stage: AgentStageId): string {
  const file = workflow.stageFile(stage)
  if (!file) throw new Error(`no Stage file for ${stage}`)
  return file.text.trim()
}

export async function taskLeadPrompt(
  task: Task,
  workflow: ResolvedWorkflow,
  stage: AgentStageId,
  setupReport?: string,
): Promise<string> {
  const preamble = await readFile(new URL('preamble.md', defaults), 'utf8')
  return [
    ...(setupReport !== undefined ? [setupReport] : []),
    preamble.trim(),
    stageFileText(workflow, stage),
    ...(workflow.notes?.trim() ? [`# Factory notes\n\n${workflow.notes.trim()}`] : []),
    `# Your Task: ${task.displayId}\n\n${task.title}`,
  ].join('\n\n')
}

export function nextStageMessage(workflow: ResolvedWorkflow, stage: AgentStageId): string {
  return [
    `TED moved this Task to ${stageTitle(stage)}. These are your instructions for this Stage.`,
    stageFileText(workflow, stage),
  ].join('\n\n')
}
