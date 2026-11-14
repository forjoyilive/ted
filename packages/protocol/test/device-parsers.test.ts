import { expect, test } from 'vitest'
import { devicePoint, parseDeviceRequest } from '../src/index.ts'
import { rejects, roundTrip, variants } from './parser-cases.ts'

roundTrip(parseDeviceRequest, {
  action: 'size',
  app: { name: 'android', repo: 'widgets' },
  ref: '3',
  point: { x: 10, y: 20 },
  to: { x: 30, y: 40 },
  text: 'Hello',
  key: 'back',
  appearance: 'dark',
  size: '1080x1920',
  density: 420,
})

variants(parseDeviceRequest, [
  { action: 'screen', app: { name: 'android' } },
  { action: 'tap', app: { name: 'android' }, ref: '2' },
  { action: 'tap', app: { name: 'android' }, point: { x: 0, y: 10_000 } },
  { action: 'swipe', app: { name: 'android' }, point: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
  { action: 'type', app: { name: 'android' }, text: 'a b' },
  { action: 'key', app: { name: 'android' }, key: 'enter' },
  { action: 'appearance', app: { name: 'android' }, appearance: 'light' },
  { action: 'size', app: { name: 'android' }, size: 'iPhone 16 Pro' },
  { action: 'size', app: { name: 'android' }, size: '1080x1920', density: 420 },
  { action: 'screenshot', app: { name: 'android' } },
])

const app = { name: 'android' }
rejects(parseDeviceRequest, null, 'body must be a JSON object')
rejects(parseDeviceRequest, { action: 'shell', app }, 'Unknown App action')
rejects(parseDeviceRequest, { action: 'screen' }, 'app must be an object')
rejects(parseDeviceRequest, { action: 'screen', app: { name: ' ' } }, 'Name the App')
rejects(parseDeviceRequest, { action: 'tap', app }, 'Tap an element reference from screen')
rejects(
  parseDeviceRequest,
  { action: 'tap', app, ref: '1', point: { x: 1, y: 1 } },
  'Tap an element reference from screen',
)
rejects(
  parseDeviceRequest,
  { action: 'tap', app, point: { x: -1, y: 1 } },
  'point.x must be a whole number from 0 to 10000',
)
rejects(
  parseDeviceRequest,
  { action: 'tap', app, point: { x: 1, y: 1.5 } },
  'point.y must be a whole number from 0 to 10000',
)
rejects(
  parseDeviceRequest,
  { action: 'swipe', app, point: { x: 1, y: 1 } },
  'Give the swipe’s start and end points',
)
rejects(parseDeviceRequest, { action: 'type', app, text: '' }, 'Give the text to type')
rejects(parseDeviceRequest, { action: 'type', app, text: 'x'.repeat(1001) }, 'text is too long')
rejects(parseDeviceRequest, { action: 'key', app, key: 'power' }, 'Use one of these keys')
rejects(parseDeviceRequest, { action: 'appearance', app, appearance: 'sepia' }, 'Use light or dark')
rejects(parseDeviceRequest, { action: 'size', app }, 'Give a size, or reset')
rejects(
  parseDeviceRequest,
  { action: 'size', app, size: '1x1', density: 10 },
  'density must be a whole number from 72 to 800',
)
rejects(parseDeviceRequest, { action: 'screen', app, density: 420 }, 'density goes with size')

test('devicePoint reads x,y within the limit', () => {
  expect(devicePoint('12,34')).toEqual({ x: 12, y: 34 })
  expect(devicePoint('12, 34')).toBeUndefined()
  expect(devicePoint('10001,0')).toBeUndefined()
  expect(devicePoint('-1,0')).toBeUndefined()
})
