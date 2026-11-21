import { createHash } from 'node:crypto'
import { type Factory, type PhoneFactoryIcon, phoneReplyBodyMax } from '@ted/protocol'
import { type FactoryIconColor, factoryColors } from '@ted/protocol/factory-icon'
import { jsonBytes } from './fit.ts'
import type { PhoneOutcome } from './requests.ts'

export type PhoneIconFactory = Pick<Factory, 'id' | 'icon' | 'position' | 'createdAt'>

export function imageVersion(dataUrl: string): string {
  return createHash('sha256').update(dataUrl).digest('base64url').slice(0, 16)
}

function inMacOrder(factories: readonly PhoneIconFactory[]): PhoneIconFactory[] {
  return [...factories].sort(
    (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
  )
}

function iconFor(factory: PhoneIconFactory, automatic: FactoryIconColor): PhoneFactoryIcon {
  const icon = factory.icon
  switch (icon?.kind) {
    case 'letter':
      return { kind: 'letter', color: icon.color }
    case 'symbol':
      return { kind: 'symbol', symbol: icon.name, color: icon.color }
    case 'emoji':
      return { kind: 'emoji', emoji: icon.emoji }
    case 'image':
      return { kind: 'image', version: imageVersion(icon.dataUrl) }
    default:
      return { kind: 'letter', color: automatic }
  }
}

export function phoneFactoryIcons(
  factories: readonly PhoneIconFactory[],
): ReadonlyMap<string, PhoneFactoryIcon> {
  const ordered = inMacOrder(factories)
  const colors = factoryColors(ordered)
  return new Map(ordered.map((f) => [f.id, iconFor(f, colors.get(f.id) ?? 'blue')]))
}

export function phoneFactoryImage(
  factories: readonly PhoneIconFactory[],
  factoryId: string,
): PhoneOutcome {
  const factory = factories.find((f) => f.id === factoryId)
  if (factory === undefined) return { code: 'gone' }
  if (factory.icon?.kind !== 'image') {
    return { code: 'refused', message: 'This Factory has no image icon.' }
  }
  const body = { dataUrl: factory.icon.dataUrl, version: imageVersion(factory.icon.dataUrl) }
  if (jsonBytes(body) > phoneReplyBodyMax) {
    return { code: 'refused', message: 'This Factory’s image is too large to send to a phone.' }
  }
  return { body }
}
