import { expect, test } from 'vitest'
import { besideAnchor, besideMenu } from '../src/renderer/menu-tooltip.ts'

const tip = { width: 240, height: 60 }
const window = { width: 1280, height: 800 }

test('a menu tooltip sits left of the menu, level with its item', () => {
  expect(besideMenu({ top: 120 }, { left: 500, right: 800 }, tip, window)).toEqual({
    left: 250,
    top: 120,
  })
})

test('a menu tooltip moves right of the menu when the left has no room', () => {
  expect(besideMenu({ top: 120 }, { left: 100, right: 400 }, tip, window)).toEqual({
    left: 410,
    top: 120,
  })
})

test('a menu tooltip stays inside the window when neither side has room', () => {
  const narrow = { width: 700, height: 800 }
  expect(besideMenu({ top: 120 }, { left: 200, right: 500 }, tip, narrow).left).toBe(8)
})

test('a menu tooltip near the bottom of the window moves up', () => {
  expect(besideMenu({ top: 780 }, { left: 500, right: 800 }, tip, window).top).toBe(732)
})

const anchor = { top: 300, bottom: 314, left: 400, right: 414 }

test('a help tooltip opens below its ? button', () => {
  expect(besideAnchor(anchor, tip, window)).toEqual({ left: 390, top: 320 })
})

test('a help tooltip near the bottom of the window opens above its ? button', () => {
  const low = { top: 760, bottom: 774, left: 400, right: 414 }
  expect(besideAnchor(low, tip, window).top).toBe(694)
})

test('a help tooltip lines up its right edge with the ? button when aligned to the end', () => {
  expect(besideAnchor(anchor, tip, window, 'end').left).toBe(174)
})

test('a help tooltip stays inside the window at the right edge', () => {
  const right = { top: 300, bottom: 314, left: 1260, right: 1274 }
  expect(besideAnchor(right, tip, window).left).toBe(1032)
})
