import { expect, test } from 'vitest'
import {
  builtInStageOrder,
  clarifyIsOver,
  compareStages,
  isCustomStageId,
  isPast,
  isStageId,
  type StageTrait,
  settingsStageOrder,
  stageDisplayName,
  stageEnabled,
  stageFileId,
  stagePhase,
  stageTraits,
  stageWith,
} from '../src/stage.ts'
import { mergeStageLists, stageNameIn } from '../src/stage-list.ts'
import type { BoardStage } from '../src/workflow.ts'

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

test('a custom Stage id is lowercase letters, digits and hyphens, up to 40 characters, and not built in', () => {
  for (const id of ['security', 'release-notes', 'qa2', 'a'.repeat(40)]) {
    expect(isCustomStageId(id)).toBe(true)
  }
  for (const id of [
    'work',
    'done',
    'backlog',
    'Security',
    'release_notes',
    '-qa',
    'qa-',
    'a--b',
    '',
    'a'.repeat(41),
  ]) {
    expect(isCustomStageId(id)).toBe(false)
  }
  expect(isStageId('work')).toBe(true)
  expect(isStageId('security')).toBe(true)
  expect(isStageId(3)).toBe(false)
})

test('a Stage shows its display name, or its id with a capital letter', () => {
  expect(stageDisplayName('release-notes', { 'release-notes': 'Release notes' })).toBe(
    'Release notes',
  )
  expect(stageDisplayName('security')).toBe('Security')
  expect(stageDisplayName('constructor', {})).toBe('Constructor')
})

test('a custom Stage ranks after the built-in Stage before it in order', () => {
  const order = ['intake', 'security', 'work', 'validate', 'release-notes', 'review', 'merge']
  expect(stagePhase('security', order)).toBe('before')
  expect(stagePhase('release-notes', order)).toBe('after')
  expect(compareStages('release-notes', 'review', order)).toBeLessThan(0)
  expect(compareStages('release-notes', 'validate', order)).toBeGreaterThan(0)
  expect(clarifyIsOver('security', order)).toBe(false)
})

test('Stage lists merge across Factories: built-ins in order, each custom Stage after the Stage before it', () => {
  const stage = (id: string, extra: Partial<BoardStage> = {}): BoardStage => ({
    id,
    enabled: true,
    gate: false,
    ...extra,
  })
  const first = [
    stage('backlog'),
    stage('work'),
    stage('merge'),
    stage('ship', { name: 'Ship it', custom: true }),
    stage('done'),
  ]
  const second = [
    stage('backlog'),
    stage('work'),
    stage('merge'),
    stage('docs', { custom: true }),
    stage('done'),
  ]
  const merged = mergeStageLists([first, second])

  expect(merged.map((s) => s.id)).toEqual([
    'backlog',
    'intake',
    'clarify',
    'design',
    'work',
    'validate',
    'review',
    'merge',
    'ship',
    'docs',
    'cleanup',
    'done',
  ])
  expect(merged.find((s) => s.id === 'design')?.enabled).toBe(false)
  expect(stageNameIn(merged, 'ship')).toBe('Ship it')
  expect(stageNameIn(merged, 'gone', { gone: 'Old pass' })).toBe('Old pass')
  expect(stageNameIn(merged, 'gone')).toBe('Gone')
  expect(stageNameIn(merged, 'ship', { ship: 'Ship' })).toBe('Ship')

  const reordered = mergeStageLists([
    ['backlog', 'intake', 'work', 'design', 'merge', 'done'].map((id) => stage(id)),
  ])
  expect(reordered.map((s) => s.id)).toEqual([
    'backlog',
    'intake',
    'clarify',
    'work',
    'design',
    'validate',
    'review',
    'merge',
    'cleanup',
    'done',
  ])

  const gone = stage('review', { removed: true, enabled: false })
  expect(
    mergeStageLists([[stage('backlog'), gone, stage('done')]]).find((s) => s.id === 'review'),
  ).toMatchObject({ removed: true })
  expect(
    mergeStageLists([[stage('backlog'), gone, stage('done')], [stage('review')]]).find(
      (s) => s.id === 'review',
    )?.removed,
  ).toBeUndefined()
})

test('settings rows follow the order, keep built-ins that are off and put Cleanup after Merge', () => {
  expect(
    settingsStageOrder([
      'intake',
      'clarify',
      'work',
      'security-audit',
      'validate',
      'review',
      'merge',
    ]),
  ).toEqual([
    'backlog',
    'intake',
    'clarify',
    'design',
    'work',
    'security-audit',
    'validate',
    'review',
    'merge',
    'cleanup',
    'done',
  ])
  expect(settingsStageOrder(['intake', 'work', 'merge', 'ship', 'cleanup'])).toEqual([
    'backlog',
    'intake',
    'clarify',
    'design',
    'work',
    'validate',
    'review',
    'merge',
    'ship',
    'cleanup',
    'done',
  ])
  expect(settingsStageOrder(['intake', 'work', 'design', 'merge'])).toEqual([
    'backlog',
    'intake',
    'clarify',
    'work',
    'design',
    'validate',
    'review',
    'merge',
    'cleanup',
    'done',
  ])
})

test('a Stage file name gives its Stage id only for a working or custom Stage', () => {
  expect(stageFileId('stages/review.md')).toBe('review')
  expect(stageFileId('stages/security-audit.md')).toBe('security-audit')
  expect(stageFileId('stages/done.md')).toBeUndefined()
  expect(stageFileId('stages/Bad Name.md')).toBeUndefined()
  expect(stageFileId('stages/a/b.md')).toBeUndefined()
  expect(stageFileId('notes.md')).toBeUndefined()
})

test('Cleanup is on only when turned on; other Stages are on unless turned off', () => {
  expect(stageEnabled('cleanup', true, undefined)).toBe(false)
  expect(stageEnabled('cleanup', true, true)).toBe(true)
  expect(stageEnabled('design', true, undefined)).toBe(true)
  expect(stageEnabled('design', false, undefined)).toBe(false)
  expect(stageEnabled('backlog', true, false)).toBe(true)
})
