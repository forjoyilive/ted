import { isNumber, isObject, parseJson } from '@ted/protocol/parse'

export type SidebarSide = 'navigation' | 'list' | 'details'
export type SidebarWidths = { [side in SidebarSide]: number }

export const sidebarSides: readonly SidebarSide[] = ['navigation', 'list', 'details']
export const sidebarDefaults: SidebarWidths = { navigation: 210, list: 330, details: 320 }
export const sidebarMinimums: SidebarWidths = { navigation: 180, list: 260, details: 240 }
export const sidebarMaximums: SidebarWidths = { navigation: 360, list: 640, details: 560 }
const sidebarReserves: SidebarWidths = { navigation: 210, list: 260, details: 260 }
const shrinkOrder: readonly SidebarSide[] = ['list', 'details', 'navigation']
const storageKey = 'ted.sidebar.widths'

export function clampSidebar(side: SidebarSide, width: number): number {
  return Math.round(Math.max(sidebarMinimums[side], Math.min(sidebarMaximums[side], width)))
}

export function readSidebarWidths(): SidebarWidths {
  try {
    const value = parseJson(localStorage.getItem(storageKey) ?? 'null')
    const read = (side: SidebarSide) => {
      const width = isObject(value) ? value[side] : undefined
      return isNumber(width) && Number.isFinite(width)
        ? clampSidebar(side, width)
        : sidebarDefaults[side]
    }
    return { navigation: read('navigation'), list: read('list'), details: read('details') }
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
  navigation: boolean
  list: boolean
  details: boolean
}

function middleWidth(space: SidebarSpace) {
  const baseline = sidebarSides.reduce(
    (sum, side) => sum + (space[side] ? sidebarReserves[side] : 0),
    0,
  )
  const available = Math.max(0, space.width)
  return { available, middle: Math.min(320, Math.max(0, available - baseline)) }
}

export function fitSidebars(preferred: SidebarWidths, space: SidebarSpace): SidebarWidths {
  const widths = {
    navigation: clampSidebar('navigation', preferred.navigation),
    list: clampSidebar('list', preferred.list),
    details: clampSidebar('details', preferred.details),
  }
  const sides = shrinkOrder.filter((side) => space[side])
  const { available, middle } = middleWidth(space)
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
  const occupied = sidebarSides.reduce(
    (sum, other) => sum + (other !== side && space[other] ? widths[other] : 0),
    0,
  )
  const { available, middle } = middleWidth(space)
  return Math.max(
    sidebarMinimums[side],
    Math.min(sidebarMaximums[side], available - occupied - middle),
  )
}
