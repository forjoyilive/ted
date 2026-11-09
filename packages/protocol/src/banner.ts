export const bannerSeverities = ['stops-work', 'warning'] as const

export type BannerSeverity = (typeof bannerSeverities)[number]

export type BannerPlace =
  | { kind: 'settings'; section?: string }
  | { kind: 'factory-settings'; factoryId: string }
  | { kind: 'task'; taskId: string }

export interface BannerAction {
  label: string
  opens?: BannerPlace
}

export interface Banner {
  id: string
  problem: string
  severity: BannerSeverity
  factoryId?: string
  text: string
  action?: BannerAction
  raisedAt: string
  dismissedUntil?: string
}

export interface BannerRef {
  problem: string
  factoryId?: string
  subject?: string
}

export interface RaiseBanner extends BannerRef {
  severity: BannerSeverity
  text: string
  action?: BannerAction
}

export const bannerDismissMs = 24 * 60 * 60 * 1000

export function bannerId({ problem, factoryId, subject }: BannerRef): string {
  return [problem, factoryId ?? 'app', ...(subject === undefined ? [] : [subject])].join(':')
}

export function isShowing(banner: Banner, now: Date = new Date()): boolean {
  return banner.dismissedUntil === undefined || Date.parse(banner.dismissedUntil) <= now.getTime()
}

export function bannerOrder(a: Banner, b: Banner): number {
  if (a.severity !== b.severity) return a.severity === 'stops-work' ? -1 : 1
  return b.raisedAt.localeCompare(a.raisedAt)
}
