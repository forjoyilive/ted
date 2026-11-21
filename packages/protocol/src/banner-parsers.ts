import type { BannerActionInput, BannerDismissInput } from './banner.ts'
import { reader, type Untyped } from './parse.ts'

export function parseBannerDismissInput(value: Untyped): BannerDismissInput {
  if (value === null) return {}
  const read = reader()
  const body = read.object(value, 'body')
  const raisedAt = read.optional(body, 'raisedAt', read.string)
  return raisedAt === undefined ? {} : { raisedAt }
}

export function parseBannerActionInput(value: unknown): BannerActionInput {
  const body = value as Partial<BannerActionInput> | null
  const folder = typeof body?.folder === 'string' ? body.folder : undefined
  return folder === undefined ? {} : { folder }
}
