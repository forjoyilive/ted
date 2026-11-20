import { likelyFilesSection, linkSharedFiles, type Proposal, planProposal } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { proposalRows } from '../src/chats/requests.ts'
import { approvedShape } from '../src/tasks/proposal-tasks.ts'
import { splitApprovedMessage, splitApprovedSummary } from '../src/tasks/split.ts'

const row = (title: string, blockedBy: number[] = []) => ({
  title,
  scope: `${title} scope`,
  priority: 'none' as const,
  blockedBy,
})

const touching = (files: string[], blockedBy: number[] = []) => ({
  ...row('Piece', blockedBy),
  files,
})

const links = (rows: ReturnType<typeof linkSharedFiles>) =>
  rows.map((r) => [r.blockedBy, r.addedBlockedBy ?? [], r.sharedFiles ?? []])

const split: Proposal = {
  firstPiece: { id: 't-41', displayId: 'NB-41' },
  rows: [
    row('Local note cache'),
    row('Sync queue with retry', [1]),
    row('Line-level merge', [2]),
    row('Conflict view', [3]),
    row('Offline badge'),
  ],
}

describe('planProposal', () => {
  test('with every row checked, every row is created, row 1 included', () => {
    const plan = planProposal(split, [])
    expect(plan.creates).toBe(5)
    expect(plan.rows.map((r) => [r.row, r.create, r.blockedBy, r.dropped])).toEqual([
      [1, true, [], []],
      [2, true, [1], []],
      [3, true, [2], []],
      [4, true, [3], []],
      [5, true, [], []],
    ])
    expect(plan.unblocked).toEqual([1, 5])
  })

  test('unchecking a row others need drops that blocker and counts one fewer', () => {
    const plan = planProposal(split, [3])
    expect(plan.creates).toBe(4)
    expect(plan.rows[2]).toMatchObject({ row: 3, create: false })
    expect(plan.rows[3]).toMatchObject({ row: 4, create: true, blockedBy: [], dropped: [3] })
    expect(plan.unblocked).toEqual([1, 4, 5])
  })

  test('a dependent does not take on the unchecked row’s own blockers', () => {
    const plan = planProposal(split, [2, 3])
    expect(plan.rows[3]).toMatchObject({ blockedBy: [], dropped: [3] })
    expect(plan.rows[2]).toMatchObject({ create: false, dropped: [] })
  })

  test('row 1 is an ordinary row: unchecking it drops it like any other', () => {
    const plan = planProposal(split, [1])
    expect(plan.rows[0]).toMatchObject({ create: false })
    expect(plan.rows[1]).toMatchObject({ create: true, blockedBy: [], dropped: [1] })
    expect(plan.creates).toBe(4)
  })

  test('creation order puts each blocker before the Tasks it blocks', () => {
    const plan = planProposal({ rows: [row('A', [3]), row('B', [1]), row('C')] }, [])
    expect(plan.order).toEqual([3, 1, 2])
    expect(plan.creates).toBe(3)
  })
})

