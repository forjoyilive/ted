import { expect, test } from 'vitest'
import { type FactoryIcon, factoryColors } from '../src/factory-icon.ts'

const made = (icons: (FactoryIcon | undefined)[]) =>
  icons.map((icon, index) => ({ id: `f${index}`, ...(icon && { icon }) }))

test('Factories with no color of their own get distinct colors in order, skipping chosen ones', () => {
  const colors = factoryColors(
    made([
      undefined,
      { kind: 'letter', color: 'orange' },
      { kind: 'emoji', emoji: '🧾' },
      { kind: 'symbol', name: 'box', color: 'blue' },
      { kind: 'image', dataUrl: 'data:image/png;base64,' },
    ]),
  )
  expect([...colors.values()]).toEqual(['teal', 'orange', 'pink', 'blue', 'green'])
})

test('Automatic colors never use gray and start over once all nine are taken', () => {
  const colors = [...factoryColors(made(Array.from({ length: 11 }, () => undefined))).values()]
  expect(colors).not.toContain('gray')
  expect(new Set(colors.slice(0, 9)).size).toBe(9)
  expect(colors.slice(9)).toEqual(colors.slice(0, 2))
})

test('When every color is chosen, automatic colors reuse the full order', () => {
  const chosen = (
    ['blue', 'orange', 'teal', 'pink', 'green', 'purple', 'yellow', 'red', 'sky'] as const
  ).map((color): FactoryIcon => ({ kind: 'letter', color }))
  const colors = factoryColors(made([...chosen, undefined]))
  expect(colors.get('f9')).toBe('blue')
})
