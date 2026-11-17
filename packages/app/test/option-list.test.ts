import { expect, test } from 'vitest'
import {
  listPlacement,
  nextOptionIndex,
  startIndex,
} from '../src/renderer/components/option-list.ts'

const viewport = { width: 800, height: 600 }

test('a list opens below its control, flips above near the bottom, and scrolls when neither side fits', () => {
  const list = { width: 160, height: 280 }
  expect(listPlacement({ top: 100, bottom: 128, left: 40 }, list, viewport)).toEqual({
    top: 132,
    left: 40,
    maxHeight: 460,
  })
  expect(listPlacement({ top: 500, bottom: 528, left: 40 }, list, viewport)).toEqual({
    top: 216,
    left: 40,
    maxHeight: 488,
  })
  expect(
    listPlacement({ top: 300, bottom: 328, left: 700 }, { width: 160, height: 900 }, viewport),
  ).toEqual({ top: 8, left: 632, maxHeight: 288 })
  expect(
    listPlacement({ top: 260, bottom: 288, left: 4 }, { width: 160, height: 900 }, viewport),
  ).toEqual({ top: 292, left: 8, maxHeight: 300 })
})

test('the keyboard moves past disabled options and a letter jumps to the next label starting with it', () => {
  const options = [
    { label: 'Today', disabled: false },
    { label: 'Last 7 days', disabled: true },
    { label: 'Last 30 days', disabled: false },
    { label: 'This week', disabled: false },
    { label: 'All time', disabled: true },
  ]
  expect(startIndex(options, 4)).toBe(0)
  expect(startIndex(options, 2)).toBe(2)
  expect(nextOptionIndex(options, 0, 'ArrowDown')).toBe(2)
  expect(nextOptionIndex(options, 2, 'ArrowUp')).toBe(0)
  expect(nextOptionIndex(options, 0, 'ArrowUp')).toBe(0)
  expect(nextOptionIndex(options, 3, 'ArrowDown')).toBe(3)
  expect(nextOptionIndex(options, 3, 'Home')).toBe(0)
  expect(nextOptionIndex(options, 0, 'End')).toBe(3)
  expect(nextOptionIndex(options, 3, 't')).toBe(0)
  expect(nextOptionIndex(options, 0, 'T')).toBe(3)
  expect(nextOptionIndex(options, 0, 'l')).toBe(2)
  expect(nextOptionIndex(options, 0, 'z')).toBeUndefined()
  expect(nextOptionIndex(options, 0, 'Escape')).toBeUndefined()
})
