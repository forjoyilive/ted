import { expect, test } from 'vitest'
import {
  builtInStageOrder,
  clarifyIsOver,
  compareStages,
  isPast,
  type StageTrait,
  stagePhase,
  stageTraits,
  stageWith,
} from '../src/stage.ts'

const traitStages: Record<StageTrait, string[]> = {
  entry: ['intake'],
  clarifyRounds: ['clarify'],
  skippable: ['clarify', 'design'],
  designReview: ['design'],
  setupGate: ['design', 'review'],
  handOff: ['work'],
  validates: ['validate'],
  signsOffCode: ['review'],
  bindsApproval: ['review', 'merge'],
  merges: ['merge'],
  cleanup: ['cleanup'],
}

test('each built-in Stage has exactly its own special work', () => {
  for (const [trait, stages] of Object.entries(traitStages)) {
    expect(builtInStageOrder.filter((id) => stageTraits(id)[trait as StageTrait])).toEqual(stages)
  }
  expect(builtInStageOrder.filter((id) => stageTraits(id).holding)).toEqual(['backlog', 'done'])
  expect(builtInStageOrder.filter((id) => !stageTraits(id).working)).toEqual(['backlog', 'done'])
})

test('stageWith names the first built-in Stage with a trait', () => {
  expect(stageWith('handOff')).toBe('work')
  expect(stageWith('validates')).toBe('validate')
  expect(stageWith('merges')).toBe('merge')
  expect(stageWith('clarifyRounds')).toBe('clarify')
  expect(stageWith('cleanup')).toBe('cleanup')
  expect(stageWith('entry')).toBe('intake')
  expect(stageWith('signsOffCode')).toBe('review')
})

test('an unknown Stage is an ordinary working Stage with no special work', () => {
  for (const id of ['qa', 'constructor', 'toString', '__proto__', '']) {
    expect(stageTraits(id)).toEqual({
      holding: false,
      working: true,
      entry: false,
      clarifyRounds: false,
      skippable: false,
      designReview: false,
      setupGate: false,
      handOff: false,
      validates: false,
      signsOffCode: false,
      bindsApproval: false,
      merges: false,
      cleanup: false,
    })
  }
})

test('built-in Stages sit in their fixed order relative to Work', () => {
  expect(builtInStageOrder.map((id) => stagePhase(id))).toEqual([
    'before',
    'before',
    'before',
    'before',
    'at',
    'after',
    'after',
    'after',
    'after',
    'after',
  ])
  expect(builtInStageOrder.filter((id) => clarifyIsOver(id))).toEqual([
    'design',
    'work',
    'validate',
    'review',
    'merge',
    'cleanup',
    'done',
  ])
  const shuffled = ['merge', 'work', 'intake']
  expect(stagePhase('merge', shuffled)).toBe('after')
  expect(stagePhase('intake', shuffled)).toBe('before')
})

test('an unknown Stage sits after the built-in Stage before it in the order', () => {
  const order = ['intake', 'qa', 'work', 'docs', 'polish', 'merge']
  expect(stagePhase('qa', order)).toBe('before')
  expect(stagePhase('docs', order)).toBe('after')
  expect(isPast('qa', 'intake', order)).toBe(true)
  expect(isPast('clarify', 'qa', order)).toBe(true)
  expect(isPast('docs', 'work', order)).toBe(true)
  expect(isPast('validate', 'docs', order)).toBe(true)
  expect(compareStages('docs', 'polish', order)).toBeLessThan(0)
  expect(stagePhase('first', ['first', 'work'])).toBe('before')
  expect(isPast('first', 'backlog', ['first', 'work'])).toBe(true)
  expect(isPast('intake', 'first', ['first', 'work'])).toBe(true)
})

test('an unknown Stage outside the order counts as before Work', () => {
  expect(stagePhase('qa')).toBe('before')
  expect(stagePhase('qa', ['intake', 'work'])).toBe('before')
  expect(clarifyIsOver('qa')).toBe(true)
  expect(isPast('work', 'qa')).toBe(true)
})
