export type SidebarSide = 'navigation' | 'details'
export type SidebarWidths = Record<SidebarSide, number>

export const sidebarDefaults: SidebarWidths = { navigation: 210, details: 320 }
export const sidebarMinimums: SidebarWidths = { navigation: 180, details: 240 }
export const sidebarMaximums: SidebarWidths = { navigation: 360, details: 560 }
const storageKey = 'ted.sidebar.widths'

export function clampSidebar(side: SidebarSide, width: number): number {
  return Math.round(Math.max(sidebarMinimums[side], Math.min(sidebarMaximums[side], width)))
}

export function readSidebarWidths(): SidebarWidths {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (typeof value !== 'object' || value === null) return { ...sidebarDefaults }
    const read = (side: SidebarSide) => {
      const width = Reflect.get(value, side)
      return typeof width === 'number' && Number.isFinite(width)
        ? clampSidebar(side, width)
        : sidebarDefaults[side]
    }
    return { navigation: read('navigation'), details: read('details') }
  } catch {
    return { ...sidebarDefaults }
  }
}

export function saveSidebarWidths(widths: SidebarWidths): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(widths))
  } catch {}
}

export interface SidebarSpace {
  width: number
  fixed: number
  navigation: boolean
  details: boolean
}

export function fitSidebars(preferred: SidebarWidths, space: SidebarSpace): SidebarWidths {
  const widths = {
    navigation: clampSidebar('navigation', preferred.navigation),
    details: clampSidebar('details', preferred.details),
  }
  const sides = (['details', 'navigation'] as const).filter((side) => space[side])
  const baseline = (space.navigation ? 210 : 0) + (space.details ? 260 : 0)
  const available = Math.max(0, space.width - space.fixed)
  const middle = Math.min(320, Math.max(0, available - baseline))
  let excess = sides.reduce((sum, side) => sum + widths[side], 0) - (available - middle)
  for (const side of sides) {
    const reduction = Math.min(Math.max(0, excess), widths[side] - sidebarMinimums[side])
    widths[side] -= reduction
    excess -= reduction
  }
  return widths
}

export function sidebarLimit(
  side: SidebarSide,
  widths: SidebarWidths,
  space: SidebarSpace,
): number {
  const other = side === 'navigation' ? 'details' : 'navigation'
  const occupied = space[other] ? widths[other] : 0
  const baseline = (space.navigation ? 210 : 0) + (space.details ? 260 : 0)
  const available = Math.max(0, space.width - space.fixed)
  const middle = Math.min(320, Math.max(0, available - baseline))
  return Math.max(
    sidebarMinimums[side],
    Math.min(sidebarMaximums[side], available - occupied - middle),
  )
}
