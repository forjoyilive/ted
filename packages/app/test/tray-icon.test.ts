import { describe, expect, test } from 'vitest'
import { dotPng, trayIconPng } from '../src/tray-icon.ts'
import { decodePng as decode } from './decode-png.ts'

describe('menu-bar icon images', () => {
  test('the plain icon is the booth drawn in black on clear, 18 points tall, at the asked scale', () => {
    const icon = decode(trayIconPng({ scale: 2, warning: false }))

    expect([icon.width, icon.height]).toEqual([24, 36])
    expect(icon.pixel(3, 21)).toEqual([0, 0, 0, 255])
    expect(icon.pixel(11, 4)).toEqual([0, 0, 0, 255])
    expect(icon.pixel(12, 21)[3]).toBe(0)
    expect(icon.pixel(0, 0)[3]).toBe(0)
  })

  test('the warning icon is wider, greys the booth and carries an amber dot to the right', () => {
    const icon = decode(trayIconPng({ scale: 1, warning: true }))

    expect([icon.width, icon.height]).toEqual([19, 18])
    expect(icon.pixel(16, 8)).toEqual([184, 110, 18, 255])
    expect(icon.pixel(1, 10)).toEqual([128, 128, 128, 255])
    expect(icon.pixel(13, 9)[3]).toBe(0)
  })

  test('menu dots are red for stops-work problems and amber for warnings', () => {
    const red = decode(dotPng('stops-work', 1))
    const amber = decode(dotPng('warning', 1))

    expect([red.width, red.height]).toEqual([12, 12])
    expect(red.pixel(6, 6)).toEqual([192, 57, 43, 255])
    expect(amber.pixel(6, 6)).toEqual([184, 110, 18, 255])
    expect(red.pixel(0, 0)[3]).toBe(0)
  })
})
