import type { Factory } from '@ted/protocol'
import type { FactoryIcon, FactoryIconColor } from '@ted/protocol/factory-icon'

const automaticOrder: readonly FactoryIconColor[] = [
  'blue',
  'orange',
  'teal',
  'pink',
  'green',
  'purple',
  'yellow',
  'red',
  'sky',
]

export function ownColor(icon: FactoryIcon | undefined): FactoryIconColor | undefined {
  return icon?.kind === 'letter' || icon?.kind === 'symbol' ? icon.color : undefined
}

export function factoryColors(
  factories: readonly Pick<Factory, 'id' | 'icon'>[],
): ReadonlyMap<string, FactoryIconColor> {
  const taken = new Set(factories.flatMap((f) => ownColor(f.icon) ?? []))
  const free = automaticOrder.filter((color) => !taken.has(color))
  const pool = free.length > 0 ? free : automaticOrder
  let next = 0
  return new Map(
    factories.map((f) => {
      const own = ownColor(f.icon)
      if (own !== undefined) return [f.id, own]
      const color = pool[next % pool.length] ?? 'blue'
      next += 1
      return [f.id, color]
    }),
  )
}
