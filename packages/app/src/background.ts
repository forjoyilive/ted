import {
  type Activity,
  type Banner,
  type BannerSeverity,
  bannerOrder,
  type CommentKind,
  identity,
  isShowing,
  type QuitChoice,
  type RunCounts,
  type Task,
  type WaitingRequest,
  workRunning,
} from '@ted/protocol'

export const appName = identity().name

export type MenuCommand =
  | { kind: 'open-inbox' }
  | { kind: 'open-inbox-request'; taskId: string; factoryId: string; requestId: string }
  | { kind: 'open-all-tasks' }
  | { kind: 'open-dashboard' }
  | { kind: 'open-ted' }
  | { kind: 'new-task' }
  | { kind: 'settings'; section?: string }
  | { kind: 'banner'; bannerId: string }
  | { kind: 'open-task'; taskId: string; factoryId: string }
  | { kind: 'restart-to-update' }
  | { kind: 'shortcuts' }
  | { kind: 'report-problem' }
  | { kind: 'quit' }

export type MenuRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'close'
  | 'minimize'
  | 'zoom'
  | 'editMenu'
  | 'windowMenu'
  | 'help'

export type MenuEntry =
  | { type: 'separator' }
  | {
      type: 'item'
      label: string
      enabled: boolean
      command?: MenuCommand
      accelerator?: string
      dot?: BannerSeverity
    }
  | { type: 'role'; role: MenuRole }
  | { type: 'submenu'; label: string; role?: MenuRole; submenu: MenuEntry[] }

export interface MenuState {
  activity: Activity
  waiting: number
  banners: readonly Banner[]
  updateReady?: string
}

export type Platform = 'darwin' | 'linux' | 'win32'

const separator: MenuEntry = { type: 'separator' }

const item = (label: string, command?: MenuCommand, accelerator?: string): MenuEntry => ({
  type: 'item',
  label,
  enabled: command !== undefined,
  ...(command && { command }),
  ...(accelerator !== undefined && { accelerator }),
})

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

function waitingLabel(count: number): string {
  return count === 0 ? 'Nothing waiting on you' : `${count} waiting on you`
}

function runsLabel({ working, active, queued }: RunCounts): string {
  const runs =
    active === 0
      ? 'No unfinished Runs'
      : `${working} working · ${active} unfinished ${plural(active, 'Run', 'Runs')}`
  return queued === 0 ? runs : `${runs} · ${queued} queued`
}

function appWideProblems(banners: readonly Banner[], now: Date): Banner[] {
  return banners.filter((b) => b.factoryId === undefined && isShowing(b, now)).sort(bannerOrder)
}

function sections(...groups: MenuEntry[][]): MenuEntry[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, i) => [...(i === 0 ? [] : [separator]), ...group])
}

const openTed = () => item('Open TED', { kind: 'open-ted' })
const newTask = () => item('New Task…', { kind: 'new-task' }, 'CmdOrCtrl+N')
const settings = () => item('Settings…', { kind: 'settings' }, 'CmdOrCtrl+,')
const quit = () => item('Quit TED completely', { kind: 'quit' }, 'CmdOrCtrl+Q')
const go = (): MenuEntry => ({
  type: 'submenu',
  label: 'Go',
  submenu: [
    item('Inbox', { kind: 'open-inbox' }, 'CmdOrCtrl+Shift+I'),
    item('All Tasks', { kind: 'open-all-tasks' }, 'CmdOrCtrl+Shift+A'),
    item('Dashboard', { kind: 'open-dashboard' }, 'CmdOrCtrl+Shift+D'),
  ],
})
const help = (): MenuEntry => ({
  type: 'submenu',
  label: 'Help',
  role: 'help',
  submenu: [
    item('Keyboard shortcuts', { kind: 'shortcuts' }, 'CmdOrCtrl+/'),
    item('Report a problem', { kind: 'report-problem' }),
  ],
})

function statusLines(
  { activity, waiting, banners, updateReady }: MenuState,
  now: Date,
): MenuEntry[][] {
  return [
    [item(waitingLabel(waiting), { kind: 'open-inbox' }), item(runsLabel(activity.runs))],
    appWideProblems(banners, now).map((b) => ({
      type: 'item',
      label: b.text,
      enabled: true,
      command: { kind: 'banner', bannerId: b.id },
      dot: b.severity,
    })),
    updateReady === undefined
      ? []
      : [item(`Restart to update to ${updateReady}`, { kind: 'restart-to-update' })],
  ]
}

