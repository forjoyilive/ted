import { describe, expect, test } from 'vitest'
import { inStage } from '../src/renderer/stage-filter.ts'

const entry = (stage: string, at: string) => ({ stage, at })
const item = (id: string, createdAt: string) => ({ id, createdAt })

describe('inStage', () => {
  const entries = [
    entry('intake', '2026-11-08T10:00:00Z'),
    entry('work', '2026-11-08T11:00:00Z'),
    entry('validate', '2026-11-08T12:00:00Z'),
    entry('work', '2026-11-08T13:00:00Z'),
  ]
  const items = [
    item('before', '2026-11-08T09:00:00Z'),
    item('intake', '2026-11-08T10:30:00Z'),
    item('work-1', '2026-11-08T11:00:00Z'),
    item('validate', '2026-11-08T12:59:59Z'),
    item('work-2', '2026-11-08T14:00:00Z'),
  ]

  test('keeps the events from every visit to the Stage', () => {
    expect(inStage(items, entries, 'work').map((i) => i.id)).toEqual(['work-1', 'work-2'])
    expect(inStage(items, entries, 'validate').map((i) => i.id)).toEqual(['validate'])
    expect(inStage(items, entries, 'intake').map((i) => i.id)).toEqual(['intake'])
  })

  test('with no Stage chosen, keeps everything', () => {
    expect(inStage(items, entries, undefined)).toEqual(items)
  })

  test('a Stage the Task never entered has no events', () => {
    expect(inStage(items, entries, 'design')).toEqual([])
  })
})
