import { describe, expect, test } from 'vitest'
import { keyBindings, keysFor, shortcutSheet } from '../src/renderer/keymap.ts'
import { keySequences } from '../src/renderer/shortcuts.ts'

const specShortcuts = [
  '⌘K',
  '⌘N',
  'C',
  'G I',
  'G A',
  'G B',
  'G L',
  'G P',
  '⌘1–⌘9',
  '⌘[',
  '⌘]',
  'Esc',
  '⌘,',
  '?',
  '⌘/',
  '⌘Q',
  'J',
  'K',
  '↓',
  '↑',
  'H',
  'L',
  '←',
  '→',
  '↵',
  'R',
  'A',
  '⇧A',
  '⇧R',
  '⌘↵',
  'S',
  'P',
  'B',
  'E',
  '⌥↑',
  '⌥↓',
  '⌘⌫',
  '⌃`',
  '/',
]

describe('the shortcut sheet', () => {
  test('lists every shortcut in spec §10.11 under its section', () => {
    const sheet = shortcutSheet()
    expect(sheet.map((s) => s.title)).toEqual([
      'Global',
      'Moving',
      'Answering',
      'Task actions',
      'Filter',
    ])
    const shown = sheet.flatMap((s) => s.rows.flatMap((r) => r.keys))
    for (const keys of specShortcuts) expect(shown).toContain(keys)
  })

  test('the sheet and the command registry read the same keys', () => {
    expect(keysFor('new-task')).toEqual(['⌘N', 'C'])
    expect(keysFor('go-to-inbox')).toEqual(['G I'])
    expect(keysFor('archive')).toEqual(['⌘⌫'])
  })

  test('each key press resolves to one binding', () => {
    const sequences = keySequences(keyBindings)
    const press = (key: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}) =>
      sequences.feed(
        { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods },
        0,
      )
    expect(press('3', { metaKey: true })).toMatchObject({ id: 'factory:3' })
    expect(press('A', { shiftKey: true })).toMatchObject({ id: 'accept-recommended' })
    expect(press('r')).toMatchObject({ id: 'reply' })
    expect(press('g')).toBe('pending')
    expect(press('b')).toMatchObject({ id: 'go-to-board' })
    expect(press('[', { metaKey: true })).toMatchObject({ id: 'back' })
    expect(press('Enter')).toMatchObject({ id: 'open' })
  })

  test('the sheet says ↵ sends from a comment box or chat and ⇧↵ adds a line', () => {
    const answering = shortcutSheet().find((s) => s.title === 'Answering')
    const row = answering?.rows.find((r) => r.id === 'send-message')
    expect(row?.keys).toEqual(['↵'])
    expect(row?.label).toContain('⇧↵ adds a new line')
    expect(keyBindings.some((b) => b.id === 'send-message')).toBe(false)
  })
})
