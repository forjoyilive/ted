export const bannerSeverities = ['stops-work', 'warning'] as const

export type BannerSeverity = (typeof bannerSeverities)[number]

export type BannerPlace =
  | { kind: 'settings'; section?: string }
  | { kind: 'factory-settings'; factoryId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'automation'; automationId: string; factoryId: string }

export interface BannerAction {
  label: string
  opens?: BannerPlace
  section?: string
  choose?: 'folder'
}

export interface BannerDismissInput {
  raisedAt?: string
}

export interface BannerActionInput {
  folder?: string
}

export interface Banner {
  id: string
  problem: string
  severity: BannerSeverity
  factoryId?: string
  text: string
  action?: BannerAction
  raisedAt: string
  dismissed?: boolean
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

export const repoAddedProblem = 'repo-added'

export function repoAddedText(repo: string): string {
  return `${repo} was added · Set up its checks and Apps with a setup Task`
}

const clearedOnDismiss: ReadonlySet<string> = new Set([repoAddedProblem])

export function dismissClears(banner: Pick<Banner, 'problem'>): boolean {
  return clearedOnDismiss.has(banner.problem)
}

export function bannerId({ problem, factoryId, subject }: BannerRef): string {
  return [problem, factoryId ?? 'app', ...(subject === undefined ? [] : [subject])].join(':')
}

export function isShowing(banner: Banner, now: Date = new Date()): boolean {
  return (
    !banner.dismissed &&
    (banner.dismissedUntil === undefined || Date.parse(banner.dismissedUntil) <= now.getTime())
  )
}

export function bannerOrder(a: Banner, b: Banner): number {
  if (a.severity !== b.severity) return a.severity === 'stops-work' ? -1 : 1
  return b.raisedAt.localeCompare(a.raisedAt)
}
