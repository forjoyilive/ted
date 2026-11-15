import { appendFileSync } from 'node:fs'
import {
  type Banner,
  factoryNotifications,
  type MachineSettings,
  type Task,
  type WaitingRequest,
} from '@ted/protocol'
import {
  foldedNotice,
  inboxNotice,
  mergedNotice,
  type ProblemNotice,
  problemNotice,
  tedStopsNotice,
} from './background.ts'

export interface ShownNotice {
  close(): void
}

export interface NoticeToShow {
  title: string
  body: string
  silent: boolean
}

export interface Notifier {
  show(notice: NoticeToShow, onClick: () => void): ShownNotice
  badge(count: number): void
}

export const foldWindowMs = 60_000
export const foldAfter = 3

export interface NotificationsOptions {
  notifier: Notifier
  settings: () => MachineSettings
  open: (notice: ProblemNotice) => void
  asksPermission: boolean
  asked: () => boolean
  markAsked: () => void
  offer: () => void
  factoryEmoji?: (factoryId: string) => string | undefined
  now?: () => number
}

export interface Notifications {
  waiting(requests: readonly WaitingRequest[]): void
  problem(banner: Banner): void
  merged(task: Task): void
  tedStops(count: number, windowHidden: boolean): void
  forget(): void
}

export type NotificationOffer = 'offered' | 'not-asked' | 'done'

export interface NotificationAsk {
  asked: boolean
  declined: boolean
}

export function notificationOffer(
  state: NotificationAsk,
  asksPermission: boolean,
  offered: boolean,
): NotificationOffer {
  if (!asksPermission || state.asked) return 'done'
  return offered && !state.declined ? 'offered' : 'not-asked'
}

export const notificationsOnNotice = {
  title: 'Notifications are on',
  body: 'TED will tell you when something needs you.',
}

export function createNotifications(options: NotificationsOptions): Notifications {
  const { notifier, settings, open, asksPermission, asked, markAsked, offer } = options
  const now = options.now ?? Date.now
  const withEmoji = (notice: ProblemNotice, factoryId: string): ProblemNotice => {
    const emoji = options.factoryEmoji?.(factoryId)
    return emoji === undefined ? notice : { ...notice, title: `${emoji} ${notice.title}` }
  }
  let seen: Set<string> | undefined
  const merged = new Set<string>()
  let recent: { at: number; shown?: ShownNotice }[] = []
  let folded: ShownNotice | undefined
  let stopsNotified = false

  const display = (notice: ProblemNotice) =>
    notifier.show({ title: notice.title, body: notice.body, silent: !settings().notifySound }, () =>
      open(notice),
    )

  function send(notice: ProblemNotice): void {
    const at = now()
    recent = recent.filter((entry) => at - entry.at < foldWindowMs)
    if (recent.length === 0) folded = undefined
    if (recent.length < foldAfter) {
      recent.push({ at, shown: display(notice) })
      return
    }
    recent.push({ at })
    for (const entry of recent) {
      entry.shown?.close()
      delete entry.shown
    }
    folded?.close()
    folded = display(foldedNotice(recent.length))
  }

  const mayNotify = () => !asksPermission || asked()

  return {
    waiting(requests) {
      const ids = new Set(requests.map((r) => r.id))
      const fresh = seen === undefined ? [] : requests.filter((r) => !seen?.has(r.id))
      seen = ids
      if (fresh.length > 0 && !asked()) {
        if (asksPermission) {
          offer()
          return
        }
        markAsked()
      }
      if (!settings().notifyInboxItems) return
      for (const request of fresh) {
        if (!request.uncounted) send(withEmoji(inboxNotice(request), request.factoryId))
      }
    },
    problem(banner) {
      const notice = problemNotice(banner)
      if (!notice || !settings().notifyProblems || !mayNotify()) return
      send(banner.factoryId === undefined ? notice : withEmoji(notice, banner.factoryId))
    },
    merged(task) {
      const notice = mergedNotice(task, now())
      if (!notice || merged.has(task.id)) return
      merged.add(task.id)
      const current = settings()
      if (!current.notifyTaskMerged || !mayNotify()) return
      if (!factoryNotifications(current, task.factoryId).taskMerged) return
      send(withEmoji(notice, task.factoryId))
    },
    tedStops(count, windowHidden) {
      if (count === 0) {
        stopsNotified = false
        return
      }
      if (!windowHidden || stopsNotified || !mayNotify()) return
      stopsNotified = true
      send(tedStopsNotice(count))
    },
    forget() {
      seen = undefined
    },
  }
}

export function recordingNotifier(file: string, onFailed: () => void, failing: boolean): Notifier {
  let lastBadge: number | undefined
  const write = (line: object) => appendFileSync(file, `${JSON.stringify(line)}\n`)
  return {
    show(notice) {
      write({ kind: 'notification', ...notice })
      if (failing) onFailed()
      return { close: () => write({ kind: 'closed', title: notice.title, body: notice.body }) }
    },
    badge(count) {
      if (count === lastBadge) return
      lastBadge = count
      write({ kind: 'badge', count })
    },
  }
}

export const silentNotifier: Notifier = {
  show: () => ({ close: () => undefined }),
  badge: () => undefined,
}
