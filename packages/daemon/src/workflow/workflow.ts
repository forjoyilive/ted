import { readFile } from 'node:fs/promises'
import type { AgentStageId, Attachment, Task } from '@ted/protocol'
import type { ResolvedWorkflow } from './resolve.ts'

const defaults = new URL('./defaults/', import.meta.url)

const depthNames: Record<Task['clarifyDepth'], string> = {
  auto: 'Auto',
  none: 'None',
  few: 'Few',
  grilling: 'Grilling',
}

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
  attachmentFile?: (attachment: Attachment) => string,
  setupReport?: string,
): Promise<string> {
  const preamble = await readFile(new URL('preamble.md', defaults), 'utf8')
  return [
    ...(setupReport !== undefined ? [setupReport] : []),
    preamble.trim(),
    stageFileText(workflow, stage),
    ...(workflow.notes?.trim() ? [`# Factory notes\n\n${workflow.notes.trim()}`] : []),
    `# Your Task: ${task.displayId}\n\n${task.title}`,
    ...(task.description !== '' ? [task.description] : []),
    ...(task.source ? [sourceContext(task.source)] : []),
    ...(task.clarifyDepth !== 'auto'
      ? [
          `Clarify depth: ${depthNames[task.clarifyDepth]}. The human chose it; use it at Clarify instead of picking one.`,
        ]
      : []),
    ...(attachmentFile && task.attachments.length > 0
      ? [
          `Attached files:\n${task.attachments
            .map((a) => `- ${a.name}: ${attachmentFile(a)}`)
            .join('\n')}`,
        ]
      : []),
  ].join('\n\n')
}

export function nextStageMessage(workflow: ResolvedWorkflow, stage: AgentStageId): string {
  return [
    `TED moved this Task to ${stageTitle(stage)}. These are your instructions for this Stage.`,
    stageFileText(workflow, stage),
  ].join('\n\n')
}

function sourceContext(source: NonNullable<Task['source']>): string {
  const { linear } = source
  if (!linear) return `Source: ${source.url}`
  return [
    `From Linear ${linear.identifier}: ${linear.title} (${source.url}). The issue’s description, as context:`,
    linear.description?.trim() || '(no description)',
  ].join('\n\n')
}
