import {
  type Activity,
  type Banner,
  type BannerSeverity,
  bannerOrder,
  isShowing,
  type QuitChoice,
  type RunCounts,
  workRunning,
} from '@ted/protocol'

export type MenuCommand =
  | { kind: 'open-inbox' }
  | { kind: 'open-ted' }
  | { kind: 'new-task' }
  | { kind: 'settings' }
  | { kind: 'banner'; bannerId: string }
  | { kind: 'restart-to-update' }
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
      ? 'No Runs working'
      : `${working} of ${active} ${plural(active, 'Run', 'Runs')} working`
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

function statusLines({ activity, banners, updateReady }: MenuState, now: Date): MenuEntry[][] {
  return [
    [
      item(waitingLabel(activity.waitingOnYou), { kind: 'open-inbox' }),
      item(runsLabel(activity.runs)),
    ],
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
    return [{ type: 'submenu', label: 'TED', submenu: statusMenu(state, now) }, edit]
  }
  return [
    {
      type: 'submenu',
      label: 'TED',
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
    {
      type: 'submenu',
      label: 'Window',
      role: 'windowMenu',
      submenu: sections(...statusLines(state, now), [openTed()], [role('minimize'), role('zoom')]),
    },
  ]
}

export function trayLabel(activity: Activity): string {
  return activity.waitingOnYou > 0 ? String(activity.waitingOnYou) : ''
}

export function trayWarning(banners: readonly Banner[], now: Date = new Date()): boolean {
  return appWideProblems(banners, now).length > 0
}

export function windowTitle(platform: Platform, waitingOnYou: number): string {
  return platform === 'linux' && waitingOnYou > 0 ? `TED (${waitingOnYou})` : 'TED'
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

function quitQuestion({ runs, automationsOn }: Activity): string {
  const count = runs.active + runs.queued
  const runPart = `${count} ${plural(count, 'Run is', 'Runs are')} still going`
  const automationPart = `${automationsOn} ${plural(automationsOn, 'Automation is', 'Automations are')} on`
  if (count > 0 && automationsOn > 0) {
    return `${runPart} and ${automationPart}. Keep TED running in the background?`
  }
  if (count > 0) {
    return `${runPart}. Keep TED running in the background so ${plural(count, 'it finishes', 'they finish')}?`
  }
  return `${automationPart}. Keep TED running in the background so ${plural(automationsOn, 'it fires', 'they fire')}?`
}

export function quitDialog(activity: Activity): QuitDialog {
  return {
    title: 'Quit TED?',
    message: quitQuestion(activity),
    buttons: ['Keep running', 'Stop them and quit', 'Cancel'],
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
    title: 'TED',
    body: 'TED is still running in the background. Open it again from your app launcher.',
  }
}