describe('linkSharedFiles', () => {
  test('rows that share no file get no links', () => {
    const rows = linkSharedFiles([touching(['a.ts']), touching(['b.ts']), touching(['c.ts'])], [])
    expect(links(rows)).toEqual([
      [[], [], []],
      [[], [], []],
      [[], [], []],
    ])
  })

  test('rows that share a file run one after another, in row order', () => {
    const rows = linkSharedFiles(
      [
        touching(['sandbox.ts']),
        touching(['other.ts']),
        touching(['sandbox.ts', 'x.ts']),
        touching(['sandbox.ts']),
      ],
      [],
    )
    expect(links(rows)).toEqual([
      [[], [], []],
      [[], [], []],
      [[1], [1], [{ row: 1, files: ['sandbox.ts'] }]],
      [[3], [3], [{ row: 3, files: ['sandbox.ts'] }]],
    ])
  })

  test('a link the agent already set, or one implied by others, is not added again', () => {
    const rows = linkSharedFiles(
      [touching(['a.ts']), touching(['b.ts'], [1]), touching(['a.ts', 'b.ts'], [2])],
      [],
    )
    expect(links(rows)).toEqual([
      [[], [], []],
      [[1], [], []],
      [[2], [], [{ row: 2, files: ['b.ts'] }]],
    ])
  })

  test('the agent’s own order wins over row order, so links never loop', () => {
    const rows = linkSharedFiles(
      [touching(['a.ts'], [2]), touching(['a.ts']), touching(['a.ts'])],
      [],
    )
    expect(links(rows)).toEqual([
      [[2], [], [{ row: 2, files: ['a.ts'] }]],
      [[], [], []],
      [[1], [1], [{ row: 1, files: ['a.ts'] }]],
    ])
  })

  test('GLOSSARY.md, AGENTS.md and CLAUDE.md at a repo root are not compared', () => {
    const rows = linkSharedFiles(
      [
        touching(['ted-mobile/GLOSSARY.md', 'ted/AGENTS.md', 'docs/CLAUDE.md']),
        touching(['ted-mobile/GLOSSARY.md', 'ted/AGENTS.md', 'docs/CLAUDE.md']),
      ],
      ['ted', 'ted-mobile'],
    )
    expect(links(rows)[1]).toEqual([[1], [1], [{ row: 1, files: ['docs/CLAUDE.md'] }]])
  })

  test('in a Factory with one repo, a nested file named like an ignored one is still compared', () => {
    const rows = linkSharedFiles(
      [touching(['GLOSSARY.md', 'ted/AGENTS.md']), touching(['GLOSSARY.md', 'ted/AGENTS.md'])],
      ['ted'],
    )
    expect(links(rows)[1]).toEqual([[1], [1], [{ row: 1, files: ['ted/AGENTS.md'] }]])
  })

  test('in a Factory with several repos, every path starts with a repo name', () => {
    expect(() =>
      proposalRows(
        [{ ...row('A'), files: ['packages/daemon/src/sandbox.ts'] }],
        ['ted', 'ted-mobile'],
      ),
    ).toThrow('must start with one of this Factory’s repos: ted, ted-mobile')
    expect(
      proposalRows([{ ...row('A'), files: ['ted/src/a.ts'] }], ['ted', 'ted-mobile'])[0],
    ).toMatchObject({
      files: ['ted/src/a.ts'],
    })
  })

  test('a created Task lists its files under Likely files', () => {
    expect(likelyFilesSection(['a.ts', 'b/c.ts'])).toBe('## Likely files\n\n- `a.ts`\n- `b/c.ts`')
    expect(likelyFilesSection([])).toBe('')
  })
})

describe('removing a link before approving', () => {
  const chained = { rows: [row('A'), row('B', [1]), row('C', [1, 2])] }

  test('a removed link is left out of the Tasks Ted creates', () => {
    const { unlinked, shape } = approvedShape(chained, [], [{ row: 3, blocker: 1 }])
    expect(shape.rows.map((r) => [r.blockedBy, r.unlinked])).toEqual([
      [[], []],
      [[1], []],
      [[2], [1]],
    ])
    expect(unlinked).toEqual([{ row: 3, blocker: 1 }])
  })

  test('removing the only link makes the row start with the unblocked ones', () => {
    expect(planProposal(chained, [], [{ row: 2, blocker: 1 }]).unblocked).toEqual([1, 2])
  })

  test('a link to a skipped row counts as dropped, not removed', () => {
    const { unlinked, shape } = approvedShape(chained, [1], [{ row: 3, blocker: 1 }])
    expect(shape.rows[2]).toMatchObject({ blockedBy: [2], unlinked: [] })
    expect(unlinked).toEqual([])
  })

  test('removing a link that isn’t there is refused', () => {
    expect(() => approvedShape(chained, [], [{ row: 1, blocker: 2 }])).toThrow(
      'row 1 isn’t blocked by row 2',
    )
  })

  test('the Task Lead hears which links the human removed', () => {
    const message = splitApprovedMessage({
      proposal: chained,
      created: {
        tasks: [
          { row: 1, id: 'a', displayId: 'NB-1' },
          { row: 2, id: 'b', displayId: 'NB-2' },
          { row: 3, id: 'c', displayId: 'NB-3' },
        ],
        skipped: [],
        unlinked: [{ row: 3, blocker: 1 }],
        startUnblocked: false,
      },
      text: '',
    })
    expect(message).toContain('They removed a link: row 3 no longer waits for row 1.')
  })
})

describe('splitApprovedSummary', () => {
  test('a held approval still tells the next Run which child Tasks exist', () => {
    const summary = splitApprovedSummary(
      {
        tasks: [
          { row: 2, id: 'a', displayId: 'NB-42' },
          { row: 5, id: 'b', displayId: 'NB-43' },
        ],
        skipped: [3, 4],
        startUnblocked: false,
      },
      'Keep it small.',
    )
    expect(summary).toBe(
      'approved the split; Ted created NB-42 (row 2), NB-43 (row 5) as child Tasks of this Task, which waits for them to merge; adding: Keep it small.',
    )
  })
})
