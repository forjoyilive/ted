import { describe, expect, test } from 'vitest'
import { blockedByText, createLabel, droppedWarning, wouldStart } from '../src/renderer/proposal.ts'

const row = (blockedBy: number[], dropped: number[]) => ({
  row: 4,
  first: false,
  create: true,
  blockedBy,
  dropped,
})

describe('proposal card text', () => {
  test('the button counts the Tasks it creates', () => {
    expect(createLabel(4)).toBe('Create 4 Tasks')
    expect(createLabel(1)).toBe('Create 1 Task')
  })

  test('Start the unblocked ones names the rows that would start', () => {
    expect(wouldStart([5])).toBe('(row 5 would start)')
    expect(wouldStart([4, 5])).toBe('(rows 4 and 5 would start)')
    expect(wouldStart([2, 4, 5])).toBe('(rows 2, 4 and 5 would start)')
    expect(wouldStart([])).toBe('(none would start)')
  })

  test('a row blocked by an unchecked row warns that it loses that blocker', () => {
    expect(droppedWarning(row([], [3]))).toBe(
      'Blocked by row 3, which won’t be created. This Task will have no blocker.',
    )
    expect(droppedWarning(row([1], [3]))).toBe(
      'Blocked by row 3, which won’t be created. It stays blocked by row 1.',
    )
    expect(droppedWarning(row([], []))).toBeUndefined()
    expect(blockedByText([])).toBe('—')
    expect(blockedByText([1, 2])).toBe('blocked by 1, 2')
  })
})
