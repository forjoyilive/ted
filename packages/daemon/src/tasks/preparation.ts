import { stageWith } from '@ted/protocol/stage'
import { RequestError } from '../errors.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'

export function checkPreparationWorkflow(workflow: ResolvedWorkflow): void {
  const work = workflow.order.indexOf(stageWith('handOff'))
  if (
    !workflow.stages.includes(stageWith('handOff')) ||
    work < 0 ||
    [stageWith('clarifyRounds'), stageWith('designReview')].some(
      (stage) => workflow.stages.includes(stage) && workflow.order.indexOf(stage) > work,
    )
  )
    throw new RequestError(
      409,
      'Prepare through Design needs Work enabled after Clarify and Design',
    )
}
