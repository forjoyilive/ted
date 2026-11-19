import type { FailureCase, FailureChoice } from '@ted/protocol'
import { handsOff, mergesHere, validates } from '@ted/protocol/stage'

const validationOrder: readonly FailureChoice[] = ['retry', 'fix', 'accepted', 'repair']
const closing: readonly FailureChoice[] = ['fixed', 'no-longer-applicable']
const findingOrder: readonly FailureChoice[] = [
  'accepted',
  'repair',
  'fixed',
  'no-longer-applicable',
]

export function offeredFailureChoices(
  value: Pick<FailureCase, 'validation'>,
  stage: string,
  canAccept: boolean,
  closable: boolean,
): FailureChoice[] {
  const all = value.validation ? [...validationOrder, ...(closable ? closing : [])] : findingOrder
  return all.filter(
    (choice) =>
      (canAccept || choice !== 'accepted') &&
      (!value.validation || !handsOff(stage) || choice === 'accepted') &&
      (choice !== 'repair' || validates(stage) || mergesHere(stage)),
  )
}
