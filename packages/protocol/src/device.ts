import type { AppRef } from './app.ts'
import type { Attachment } from './task.ts'

export const deviceActions = [
  'screen',
  'tap',
  'type',
  'key',
  'swipe',
  'appearance',
  'size',
  'screenshot',
] as const
export type DeviceAction = (typeof deviceActions)[number]

export const deviceKeys = [
  'back',
  'home',
  'enter',
  'tab',
  'delete',
  'up',
  'down',
  'left',
  'right',
] as const
export type DeviceKey = (typeof deviceKeys)[number]

export const deviceLimits = {
  maxCoordinate: 10_000,
  maxText: 1_000,
  maxSize: 100,
  minDensity: 72,
  maxDensity: 800,
}

export interface DevicePoint {
  x: number
  y: number
}

export interface DeviceRequest {
  action: DeviceAction
  app: AppRef
  ref?: string
  point?: DevicePoint
  to?: DevicePoint
  text?: string
  key?: DeviceKey
  appearance?: 'light' | 'dark'
  size?: string
  density?: number
}

export interface DeviceResult {
  text: string
  attachment?: Attachment
}

export function devicePoint(value: string): DevicePoint | undefined {
  const match = /^(\d{1,5}),(\d{1,5})$/.exec(value.trim())
  if (!match) return undefined
  const point = { x: Number(match[1]), y: Number(match[2]) }
  return point.x <= deviceLimits.maxCoordinate && point.y <= deviceLimits.maxCoordinate
    ? point
    : undefined
}
