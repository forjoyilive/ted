import { describe, expect, test } from 'vitest'
import {
  type BulkTracker,
  createBulkIntake,
  type FiringLink,
  IntakeBudgetError,
} from '../src/tasks/bulk-intake.ts'

interface Item {
  id: string
  tracked?: boolean
  cost?: number
  fails?: string
  changesSetting?: boolean
}

interface Imported {
  id: string
  created: number
}

interface Skipped {
  id: string
  reason: string
}

function harness(
  items: Item[],
  options: { limit?: number; overBudget?: 'stop' | 'next'; firing?: string[] } = {},
) {
  const lines: string[] = []
  const firing = [...(options.firing ?? [])]
  const tried: string[] = []
  let settingChanged = false
  const bulk = createBulkIntake({
    createdInFiring: (_link, owns) => firing.filter(owns).length,
    log: (line) => lines.push(line),
  })
  const tracker: BulkTracker<Item, Imported, Skipped, { scope: string }> = {
    kind: 'linear',
    limit: options.limit ?? 10,
    owns: (url) => url.startsWith('fake:'),
    overBudget: options.overBudget ?? 'next',
    start: async () => ({
      items,
      unchanged: () => {
        if (settingChanged) throw new Error('the intake scope changed')
      },
      label: 'Fake intake for KEY',
      fields: { scope: 'team' },
    }),
    isTracked: (item) => item.tracked === true,
    importOne: async (item, { remaining, unchanged }) => {
      tried.push(item.id)
      const cost = item.cost ?? 1
      if (cost > remaining()) throw new IntakeBudgetError()
      if (item.changesSetting) settingChanged = true
      if (item.fails !== undefined) throw new Error(item.fails)
      unchanged()
      for (let n = 0; n < cost; n++) firing.push(`fake:${item.id}:${n}`)
      return { created: cost, entry: { id: item.id, created: cost } }
    },
    skippedEntry: (item, reason) => ({ id: item.id, reason }),
  }
  const link: FiringLink = { automationId: 'a1', firingId: 'f1' }
  return {
    lines,
    tried,
    tracker,
    app: () => bulk.run('factory-1', undefined, tracker),
    automation: () => bulk.run('factory-1', link, tracker),
    bulk,
  }
}

describe('bulk intake run', () => {
  test('leaves items over the cap for the next run', async () => {
    const h = harness([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { limit: 2 })
    const result = await h.app()
    expect(result.imported.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(result.left).toBe(1)
    expect(h.tried).toEqual(['a', 'b'])
    expect(h.lines).toEqual(['Fake intake for KEY: imported 2, skipped 0, left 1'])
  })

  test('counts an already tracked item and does not import it', async () => {
    const h = harness([{ id: 'a', tracked: true }, { id: 'b' }])
    const result = await h.app()
    expect(result).toMatchObject({ tracked: 1, left: 0, scope: 'team' })
    expect(h.tried).toEqual(['b'])
  })

  test('skips an item whose import fails and goes on', async () => {
    const h = harness([
      { id: 'a', fails: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      { id: 'b' },
    ])
    const result = await h.app()
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.id).toBe('a')
    expect(result.skipped[0]?.reason).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(result.imported.map((entry) => entry.id)).toEqual(['b'])
    expect(result.stopped).toBeUndefined()
  })

  test('stops when the intake setting changes during an import', async () => {
    const h = harness([{ id: 'a' }, { id: 'b', changesSetting: true, fails: 'boom' }, { id: 'c' }])
    const result = await h.app()
    expect(result.stopped).toBe('the intake scope changed')
    expect(result.imported.map((entry) => entry.id)).toEqual(['a'])
    expect(result.skipped).toEqual([])
    expect(h.tried).toEqual(['a', 'b'])
    expect(h.lines).toEqual(['Fake intake for KEY: imported 1, skipped 0, left 0, stopped'])
  })

  test('counts every Task an import created against the cap when the app runs it', async () => {
    const h = harness(
      [
        { id: 'a', cost: 2 },
        { id: 'b', cost: 2 },
        { id: 'c', cost: 1 },
      ],
      {
        limit: 3,
      },
    )
    const result = await h.app()
    expect(result.imported.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(result.left).toBe(1)
  })

  test('stops importing after the first item over the cap when the tracker says so', async () => {
    const h = harness(
      [
        { id: 'a', cost: 2 },
        { id: 'b', cost: 2 },
        { id: 'c', cost: 1 },
      ],
      {
        limit: 3,
        overBudget: 'stop',
      },
    )
    const result = await h.app()
    expect(result.imported.map((entry) => entry.id)).toEqual(['a'])
    expect(result.left).toBe(2)
    expect(h.tried).toEqual(['a', 'b'])
  })

  test('counts this tracker’s Tasks the Automation firing already created', async () => {
    const h = harness([{ id: 'a' }, { id: 'b' }], {
      limit: 3,
      firing: ['fake:earlier:0', 'fake:earlier:1', 'other:x'],
    })
    const result = await h.automation()
    expect(result.imported.map((entry) => entry.id)).toEqual(['a'])
    expect(result.left).toBe(1)
  })

  test('logs nothing when nothing was imported and the run did not stop', async () => {
    const h = harness([{ id: 'a', tracked: true }])
    await h.app()
    expect(h.lines).toEqual([])
  })

  test('runs one intake at a time per tracker and Factory', async () => {
    const h = harness([])
    let release = () => {}
    const order: string[] = []
    const first = h.bulk.run('factory-1', undefined, {
      ...h.tracker,
      start: async () => {
        order.push('first started')
        await new Promise<void>((resolve) => {
          release = resolve
        })
        order.push('first listed')
        return h.tracker.start()
      },
    })
    const second = h.bulk.run('factory-1', undefined, {
      ...h.tracker,
      start: async () => {
        order.push('second started')
        return h.tracker.start()
      },
    })
    await expect.poll(() => order).toEqual(['first started'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first started', 'first listed', 'second started'])
  })
})
