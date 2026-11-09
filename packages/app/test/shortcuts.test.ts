import { describe, expect, test } from 'vitest'
import { keySequences, type PressedKey } from '../src/renderer/shortcuts.ts'

const key = (k: string, mods: Partial<Omit<PressedKey, 'key'>> = {}): PressedKey => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

function run(shortcuts: Record<string, readonly string[]>, keys: PressedKey[], gap = 10) {
  const sequences = keySequences(Object.entries(shortcuts).map(([id, s]) => ({ id, shortcuts: s })))
  const fired: (string | undefined)[] = []
  keys.forEach((pressed, i) => {
    const outcome = sequences.feed(pressed, i * gap)
    fired.push(outcome === 'pending' ? 'pending' : outcome?.id)
  })
  return fired
}

describe('keyboard shortcuts', () => {
  test('a plain letter fires only without modifiers', () => {
    expect(
      run({ new: ['C'] }, [key('c'), key('c', { metaKey: true }), key('C', { shiftKey: true })]),
    ).toEqual(['new', undefined, undefined])
  })

  test('⌘ matches Command on macOS and Control elsewhere', () => {
    const shortcuts = { new: ['⌘N'], settings: ['⌘,'] }
    expect(run(shortcuts, [key('n', { metaKey: true }), key('N', { ctrlKey: true })])).toEqual([
      'new',
      'new',
    ])
    expect(run(shortcuts, [key(',', { metaKey: true }), key('n')])).toEqual(['settings', undefined])
  })

  test('⇧ letters need Shift, and symbols typed with Shift ignore it', () => {
    const shortcuts = { approve: ['A'], accept: ['⇧A'], sheet: ['?', '⌘/'] }
    expect(
      run(shortcuts, [
        key('a'),
        key('A', { shiftKey: true }),
        key('?', { shiftKey: true }),
        key('/', { metaKey: true }),
      ]),
    ).toEqual(['approve', 'accept', 'sheet', 'sheet'])
  })

  test('named keys: ⌫ ↑ ↓ ← → ↵ Esc, ⌥ and ⌃', () => {
    const shortcuts = {
      archive: ['⌘⌫'],
      up: ['⌥↑'],
      next: ['J', '↓'],
      left: ['←'],
      send: ['⌘↵'],
      close: ['Esc'],
      shell: ['⌃`'],
    }
    expect(
      run(shortcuts, [
        key('Backspace', { metaKey: true }),
        key('ArrowUp', { altKey: true }),
        key('ArrowUp'),
        key('ArrowDown'),
        key('ArrowLeft'),
        key('Enter', { ctrlKey: true }),
        key('Escape'),
        key('`', { ctrlKey: true }),
        key('`', { metaKey: true }),
      ]),
    ).toEqual(['archive', 'up', undefined, 'next', 'left', 'send', 'close', 'shell', undefined])
  })

  test('G then a letter is a sequence, and the wait for the second key runs out', () => {
    const shortcuts = { inbox: ['G I'], all: ['G A'], approve: ['A'] }
    expect(run(shortcuts, [key('g'), key('i'), key('g'), key('a'), key('a')])).toEqual([
      'pending',
      'inbox',
      'pending',
      'all',
      'approve',
    ])
    expect(run(shortcuts, [key('g'), key('a')], 5000)).toEqual(['pending', 'approve'])
  })

  test('a key that breaks a sequence is matched on its own', () => {
    expect(run({ inbox: ['G I'], next: ['J'] }, [key('g'), key('j'), key('i')])).toEqual([
      'pending',
      'next',
      undefined,
    ])
  })

  test('Shift, Control and Alt presses on their own do not break a sequence', () => {
    expect(run({ inbox: ['G I'] }, [key('g'), key('Shift', { shiftKey: true }), key('i')])).toEqual(
      ['pending', 'pending', 'inbox'],
    )
  })
})