export function statusMenu(state: MenuState, now: Date = new Date()): MenuEntry[] {
  return sections(...statusLines(state, now), [openTed(), newTask(), settings()], [quit()])
}

const role = (name: MenuRole): MenuEntry => ({ type: 'role', role: name })

export function appMenu(platform: Platform, state: MenuState, now: Date = new Date()): MenuEntry[] {
  const edit: MenuEntry = { type: 'submenu', label: 'Edit', role: 'editMenu', submenu: [] }
  if (platform !== 'darwin') {
    return [
      { type: 'submenu', label: appName, submenu: statusMenu(state, now) },
      edit,
      go(),
      help(),
    ]
  }
  return [
    {
      type: 'submenu',
      label: appName,
      submenu: [
        role('about'),
        separator,
        settings(),
        separator,
        role('services'),
        separator,
        role('hide'),
        role('hideOthers'),
        role('unhide'),
        separator,
        quit(),
      ],
    },
    {
      type: 'submenu',
      label: 'File',
      submenu: [newTask(), separator, role('close')],
    },
    edit,
    go(),
    {
      type: 'submenu',
      label: 'Window',
      role: 'windowMenu',
      submenu: sections(...statusLines(state, now), [openTed()], [role('minimize'), role('zoom')]),
    },
    help(),
  ]
}

export function trayLabel(waiting: number): string {
  return waiting > 0 ? String(waiting) : ''
}

export function trayWarning(banners: readonly Banner[], now: Date = new Date()): boolean {
  return appWideProblems(banners, now).length > 0
}

export function windowTitle(platform: Platform, waiting: number): string {
  return platform === 'linux' && waiting > 0 ? `${appName} (${waiting})` : appName
}

export function trayToolTip(waiting: number): string {
  return waiting > 0 ? `${appName} · ${waiting} waiting on you` : appName
}

export function dockBadge(waiting: number): string {
  return waiting > 0 ? String(waiting) : ''
}

export type QuitPlan = 'ask' | 'keep-running' | 'stop'

export function quitPlan(activity: Activity, choice: QuitChoice): QuitPlan {
  if (!workRunning(activity)) return 'stop'
  return choice
}

export interface QuitDialog {
  title: string
  message: string
  buttons: string[]
  defaultId: number
  cancelId: number
  checkboxLabel: string
}

function quitQuestion({
  startingWork = 0,
  scheduledTasks = 0,
  runs,
  automationsOn,
  factoriesSettingUp,
  shellsRunning,
}: Activity): string {
  if (runs.active > 0 || runs.queued > 0 || startingWork > 0) {
    const parts: string[] = []
    if (runs.active > 0)
      parts.push(
        `${runs.active} unfinished ${plural(runs.active, 'Run', 'Runs')}, including Runs that are idle, waiting or paused.`,
      )
    if (runs.queued > 0)
      parts.push(`${runs.queued} queued ${plural(runs.queued, 'item', 'items')} waiting to start.`)
    if (startingWork > 0)
      parts.push(
        `${startingWork} work ${plural(startingWork, 'item', 'items')} starting or setting up.`,
      )
    if (scheduledTasks > 0)
      parts.push(
        `${scheduledTasks} ${plural(scheduledTasks, 'Task is', 'Tasks are')} scheduled to start.`,
      )
    if (automationsOn > 0)
      parts.push(
        `${automationsOn} ${plural(automationsOn, 'Automation is', 'Automations are')} on.`,
      )
    if (factoriesSettingUp > 0)
      parts.push(
        `${factoriesSettingUp} ${plural(factoriesSettingUp, 'Factory is', 'Factories are')} still cloning.`,
      )
    if (shellsRunning > 0)
      parts.push(
        `${shellsRunning} ${plural(shellsRunning, 'Task shell is', 'Task shells are')} open.`,
      )
    return `${parts.join(' ')} Keep TED running in the background?`
  }
  if (scheduledTasks > 0) {
    return `${scheduledTasks} ${plural(scheduledTasks, 'Task is', 'Tasks are')} scheduled to start${automationsOn > 0 || factoriesSettingUp > 0 || shellsRunning > 0 ? ', with other work still going' : ''}. Keep TED running in the background so scheduled Tasks can start?`
  }
  const automationPart = `${automationsOn} ${plural(automationsOn, 'Automation is', 'Automations are')} on`
  if (automationsOn === 0 && factoriesSettingUp === 0 && shellsRunning > 0) {
    return `${shellsRunning} ${plural(shellsRunning, 'Task shell is', 'Task shells are')} open. Keep TED running in the background so ${plural(shellsRunning, 'it keeps', 'they keep')} going?`
  }
  if (automationsOn === 0) {
    return `${factoriesSettingUp} ${plural(factoriesSettingUp, 'Factory is', 'Factories are')} still cloning. Keep TED running in the background so ${plural(factoriesSettingUp, 'it finishes', 'they finish')}?`
  }
  return `${automationPart}. Keep TED running in the background so ${plural(automationsOn, 'it fires', 'they fire')}?`
}

