import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { appIconPng } from '../src/app-icon.ts'
import { logoSvg } from '../src/logo.ts'
import { decodePng as decode } from './decode-png.ts'

const buildDir = path.resolve(import.meta.dirname, '..', 'build')

describe('app icon', () => {
  test('the macOS icon is the booth on a light tile inside the icon grid margin, with a shadow', () => {
    const icon = decode(appIconPng({ size: 1024 }))

    expect([icon.width, icon.height]).toEqual([1024, 1024])
    expect(icon.pixel(0, 0)[3]).toBe(0)
    expect(icon.pixel(512, 60)[3]).toBe(0)
    const tile = icon.pixel(512, 150)
    expect(tile[0]).toBeGreaterThan(240)
    expect(tile[3]).toBe(255)
    const line = icon.pixel(358, 568)
    expect(line[0]).toBeLessThan(60)
    expect(line[3]).toBe(255)
    const shadow = icon.pixel(512, 932)[3]
    expect(shadow).toBeGreaterThan(0)
    expect(shadow).toBeLessThan(128)
  })

  test('TED Dev’s icon has a yellow tile and a dark band', () => {
    const icon = decode(appIconPng({ size: 1024, edition: 'dev' }))

    const tile = icon.pixel(512, 150)
    expect(tile[0]).toBeGreaterThan(240)
    expect(tile[2]).toBeLessThan(60)
    const band = icon.pixel(300, 800)
    expect(band[0]).toBeLessThan(60)
    expect(band[3]).toBe(255)
  })

  test('the Linux icon fills more of its canvas', () => {
    const icon = decode(appIconPng({ size: 1024, layout: 'linux' }))

    expect(icon.pixel(512, 60)[3]).toBe(255)
    expect(icon.pixel(0, 0)[3]).toBe(0)
  })

  test('the icon files in build/ match what scripts/icons.ts draws', () => {
    for (const size of [16, 512]) {
      const committed = decode(readFileSync(path.join(buildDir, 'icons', `${size}x${size}.png`)))
      expect(committed.raw.equals(decode(appIconPng({ size, layout: 'linux' })).raw)).toBe(true)
    }
    expect(readFileSync(path.join(buildDir, 'icon.icns')).toString('latin1', 0, 4)).toBe('icns')
    expect(readFileSync(path.join(buildDir, 'logo.svg'), 'utf8')).toBe(logoSvg())
  })
})
