import { expect, test } from 'vitest'
import {
  type BacklogStarts,
  backlogStartFactories,
  type FactoryLayout,
  noBacklogStarts,
  parseSetBacklogStartsRequest,
  sameBacklogStarts,
  startsFromBacklog,
  withoutGroups,
} from '../src/index.ts'
import { rejects, roundTrip } from './parser-cases.ts'

roundTrip(parseSetBacklogStartsRequest, {
  enabled: true,
  all: false,
  groupIds: ['g1'],
  factoryIds: ['f1', 'f2'],
})

test('parseSetBacklogStartsRequest drops repeated IDs', () => {
  expect(
    parseSetBacklogStartsRequest({
      enabled: true,
      all: false,
      groupIds: ['g1', 'g1'],
      factoryIds: ['f1', 'f1'],
    }),
  ).toEqual({ enabled: true, all: false, groupIds: ['g1'], factoryIds: ['f1'] })
})

rejects(parseSetBacklogStartsRequest, null, 'backlog starts must be an object')
rejects(
  parseSetBacklogStartsRequest,
  { enabled: 'yes', all: false, groupIds: [], factoryIds: [] },
  'enabled must be true or false',
)
rejects(
  parseSetBacklogStartsRequest,
  { enabled: true, groupIds: [], factoryIds: [] },
  'all must be true or false',
)
rejects(
  parseSetBacklogStartsRequest,
  { enabled: true, all: false, groupIds: [1], factoryIds: [] },
  'groupIds must be a list of IDs',
)
rejects(
  parseSetBacklogStartsRequest,
  { enabled: true, all: false, groupIds: [], factoryIds: [' '] },
  'factoryIds must be a list of IDs',
)
rejects(
  parseSetBacklogStartsRequest,
  { enabled: true, all: false, groupIds: [], factoryIds: 'f1' },
  'factoryIds must be a list of IDs',
)

const layout: FactoryLayout = {
  items: [
    { group: { id: 'g1', name: 'Clients', factoryIds: ['a', 'b'] } },
    { group: { id: 'g2', name: 'Personal', factoryIds: ['c'] } },
    { factoryId: 'd' },
  ],
}
const starts = (changes: Partial<BacklogStarts>): BacklogStarts => ({
  ...noBacklogStarts,
  enabled: true,
  ...changes,
})

test('only the chosen groups and Factories start Backlog Tasks, and only while the switch is on', () => {
  const chosen = starts({ groupIds: ['g1'], factoryIds: ['d'] })
  expect(backlogStartFactories(chosen, layout)).toEqual(new Set(['d', 'a', 'b']))
  expect(['a', 'b', 'c', 'd'].filter((id) => startsFromBacklog(chosen, layout, id))).toEqual([
    'a',
    'b',
    'd',
  ])
  expect(startsFromBacklog({ ...chosen, enabled: false }, layout, 'a')).toBe(false)
  expect(startsFromBacklog(starts({ all: true }), layout, 'new')).toBe(true)
  expect(startsFromBacklog(starts({ all: true, enabled: false }), layout, 'a')).toBe(false)
})

test('a Factory moved into a chosen group takes part', () => {
  const moved: FactoryLayout = {
    items: [{ group: { id: 'g1', name: 'Clients', factoryIds: ['a', 'b', 'd'] } }],
  }
  expect(startsFromBacklog(starts({ groupIds: ['g1'] }), moved, 'd')).toBe(true)
})

test('removing a chosen group chooses its Factories one by one', () => {
  const chosen = starts({ groupIds: ['g1', 'g2'], factoryIds: ['d'] })
  const after: FactoryLayout = {
    items: [{ factoryId: 'a' }, { factoryId: 'b' }, layout.items[1], { factoryId: 'd' }].filter(
      (item) => item !== undefined,
    ),
  }
  expect(withoutGroups(chosen, layout, after)).toEqual(
    starts({ groupIds: ['g2'], factoryIds: ['d', 'a', 'b'] }),
  )
  expect(withoutGroups(chosen, layout, layout)).toBe(chosen)
})

test('sameBacklogStarts ignores the order of IDs', () => {
  expect(
    sameBacklogStarts(starts({ factoryIds: ['a', 'b'] }), starts({ factoryIds: ['b', 'a'] })),
  ).toBe(true)
  expect(sameBacklogStarts(starts({}), { ...starts({}), enabled: false })).toBe(false)
})
