import type { FailureCase, FailureChoice } from '@ted/protocol'
import { handsOff } from '@ted/protocol/stage'

export function offeredChoice(
  value: Pick<FailureCase, 'validation'>,
  stage = 'validate',
): FailureChoice {
  if (!value.validation) return 'fixed'
  return handsOff(stage) ? 'accepted' : 'retry'
}
