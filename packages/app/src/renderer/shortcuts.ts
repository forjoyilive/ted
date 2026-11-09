export interface PressedKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

interface Chord {
  key: string
  command: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

export interface Bound {
  id: string
  shortcuts?: readonly string[] | undefined
}

const named: Record<string, string> = {
  '⌫': 'backspace',
  '↑': 'arrowup',
  '↓': 'arrowdown',
  '←': 'arrowleft',
  '→': 'arrowright',
  '↵': 'enter',
  Esc: 'escape',
}

const modifierKeys = new Set(['shift', 'control', 'alt', 'meta'])
const sequenceWaitMs = 1500

function parseChord(text: string): Chord {
  const chord: Chord = { key: '', command: false, control: false, alt: false, shift: false }
  let rest = text
  for (;;) {
    if (rest.length > 1 && rest.startsWith('⌘')) chord.command = true
    else if (rest.length > 1 && rest.startsWith('⌃')) chord.control = true
    else if (rest.length > 1 && rest.startsWith('⌥')) chord.alt = true
    else if (rest.length > 1 && rest.startsWith('⇧')) chord.shift = true
    else break
    rest = rest.slice(1)
  }
  chord.key = named[rest] ?? rest.toLowerCase()
  return chord
}

export function parseShortcut(text: string): Chord[] {
  return text.split(' ').map(parseChord)
}

function isLetter(key: string): boolean {
  return /^[a-z]$/.test(key)
}

function matches(chord: Chord, pressed: PressedKey): boolean {
  const key = pressed.key.toLowerCase()
  if (key !== chord.key) return false
  if (chord.command ? !(pressed.metaKey || pressed.ctrlKey) : pressed.metaKey) return false
  if (chord.control && (!pressed.ctrlKey || pressed.metaKey)) return false
  if (!chord.command && !chord.control && pressed.ctrlKey) return false
  if (chord.alt !== pressed.altKey) return false
  const shiftMatters = isLetter(chord.key) || chord.key.length > 1
  return !shiftMatters || chord.shift === pressed.shiftKey
}

export function usesCommandKey(text: string): boolean {
  return parseShortcut(text).some((chord) => chord.command || chord.control)
}

export function keySequences<T extends Bound>(bound: readonly T[]) {
  const sequences = bound.flatMap((item) =>
    (item.shortcuts ?? []).map((text) => ({ item, chords: parseShortcut(text) })),
  )
  let pending: PressedKey[] = []
  let lastAt = 0

  function attempt(keys: readonly PressedKey[]): T | 'pending' | undefined {
    let longer = false
    for (const { item, chords } of sequences) {
      if (chords.length < keys.length) continue
      if (!keys.every((pressed, i) => chords[i] && matches(chords[i], pressed))) continue
      if (chords.length === keys.length) return item
      longer = true
    }
    return longer ? 'pending' : undefined
  }

  return {
    feed(pressed: PressedKey, now: number): T | 'pending' | undefined {
      if (modifierKeys.has(pressed.key.toLowerCase())) {
        return pending.length > 0 ? 'pending' : undefined
      }
      if (pending.length > 0 && now - lastAt > sequenceWaitMs) pending = []
      lastAt = now
      const keys = [...pending, pressed]
      let outcome = attempt(keys)
      if (outcome === undefined && pending.length > 0) outcome = attempt([pressed])
      pending = outcome === 'pending' ? (attempt(keys) === 'pending' ? keys : [pressed]) : []
      return outcome
    },
    reset() {
      pending = []
    },
  }
}
