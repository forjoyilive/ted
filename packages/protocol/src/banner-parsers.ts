import type { BannerActionInput } from './banner.ts'

export function parseBannerActionInput(value: unknown): BannerActionInput {
  const body = value as Partial<BannerActionInput> | null
  const folder = typeof body?.folder === 'string' ? body.folder : undefined
  return folder === undefined ? {} : { folder }
}
