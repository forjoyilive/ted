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
  const gate =
    workflow.settings.stages[stage]?.gate === true
      ? [
          `${stageTitle(stage)} has a Gate. When its work is done, write the Task brief with \`ted brief write\`, then run \`ted outcome advance\`. TED posts your brief to the human as a request and sends you their answer.`,
        ]
      : []
  return [file.text.trim(), ...gate].join('\n\n')
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

export function backStageMessage(
  workflow: ResolvedWorkflow,
  stage: AgentStageId,
  from: AgentStageId,
  findings: string,
): string {
  return [
    `TED moved this Task back to ${stageTitle(stage)}. These are your instructions for this Stage.`,
    stageFileText(workflow, stage),
    `# Findings from ${stageTitle(from)}\n\n${findings.trim()}`,
  ].join('\n\n')
}
