import { describe, expect, test } from 'vitest'
import {
  blockedByText,
  createLabel,
  droppedWarning,
  linkReason,
  parentLine,
  tedLinkLead,
  tedLinks,
  tedLinksIntro,
  wouldStart,
} from '../src/renderer/proposal.ts'

const row = (blockedBy: number[], dropped: number[]) => ({
  row: 4,
  create: true,
  blockedBy,
  dropped,
  unlinked: [],
})

describe('proposal card text', () => {
  test('the card says which Task becomes the parent, or that Ted creates one', () => {
    const rows = [
      { title: 'A', scope: 'A', files: ['src/row-1.ts'], priority: 'none' as const, blockedBy: [] },
    ]
    expect(parentLine({ rows, firstPiece: { id: 't-12', displayId: 'TED-12' } })).toBe(
      'TED-12 becomes the parent of these Tasks and runs after they merge.',
    )
    expect(parentLine({ rows })).toBe(
      'Ted creates a parent Task for these Tasks. It runs after they merge.',
    )
  })

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

  test('a blocker chip’s hover text says why the link is there', () => {
    const shared = {
      title: 'Badge',
      scope: 'Badge',
      priority: 'none' as const,
      blockedBy: [1, 2],
      addedBlockedBy: [2],
      sharedFiles: [{ row: 2, files: ['src/editor/Editor.tsx'] }],
    }
    expect(linkReason(shared, 2)).toBe('Both change src/editor/Editor.tsx (added by Ted)')
    expect(linkReason(shared, 1)).toBe('Set by the agent')
  })

  test('the box above the rows lists only links Ted added between rows that will be created', () => {
    const plain = { title: 'A', scope: 'A', priority: 'none' as const, blockedBy: [] }
    const proposal = {
      rows: [
        plain,
        plain,
        {
          ...plain,
          blockedBy: [1, 2],
          addedBlockedBy: [1, 2],
          sharedFiles: [
            { row: 1, files: ['docs/agents/platform.md'] },
            { row: 2, files: ['src/sandbox.ts'] },
          ],
        },
      ],
    }
    expect(tedLinks(proposal, [])).toEqual([
      { row: 3, blocker: 1, files: ['docs/agents/platform.md'] },
      { row: 3, blocker: 2, files: ['src/sandbox.ts'] },
    ])
    expect(tedLinks(proposal, [2])).toEqual([
      { row: 3, blocker: 1, files: ['docs/agents/platform.md'] },
    ])
    expect(tedLinkLead({ row: 3, blocker: 1 })).toBe('Row 3 after row 1: both change ')
    expect(tedLinksIntro(true)).toBe(
      'Ted linked rows that change the same file, so they run one after another. Remove a link with × if the two can run side by side.',
    )
    expect(tedLinksIntro(false)).toBe(
      'Ted linked rows that change the same file, so they run one after another.',
    )
  })
})
