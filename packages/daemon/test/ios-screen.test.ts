import { expect, test } from 'vitest'
import { iosText, parseIdbScreen } from '../src/apps/ios-screen.ts'

const element = (fields: Record<string, unknown>) => ({
  AXLabel: null,
  AXValue: null,
  AXUniqueId: null,
  enabled: true,
  ...fields,
})

test('parseIdbScreen reads idb’s elements, takes the screen size from the Application and numbers what can be read or tapped', () => {
  const output = JSON.stringify([
    element({
      type: 'Application',
      AXLabel: 'Widgets',
      frame: { x: 0, y: 0, width: 402, height: 874 },
    }),
    element({
      type: 'StaticText',
      AXLabel: `Total\n${String.fromCharCode(0x202e)}$5`,
      frame: { x: 20.4, y: 100, width: 100, height: 20.6 },
    }),
    element({ type: 'Other', frame: { x: 0, y: 0, width: 402, height: 874 } }),
    element({
      type: 'Button',
      AXLabel: 'Buy',
      AXUniqueId: 'buy',
      frame: { x: 20, y: 200, width: 100, height: 40 },
    }),
    element({
      type: 'Button',
      AXLabel: 'Sold out',
      enabled: false,
      frame: { x: 20, y: 300, width: 100, height: 40 },
    }),
    element({
      type: 'TextField',
      AXValue: 'hello',
      frame: { x: 20, y: 400, width: 0, height: 40 },
    }),
    element({ type: 'Cell', frame: { x: 0, y: 500, width: 402, height: 44 } }),
    { type: 'Button', AXLabel: 'No frame' },
  ])
  expect(parseIdbScreen(output)).toEqual({
    width: 402,
    height: 874,
    rotation: 0,
    elements: [
      {
        ref: '1',
        kind: 'StaticText',
        label: 'Total $5',
        clickable: false,
        left: 20,
        top: 100,
        right: 120,
        bottom: 121,
      },
      {
        ref: '2',
        kind: 'Button',
        label: 'Buy',
        id: 'buy',
        clickable: true,
        left: 20,
        top: 200,
        right: 120,
        bottom: 240,
      },
      {
        ref: '3',
        kind: 'Button',
        label: 'Sold out',
        clickable: false,
        left: 20,
        top: 300,
        right: 120,
        bottom: 340,
      },
      { ref: '4', kind: 'Cell', clickable: true, left: 0, top: 500, right: 402, bottom: 544 },
    ],
  })

  const lines = [
    element({ type: 'Button', AXLabel: 'A', frame: { x: 0, y: 0, width: 50, height: 50 } }),
    element({ type: 'Button', AXLabel: 'B', frame: { x: 50, y: 60, width: 50, height: 50 } }),
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')
  expect(parseIdbScreen(lines)).toMatchObject({ width: 100, height: 110 })
  expect(parseIdbScreen('not json')).toBeUndefined()
  expect(parseIdbScreen('[]')).toBeUndefined()
})

test('iosText takes printable ASCII without line breaks', () => {
  expect(iosText("-it's %s fine")).toBe(true)
  expect(iosText('two\nlines')).toBe(false)
  expect(iosText('café')).toBe(false)
  expect(iosText('')).toBe(false)
})
