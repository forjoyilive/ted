import { describe, expect, test } from 'vitest'
import { arrowAt } from '../src/renderer/typed-arrows.ts'

function typed(text: string): string {
  let value = ''
  for (const character of text) {
    value += character
    const swap = arrowAt(value, value.length)
    if (swap) value = value.slice(0, swap.start) + swap.arrow + value.slice(swap.end)
  }
  return value
}

describe('arrowAt', () => {
  test('swaps each typed arrow', () => {
    expect(typed('a -> b')).toBe('a → b')
    expect(typed('a <- b')).toBe('a ← b')
    expect(typed('a <-> b')).toBe('a ↔ b')
    expect(typed('a => b')).toBe('a ⇒ b')
    expect(typed('a <= b')).toBe('a ⇐ b')
  })

  test('leaves <=> as typed', () => {
    expect(typed('a <=> b')).toBe('a <=> b')
  })

  test('leaves code alone', () => {
    expect(typed('`a -> b` c -> d')).toBe('`a -> b` c → d')
    expect(typed('```\nx -> y\n``` z -> w')).toBe('```\nx -> y\n``` z → w')
    expect(typed('one ` tick\nnext -> line')).toBe('one ` tick\nnext → line')
  })

  test('reads only the characters before the caret', () => {
    expect(arrowAt('a -> b', 4)).toEqual({ start: 2, end: 4, arrow: '→' })
    expect(arrowAt('a -> b', 6)).toBeNull()
    expect(arrowAt('->', 1)).toBeNull()
  })
})
