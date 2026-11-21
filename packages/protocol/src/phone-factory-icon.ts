import {
  type FactoryIconColor,
  type FactoryIconSymbol,
  factoryIconColors,
  factoryIconSymbols,
} from './factory-icon.ts'
import { reader, type Untyped } from './parse.ts'

export type PhoneFactoryIcon =
  | { kind: 'letter'; color: FactoryIconColor }
  | { kind: 'symbol'; symbol: FactoryIconSymbol; color: FactoryIconColor }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'image'; version: string }

export interface PhoneFactoryIconBody {
  dataUrl: string
  version: string
}

const read = reader()

export function parsePhoneFactoryIcon(value: Untyped): PhoneFactoryIcon {
  const object = read.object(value, 'icon')
  const kind = read.oneOf(object, 'kind', ['letter', 'symbol', 'emoji', 'image'])
  if (kind === 'emoji') return { kind, emoji: read.string(object, 'emoji') }
  if (kind === 'image') return { kind, version: read.string(object, 'version') }
  const color = read.oneOf(object, 'color', factoryIconColors)
  if (kind === 'letter') return { kind, color }
  return { kind, symbol: read.oneOf(object, 'symbol', factoryIconSymbols), color }
}

export function parsePhoneFactoryIconBody(value: Untyped): PhoneFactoryIconBody {
  const object = read.object(value, 'body')
  return { dataUrl: read.string(object, 'dataUrl'), version: read.string(object, 'version') }
}
