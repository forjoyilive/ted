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
  now?: () => number
}

export interface Notifications {
  waiting(requests: readonly WaitingRequest[]): void
  problem(banner: Banner): void
  merged(task: Task): void
  forget(): void
}

export function createNotifications(options: NotificationsOptions): Notifications {
  const { notifier, settings, open, asksPermission, asked, markAsked } = options
  const now = options.now ?? Date.now
  let seen: Set<string> | undefined
  const merged = new Set<string>()
  let recent: { at: number; shown?: ShownNotice }[] = []
  let folded: ShownNotice | undefined

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
      if (fresh.length > 0 && !asked()) markAsked()
      if (!settings().notifyInboxItems) return
      for (const request of fresh) if (!request.uncounted) send(inboxNotice(request))
    },
    problem(banner) {
      const notice = problemNotice(banner)
      if (!notice || !settings().notifyProblems || !mayNotify()) return
      send(notice)
    },
    merged(task) {
      const notice = mergedNotice(task, now())
      if (!notice || merged.has(task.id)) return
      merged.add(task.id)
      const current = settings()
      if (!current.notifyTaskMerged || !mayNotify()) return
      if (!factoryNotifications(current, task.factoryId).taskMerged) return
      send(notice)
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
