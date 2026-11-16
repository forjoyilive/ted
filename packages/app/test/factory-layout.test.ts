import type { FactoryLayout } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  addGroup,
  arrange,
  dropTarget,
  groupSections,
  inSidebarOrder,
  moveStep,
  moveTo,
  putInGroup,
  renameGroup,
  rollUp,
  ungroup,
} from '../src/renderer/factory-layout.ts'
import { factory } from './support/fixtures.ts'

const acme = (...factoryIds: string[]) => ({ group: { id: 'g1', name: 'Acme', factoryIds } })
const layout: FactoryLayout = { items: [{ factoryId: 'a' }, acme('b', 'c'), { factoryId: 'd' }] }
const factories = ['a', 'b', 'c', 'd', 'e'].map((id, position) =>
  factory({ id, name: id, position }),
)

describe('arrange', () => {
  test('follows the layout, drops gone Factories and adds new ones at the end', () => {
    const entries = arrange(
      factories.filter((f) => f.id !== 'c'),
      layout,
    )
    expect(
      entries.map((e) =>
        e.kind === 'factory' ? e.factory.id : [e.group.name, e.factories.map((f) => f.id)],
      ),
    ).toEqual(['a', ['Acme', ['b']], 'd', 'e'])
    expect(inSidebarOrder(entries).map((f) => f.id)).toEqual(['a', 'b', 'd', 'e'])
  })
})

describe('moveTo', () => {
  test('a Factory dropped on a grouped Factory joins that group', () => {
    expect(moveTo(layout, { factoryId: 'a' }, { after: { factoryId: 'b' } })).toEqual({
      items: [acme('b', 'a', 'c'), { factoryId: 'd' }],
    })
  })

  test('a Factory dropped into a group goes last, and next to an ungrouped one leaves its group', () => {
    expect(moveTo(layout, { factoryId: 'd' }, { into: 'g1' })).toEqual({
      items: [{ factoryId: 'a' }, acme('b', 'c', 'd')],
    })
    expect(moveTo(layout, { factoryId: 'c' }, { before: { factoryId: 'a' } })).toEqual({
      items: [{ factoryId: 'c' }, { factoryId: 'a' }, acme('b'), { factoryId: 'd' }],
    })
  })

  test('a group moves as a whole and lands beside the group of the Factory it is dropped on', () => {
    expect(moveTo(layout, { groupId: 'g1' }, { after: { factoryId: 'd' } })).toEqual({
      items: [{ factoryId: 'a' }, { factoryId: 'd' }, acme('b', 'c')],
    })
    const two: FactoryLayout = {
      items: [acme('b'), { group: { id: 'g2', name: 'Home', factoryIds: ['a'] } }],
    }
    expect(moveTo(two, { groupId: 'g1' }, { after: { factoryId: 'a' } })).toEqual({
      items: [two.items[1], two.items[0]],
    })
    expect(moveTo(layout, { groupId: 'g1' }, { into: 'g1' })).toBeUndefined()
  })

  test('a drop that changes nothing saves nothing', () => {
    expect(moveTo(layout, { factoryId: 'b' }, { before: { factoryId: 'c' } })).toBeUndefined()
    expect(moveTo(layout, { factoryId: 'b' }, { after: { factoryId: 'b' } })).toBeUndefined()
  })
})

describe('dropTarget', () => {
  const drop = (
    dragging: Parameters<typeof dropTarget>[1],
    spot: Parameters<typeof dropTarget>[2],
  ) => {
    const target = dropTarget(layout, dragging, spot)
    return target && moveTo(layout, dragging, target)
  }

  test('a group header’s top half puts a Factory above the group, its bottom half into it first', () => {
    const header = { groupId: 'g1' }
    expect(drop({ factoryId: 'c' }, { row: header, half: 'top' })).toEqual({
      items: [{ factoryId: 'a' }, { factoryId: 'c' }, acme('b'), { factoryId: 'd' }],
    })
    expect(drop({ factoryId: 'd' }, { row: header, half: 'bottom' })).toEqual({
      items: [{ factoryId: 'a' }, acme('d', 'b', 'c')],
    })
    expect(dropTarget(layout, { groupId: 'g1' }, { row: header, half: 'top' })).toBeUndefined()
  })

  test('a dragged group lands after a group on its header’s bottom half, never inside', () => {
    const two: FactoryLayout = {
      items: [acme('b'), { group: { id: 'g2', name: 'Home', factoryIds: ['a'] } }],
    }
    expect(dropTarget(two, { groupId: 'g2' }, { row: { groupId: 'g1' }, half: 'bottom' })).toEqual({
      after: { groupId: 'g1' },
    })
    expect(dropTarget(two, { groupId: 'g2' }, { into: 'g1' })).toBeUndefined()
    expect(
      dropTarget(two, { groupId: 'g1' }, { row: { factoryId: 'b' }, half: 'top' }),
    ).toBeUndefined()
  })

  test('the strip under a group and the end of the list put a Factory outside the group', () => {
    expect(drop({ factoryId: 'b' }, { afterGroup: 'g1' })).toEqual({
      items: [{ factoryId: 'a' }, acme('c'), { factoryId: 'b' }, { factoryId: 'd' }],
    })
    const last: FactoryLayout = { items: [{ factoryId: 'a' }, acme('b', 'c')] }
    const target = dropTarget(last, { factoryId: 'c' }, { end: true })
    expect(target && moveTo(last, { factoryId: 'c' }, target)).toEqual({
      items: [{ factoryId: 'a' }, acme('b'), { factoryId: 'c' }],
    })
    expect(drop({ groupId: 'g1' }, { end: true })).toEqual({
      items: [{ factoryId: 'a' }, { factoryId: 'd' }, acme('b', 'c')],
    })
  })

  test('a Factory row’s halves put the dragged Factory above or below it', () => {
    expect(drop({ factoryId: 'd' }, { row: { factoryId: 'a' }, half: 'top' })).toEqual({
      items: [{ factoryId: 'd' }, { factoryId: 'a' }, acme('b', 'c')],
    })
    expect(drop({ factoryId: 'a' }, { row: { factoryId: 'c' }, half: 'bottom' })).toEqual({
      items: [acme('b', 'c', 'a'), { factoryId: 'd' }],
    })
  })
})