export function quitDialog(activity: Activity): QuitDialog {
  return {
    title: 'Quit TED?',
    message: quitQuestion(activity),
    buttons: ['Keep running in the background', 'Stop them and quit', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: 'Don’t ask again',
  }
}

export type QuitAnswer =
  | { action: 'keep-running' | 'stop'; remember?: Exclude<QuitChoice, 'ask'> }
  | { action: 'cancel' }

export function quitAnswer(response: number, dontAskAgain: boolean): QuitAnswer {
  const action = response === 0 ? 'keep-running' : response === 1 ? 'stop' : undefined
  if (action === undefined) return { action: 'cancel' }
  return dontAskAgain ? { action, remember: action } : { action }
}

export function closeNotice(
  platform: Platform,
  alreadyShown: boolean,
): { title: string; body: string } | undefined {
  if (platform !== 'linux' || alreadyShown) return undefined
  return {
    title: appName,
    body: `${appName} is still running in the background. Open it again from your app launcher.`,
  }
}

export interface ProblemNotice {
  title: string
  body: string
  opens: MenuCommand
}

export function problemNotice(banner: Banner): ProblemNotice | undefined {
  if (banner.severity !== 'stops-work') return undefined
  const place = banner.action?.opens
  const section = place?.kind === 'settings' ? place.section : banner.action?.section
  return {
    title: appName,
    body: banner.text,
    opens: section !== undefined ? { kind: 'settings', section } : { kind: 'open-ted' },
  }
}

const mergedNoticeWindowMs = 60_000

export function mergedNotice(task: Task, now: number): ProblemNotice | undefined {
  if ((task.stage !== 'done' && task.stage !== 'cleanup') || !task.merged || task.archived)
    return undefined
  if (now - Date.parse(task.merged.at) > mergedNoticeWindowMs) return undefined
  const { pullRequests } = task.merged
  return {
    title: `${task.displayId} merged`,
    body:
      pullRequests.length > 0
        ? `${task.title} · PR ${pullRequests.map((n) => `#${n}`).join(', ')}`
        : task.title,
    opens: { kind: 'open-task', taskId: task.id, factoryId: task.factoryId },
  }
}

const kindLabels: Record<CommentKind, string> = {
  note: 'Note',
  question: 'Question',
  round: 'Clarify round',
  review: 'Design review',
  signoff: 'Sign-off',
  permission: 'Permission',
  proposal: 'Proposal',
}

export function inboxNotice(request: WaitingRequest): ProblemNotice {
  if (request.source === 'task') {
    const label = request.failed ? 'FAILED' : kindLabels[request.kind]
    return {
      title: `${request.displayId} ${request.taskTitle}`,
      body: `${label}: ${request.headline}`,
      opens: {
        kind: 'open-inbox-request',
        taskId: request.taskId,
        factoryId: request.factoryId,
        requestId: request.id,
      },
    }
  }
  if (request.source === 'automation') {
    return {
      title: request.automationName,
      body: `Question: ${request.headline}`,
      opens: { kind: 'open-inbox' },
    }
  }
  if (request.source === 'coordinator') {
    return {
      title: 'Coordinator',
      body: `Confirm: ${request.headline}`,
      opens: { kind: 'open-inbox' },
    }
  }
  return {
    title: request.planTitle,
    body: `${kindLabels[request.kind]}: ${request.headline}`,
    opens: { kind: 'open-inbox' },
  }
}

export function tedStopsNotice(count: number): ProblemNotice {
  return {
    title: appName,
    body: `${count} ${plural(count, 'Task was', 'Tasks were')} working when TED quit. Open TED to restart ${plural(count, 'it', 'them')}.`,
    opens: { kind: 'open-ted' },
  }
}

export function foldedNotice(count: number): ProblemNotice {
  return { title: appName, body: `${count} new items in your Inbox`, opens: { kind: 'open-inbox' } }
}
