import type { AgentStageId } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'

export function checkPreparationWorkflow(workflow: ResolvedWorkflow): void {
  const work = workflow.order.indexOf('work')
  if (
    !workflow.stages.includes('work') ||
    work < 0 ||
    ['clarify', 'design'].some(
      (stage) =>
        workflow.stages.includes(stage as AgentStageId) &&
        workflow.order.indexOf(stage as AgentStageId) > work,
    )
  )
    throw new RequestError(
      409,
      'Prepare through Design needs Work enabled after Clarify and Design',
    )
}
