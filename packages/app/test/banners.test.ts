import type { Banner } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  appWideBanners,
  factoriesStoppingWork,
  factoryBanners,
  foldBanners,
  nextReturn,
  settingsStopsWork,
} from '../src/renderer/banners.ts'

const now = new Date('2026-11-08T12:00:00Z')

function banner(id: string, fields: Partial<Banner> = {}): Banner {
  return {
    id,
    problem: id,
    severity: 'warning',
    text: id,
    raisedAt: '2026-11-08T10:00:00Z',
    ...fields,
  }
}

describe('banner areas', () => {
  const all = [
    banner('app-warning'),
    banner('app-stop', { severity: 'stops-work' }),
    banner('nb-warning', { factoryId: 'nb' }),
    banner('ms-stop', { factoryId: 'ms', severity: 'stops-work' }),
    banner('app-dismissed', { dismissedUntil: '2026-11-09T11:00:00Z' }),
    banner('app-back', { dismissedUntil: '2026-11-08T11:00:00Z' }),
  ]

  test('app-wide banners are those with no Factory, without dismissed ones, stops-work first', () => {
    expect(appWideBanners(all, now).map((b) => b.id)).toEqual([
      'app-stop',
      'app-warning',
      'app-back',
    ])
  })

  test('a Factory’s banners are only its own', () => {
    expect(factoryBanners(all, 'nb', now).map((b) => b.id)).toEqual(['nb-warning'])
    expect(factoryBanners(all, 'ms', now).map((b) => b.id)).toEqual(['ms-stop'])
  })

  test('only a stops-work Factory banner marks the Factory’s sidebar row', () => {
    expect(factoriesStoppingWork(all)).toEqual(new Set(['ms']))
  })

  test('Settings has a problem only when a stops-work banner opens a Settings section', () => {
    expect(settingsStopsWork(all)).toBe(false)
    expect(
      settingsStopsWork([
        banner('signed-out', {
          severity: 'stops-work',
          action: { label: 'Fix', opens: { kind: 'settings', section: 'agents' } },
        }),
      ]),
    ).toBe(true)
    expect(
      settingsStopsWork([
        banner('disk', {
          action: { label: 'Open', opens: { kind: 'settings', section: 'storage' } },
        }),
      ]),
    ).toBe(false)
  })

  test('the next dismissed banner to come back says when to look again', () => {
    expect(nextReturn(all, now)).toBe(Date.parse('2026-11-09T11:00:00Z'))
    expect(nextReturn([banner('a')], now)).toBeUndefined()
  })
})

describe('folding', () => {
  const five = [
    banner('s1', { severity: 'stops-work' }),
    banner('s2', { severity: 'stops-work' }),
    banner('s3', { severity: 'stops-work' }),
    banner('w1'),
    banner('w2'),
  ]

  test('two or fewer banners all show with no fold row', () => {
    expect(foldBanners(five.slice(0, 2), false)).toEqual({ shown: five.slice(0, 2) })
  })

  test('more than two show the first two and summarize the rest', () => {
    expect(foldBanners(five, false)).toEqual({
      shown: five.slice(0, 2),
      fold: { label: '+3 more', detail: '1 stops work, 2 warnings' },
    })
    expect(foldBanners(five.slice(0, 4), false)).toMatchObject({
      fold: { label: '+2 more', detail: '1 stops work, 1 warning' },
    })
    expect(foldBanners([...five.slice(3), banner('w3')], false)).toMatchObject({
      fold: { label: '+1 more', detail: '1 warning' },
    })
  })

  test('expanded, every banner shows and the row counts them', () => {
    expect(foldBanners(five, true)).toEqual({ shown: five, fold: { label: '5 problems' } })
  })
})
