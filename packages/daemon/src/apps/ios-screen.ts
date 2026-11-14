import type { DeviceKey } from '@ted/protocol'
import { maxScreenElements, type Screen, type ScreenElement } from './android-screen.ts'

export const iosKeyCodes: Partial<Record<DeviceKey, number>> = {
  enter: 40,
  delete: 42,
  tab: 43,
  right: 79,
  left: 80,
  down: 81,
  up: 82,
}

const tappable = new Set([
  'Button',
  'Link',
  'Cell',
  'TextField',
  'SecureTextField',
  'SearchField',
  'TextView',
  'Switch',
  'Toggle',
  'Slider',
  'Stepper',
  'Tab',
  'SegmentedControl',
  'PopUpButton',
  'MenuItem',
  'CheckBox',
  'RadioButton',
  'Picker',
  'PickerWheel',
])

function oneLine(value: unknown, limit = 200): string {
  if (typeof value !== 'string') return ''
  return [
    ...value
      .replace(/\p{Cc}|\p{Cf}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, limit)
    .join('')
}

function frameOf(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, width, height } = value as Record<string, unknown>
  const numbers = [x, y, width, height]
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

function entries(output: string): unknown[] | undefined {
  const text = output.trim()
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {}
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return undefined
  try {
    return lines.map((l) => JSON.parse(l) as unknown)
  } catch {
    return undefined
  }
}

export function parseIdbScreen(output: string): Screen | undefined {
  const items = entries(output)
  if (!items) return undefined
  let width = 0
  let height = 0
  let appSize: { width: number; height: number } | undefined
  const elements: ScreenElement[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const node = item as Record<string, unknown>
    const frame = frameOf(node.frame)
    if (!frame) continue
    const left = Math.round(frame.x)
    const top = Math.round(frame.y)
    const right = Math.round(frame.x + frame.width)
    const bottom = Math.round(frame.y + frame.height)
    const kind = oneLine(node.type, 60) || 'Element'
    if (kind === 'Application') {
      appSize ??= { width: right, height: bottom }
      continue
    }
    width = Math.max(width, right)
    height = Math.max(height, bottom)
    if (right <= left || bottom <= top) continue
    const label = oneLine(node.AXLabel ?? node.title)
    const text = oneLine(node.AXValue)
    const clickable = tappable.has(kind) && node.enabled !== false
    if (text === '' && label === '' && !clickable) continue
    if (elements.length >= maxScreenElements) continue
    const id = oneLine(node.AXUniqueId, 100)
    elements.push({
      ref: String(elements.length + 1),
      kind,
      ...(text !== '' && { text }),
      ...(label !== '' && { label }),
      ...(id !== '' && { id }),
      clickable,
      left,
      top,
      right,
      bottom,
    })
  }
  const size = appSize ?? { width, height }
  if (size.width <= 0 || size.height <= 0) return undefined
  return { ...size, rotation: 0, elements }
}

export function iosText(text: string): boolean {
  return /^[\x20-\x7e]+$/.test(text)
}