describe('moveStep', () => {
  test('moves a grouped Factory within its group, and others among the top-level items', () => {
    expect(moveStep(layout, { factoryId: 'c' }, -1)).toEqual({
      items: [{ factoryId: 'a' }, acme('c', 'b'), { factoryId: 'd' }],
    })
    expect(moveStep(layout, { factoryId: 'b' }, -1)).toBeUndefined()
    expect(moveStep(layout, { groupId: 'g1' }, 1)).toEqual({
      items: [{ factoryId: 'a' }, { factoryId: 'd' }, acme('b', 'c')],
    })
    expect(moveStep(layout, { factoryId: 'd' }, 1)).toBeUndefined()
  })
})

describe('groups', () => {
  test('a new group takes the place of the Factory it starts with', () => {
    expect(addGroup(layout, { id: 'g2', name: 'Home' }, 'd')).toEqual({
      items: [
        { factoryId: 'a' },
        acme('b', 'c'),
        { group: { id: 'g2', name: 'Home', factoryIds: ['d'] } },
      ],
    })
    expect(addGroup(layout, { id: 'g2', name: 'Home' }, 'b')).toEqual({
      items: [
        { factoryId: 'a' },
        acme('c'),
        { group: { id: 'g2', name: 'Home', factoryIds: ['b'] } },
        { factoryId: 'd' },
      ],
    })
    expect(addGroup(layout, { id: 'g2', name: 'Home' }).items[0]).toEqual({
      group: { id: 'g2', name: 'Home', factoryIds: [] },
    })
  })

  test('remove from group places the Factory after it; Ungroup keeps every Factory in place', () => {
    expect(putInGroup(layout, 'b', undefined)).toEqual({
      items: [{ factoryId: 'a' }, acme('c'), { factoryId: 'b' }, { factoryId: 'd' }],
    })
    expect(putInGroup(layout, 'a', undefined)).toBeUndefined()
    expect(ungroup(layout, 'g1')).toEqual({
      items: [{ factoryId: 'a' }, { factoryId: 'b' }, { factoryId: 'c' }, { factoryId: 'd' }],
    })
    expect(renameGroup(layout, 'g1', 'Clients').items[1]).toEqual({
      group: { id: 'g1', name: 'Clients', factoryIds: ['b', 'c'] },
    })
  })

  test('a collapsed group rolls up its Factories’ marks', () => {
    expect(
      rollUp(
        {
          b: { waiting: 2, failed: true },
          c: { waiting: 1, uncounted: true, stopsWork: true },
          d: { waiting: 5 },
        },
        ['b', 'c'],
      ),
    ).toEqual({ waiting: 3, uncounted: false, failed: true, stopsWork: true })
    expect(rollUp({ c: { waiting: 1, uncounted: true } }, ['b', 'c'])).toMatchObject({
      waiting: 1,
      uncounted: true,
    })
  })
})

describe('groupSections', () => {
  test('one section per group in layout order, then No group', () => {
    const two: FactoryLayout = {
      items: [{ group: { id: 'g2', name: 'Clients', factoryIds: ['d'] } }, ...layout.items],
    }
    const sections = groupSections(two)
    expect(sections.keys).toEqual(['g2', 'g1', 'none'])
    expect(sections.keys.map(sections.labelOf)).toEqual(['Clients', 'Acme', 'No Factory group'])
    expect(['a', 'b', 'd', 'e'].map(sections.keyOf)).toEqual(['none', 'g1', 'g2', 'none'])
  })
})
