import { expect, test } from 'vitest'
import {
  previewDimensions,
  previewSize,
  previewSizeLabel,
  previewSizeOf,
  previewSizeValue,
} from '../src/preview-size.ts'

test('previewSize reads each size and writes it back the same way', () => {
  for (const value of [
    'desktop',
    'tablet',
    'tablet-landscape',
    'mobile',
    'mobile-landscape',
    '1280',
  ])
    expect(previewSizeValue(previewSize(value) as never)).toBe(value)
  expect(previewSize(' Mobile ')).toEqual({ kind: 'mobile', landscape: false })
  expect(previewSize('1024px')).toEqual({ kind: 'custom', width: 1024 })
})

test('previewSize refuses unknown names and widths out of range', () => {
  for (const value of ['', 'watch', 'desktop-landscape', '319', '3841', '12.5'])
    expect(previewSize(value)).toBe(
      'Give desktop, tablet, mobile, tablet-landscape, mobile-landscape or a width from 320 to 3840',
    )
})

test('a device size turns sideways in landscape and a custom size has no height', () => {
  expect(previewDimensions({ kind: 'desktop' })).toBeUndefined()
  expect(previewDimensions({ kind: 'mobile', landscape: false })).toEqual({
    width: 390,
    height: 844,
  })
  expect(previewDimensions({ kind: 'tablet', landscape: true })).toEqual({
    width: 1024,
    height: 768,
  })
  expect(previewDimensions({ kind: 'custom', width: 1280 })).toEqual({ width: 1280 })
})

test('labels name the size the human sees', () => {
  expect(previewSizeLabel({ kind: 'desktop' })).toBe('Desktop')
  expect(previewSizeLabel({ kind: 'mobile', landscape: true })).toBe('Mobile · 844 × 390')
  expect(previewSizeLabel({ kind: 'custom', width: 1280 })).toBe('Custom · 1280 px')
})

test('an App with no preview setting opens at desktop', () => {
  expect(previewSizeOf(undefined)).toEqual({ kind: 'desktop' })
  expect(previewSizeOf('tablet')).toEqual({ kind: 'tablet', landscape: false })
})
