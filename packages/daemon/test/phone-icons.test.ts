import type { FactoryIcon } from '@ted/protocol/factory-icon'
import { expect, test } from 'vitest'
import {
  imageVersion,
  type PhoneIconFactory,
  phoneFactoryIcons,
  phoneFactoryImage,
} from '../src/phones/icons.ts'

const factory = (id: string, position: number, icon?: FactoryIcon): PhoneIconFactory => ({
  id,
  position,
  createdAt: '2026-11-20T09:00:00.000Z',
  ...(icon && { icon }),
})

test('a Factory with no icon gets the automatic color the Mac sidebar gives it, in sidebar order', () => {
  const icons = phoneFactoryIcons([
    factory('third', 2),
    factory('first', 0),
    factory('second', 1, { kind: 'letter', color: 'orange' }),
  ])
  expect(icons.get('first')).toEqual({ kind: 'letter', color: 'blue' })
  expect(icons.get('second')).toEqual({ kind: 'letter', color: 'orange' })
  expect(icons.get('third')).toEqual({ kind: 'letter', color: 'teal' })
})

test('symbols, emoji and images keep their kind, and an image sends only its version', () => {
  const dataUrl = 'data:image/png;base64,AAAA'
  const icons = phoneFactoryIcons([
    factory('s', 0, { kind: 'symbol', name: 'rocket', color: 'pink' }),
    factory('e', 1, { kind: 'emoji', emoji: '🌱' }),
    factory('i', 2, { kind: 'image', dataUrl }),
  ])
  expect(icons.get('s')).toEqual({ kind: 'symbol', symbol: 'rocket', color: 'pink' })
  expect(icons.get('e')).toEqual({ kind: 'emoji', emoji: '🌱' })
  expect(icons.get('i')).toEqual({ kind: 'image', version: imageVersion(dataUrl) })
  expect(imageVersion(`${dataUrl}B`)).not.toBe(imageVersion(dataUrl))
})

test('an image too large for one phone reply is refused instead of sent', () => {
  const huge = `data:image/png;base64,${'A'.repeat(41_000)}`
  expect(phoneFactoryImage([factory('i', 0, { kind: 'image', dataUrl: huge })], 'i')).toMatchObject(
    { code: 'refused' },
  )
})
