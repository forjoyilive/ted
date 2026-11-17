import { expect, test } from 'vitest'
import { previewFrame } from '../src/renderer/preview-frame.ts'

const pane = { width: 1000, height: 700 }

test('desktop fills the pane at full scale', () => {
  expect(previewFrame({ kind: 'desktop' }, '50', pane)).toEqual({
    width: 1000,
    height: 700,
    scale: 1,
  })
})

test('Fit shrinks a device that is taller than the pane and never enlarges one', () => {
  const tablet = previewFrame({ kind: 'tablet', landscape: false }, 'fit', pane)
  expect(tablet.scale).toBeCloseTo(652 / 1024)
  expect(tablet.height).toBe(652)
  expect(
    previewFrame({ kind: 'mobile', landscape: true }, 'fit', { width: 2000, height: 1000 }),
  ).toEqual({ width: 844, height: 390, scale: 1 })
})

test('a chosen zoom applies until it would no longer fit', () => {
  expect(previewFrame({ kind: 'mobile', landscape: false }, '50', pane)).toEqual({
    width: 195,
    height: 422,
    scale: 0.5,
  })
  expect(previewFrame({ kind: 'mobile', landscape: false }, '100', pane).scale).toBeCloseTo(
    652 / 844,
  )
})

test('a custom width keeps the pane’s height and scales only to fit its width', () => {
  expect(previewFrame({ kind: 'custom', width: 1904 }, 'fit', pane)).toEqual({
    width: 952,
    height: 652,
    scale: 0.5,
  })
})
