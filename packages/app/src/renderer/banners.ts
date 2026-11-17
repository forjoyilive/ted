import { type Banner, bannerOrder, isShowing } from '@ted/protocol/banner'

const visible = (banners: readonly Banner[], now: Date) =>
  banners.filter((b) => isShowing(b, now)).sort(bannerOrder)

export function appWideBanners(banners: readonly Banner[], now = new Date()): Banner[] {
  return visible(
    banners.filter((b) => b.factoryId === undefined),
    now,
  )
}

export function factoryBanners(
  banners: readonly Banner[],
  factoryId: string,
  now = new Date(),
): Banner[] {
  return visible(
    banners.filter((b) => b.factoryId === factoryId),
    now,
  )
}

export function factoriesStoppingWork(banners: readonly Banner[]): Set<string> {
  return new Set(
    banners.flatMap((b) =>
      b.severity === 'stops-work' && b.factoryId !== undefined ? [b.factoryId] : [],
    ),
  )
}

export function settingsStopsWork(banners: readonly Banner[]): boolean {
  return banners.some(
    (b) =>
      b.severity === 'stops-work' &&
      (b.action?.opens?.kind === 'settings' || b.action?.section !== undefined),
  )
}

export function nextReturn(banners: readonly Banner[], now = new Date()): number | undefined {
  const times = banners.flatMap((b) => {
    const t = b.dismissedUntil === undefined ? Number.NaN : Date.parse(b.dismissedUntil)
    return t > now.getTime() ? [t] : []
  })
  return times.length === 0 ? undefined : Math.min(...times)
}

export interface Folded {
  shown: Banner[]
  fold?: { label: string; detail?: string }
}

const shownWhenFolded = 2

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function foldBanners(banners: Banner[], expanded: boolean): Folded {
  if (banners.length <= shownWhenFolded) return { shown: banners }
  if (expanded)
    return { shown: banners, fold: { label: count(banners.length, 'problem', 'problems') } }
  const hidden = banners.slice(shownWhenFolded)
  const stops = hidden.filter((b) => b.severity === 'stops-work').length
  const warnings = hidden.length - stops
  const detail = [
    ...(stops > 0 ? [`${stops} stops work`] : []),
    ...(warnings > 0 ? [count(warnings, 'warning', 'warnings')] : []),
  ].join(', ')
  return {
    shown: banners.slice(0, shownWhenFolded),
    fold: { label: `+${hidden.length} more`, detail },
  }
}
