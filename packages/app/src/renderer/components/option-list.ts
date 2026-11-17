export interface ListOption {
  label: string
  disabled: boolean
}

export interface Box {
  top: number
  bottom: number
  left: number
}

export interface Size {
  width: number
  height: number
}

export interface ListPlacement {
  top: number
  left: number
  maxHeight: number
}

const gap = 4
const margin = 8

export function listPlacement(anchor: Box, list: Size, viewport: Size): ListPlacement {
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - list.width - margin))
  const below = viewport.height - margin - anchor.bottom - gap
  const above = anchor.top - gap - margin
  if (list.height <= below || below >= above)
    return { top: anchor.bottom + gap, left, maxHeight: Math.max(0, below) }
  const maxHeight = Math.max(0, above)
  return { top: anchor.top - gap - Math.min(list.height, maxHeight), left, maxHeight }
}

export function startIndex(options: readonly ListOption[], chosen: number): number {
  if (options[chosen] && !options[chosen].disabled) return chosen
  return Math.max(
    0,
    options.findIndex((option) => !option.disabled),
  )
}

export function nextOptionIndex(
  options: readonly ListOption[],
  active: number,
  key: string,
): number | undefined {
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]))
  const first = enabled[0]
  const last = enabled.at(-1)
  if (first === undefined || last === undefined) return undefined
  if (key === 'ArrowDown') return enabled.find((index) => index > active) ?? last
  if (key === 'ArrowUp') return enabled.findLast((index) => index < active) ?? first
  if (key === 'Home' || key === 'PageUp') return first
  if (key === 'End' || key === 'PageDown') return last
  if (Array.from(key).length !== 1 || key === ' ') return undefined
  const letter = key.toLocaleLowerCase()
  for (let step = 1; step <= options.length; step++) {
    const index = (active + step) % options.length
    const option = options[index]
    if (option && !option.disabled && option.label.trim().toLocaleLowerCase().startsWith(letter))
      return index
  }
  return undefined
}
