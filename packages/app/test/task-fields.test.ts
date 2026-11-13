import { expect, test } from 'vitest'
import { modelChoices, modelOptions } from '../src/renderer/task-fields.ts'

test('modelOptions lists the agent’s top models, then extras and the current value, once each', () => {
  expect(modelOptions('claude', '')).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  expect(modelOptions('codex', undefined)).toEqual([
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gpt-6.1-terra',
    'gpt-6-luna',
  ])
  expect(modelOptions('claude', 'claude-opus-5-5', ['sonnet', undefined, 'pinned'])).toEqual([
    ...modelChoices.claude,
    'pinned',
    'claude-opus-5-5',
  ])
  expect(modelOptions('claude', 'opus')).toEqual(modelChoices.claude)
})

test('modelOptions gives only the current value for an agent without a list', () => {
  expect(modelOptions('antigravity', '')).toEqual([])
  expect(modelOptions('antigravity', 'custom')).toEqual(['custom'])
  expect(modelOptions('same', 'custom')).toEqual(['custom'])
  expect(modelOptions(undefined, '')).toEqual([])
})
