import { type Activity, type Banner, noActivity, type Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  appMenu,
  closeNotice,
  dockBadge,
  type MenuEntry,
  mergedNotice,
  problemNotice,
  quitAnswer,
  quitDialog,
  quitPlan,
  statusMenu,
  trayLabel,
  trayToolTip,
  trayWarning,
  windowTitle,
} from '../src/background.ts'

const activity = (changes: Partial<Activity> & { working?: number; active?: number }) => ({
  ...noActivity,
  ...changes,
  runs: { working: changes.working ?? 0, active: changes.active ?? 0, queued: 0 },
})

const banner = (changes: Partial<Banner>): Banner => ({
  id: changes.problem ?? 'p',
  problem: 'p',
  severity: 'warning',
  text: 'Something',
  raisedAt: '2026-11-08T10:00:00.000Z',
  ...changes,
})

const now = new Date('2026-11-08T12:00:00.000Z')

const labels = (entries: MenuEntry[]) =>
  entries.map((e) => (e.type === 'separator' ? '—' : e.type === 'item' ? e.label : e.role))

describe('menu-bar menu', () => {
  test('lists the waiting count, Runs, app-wide problems, then the app’s commands, in order', () => {
    const entries = statusMenu(
      {
        activity: {
          ...activity({ working: 5, active: 6 }),
          runs: { working: 5, active: 6, queued: 2 },
        },
        waiting: 3,
        banners: [
          banner({ id: 'disk', problem: 'disk', text: 'Disk almost full · 8.2 GB free' }),
          banner({
            id: 'claude',
            problem: 'claude',
            severity: 'stops-work',
            text: 'Claude Code is signed out',
            raisedAt: '2026-11-08T09:00:00.000Z',
          }),
          banner({ id: 'nb', factoryId: 'nb', text: 'No Checks set up' }),
        ],
        updateReady: '1.4',
      },
      now,
    )

    expect(labels(entries)).toEqual([
      '3 waiting on you',
      '5 of 6 Runs working · 2 queued',
      '—',
      'Claude Code is signed out',
      'Disk almost full · 8.2 GB free',
      '—',
      'Restart to update to 1.4',
      '—',
      'Open TED',
      'New Task…',
      'Settings…',
      '—',
      'Quit TED completely',
    ])
  })

  test('each item opens the right place', () => {
    const entries = statusMenu(
      {
        activity: noActivity,
        waiting: 1,
        banners: [
          banner({ id: 'claude', severity: 'stops-work', text: 'Claude Code is signed out' }),
        ],
      },
      now,
    )
    const item = (label: string) =>
      entries.find(
        (e): e is Extract<MenuEntry, { type: 'item' }> => e.type === 'item' && e.label === label,
      )

    expect(item('1 waiting on you')).toMatchObject({
      command: { kind: 'open-inbox' },
      enabled: true,
    })
    expect(item('No Runs working')).toMatchObject({ enabled: false })
    expect(item('Claude Code is signed out')).toMatchObject({
      command: { kind: 'banner', bannerId: 'claude' },
      dot: 'stops-work',
    })
    expect(item('Open TED')).toMatchObject({ command: { kind: 'open-ted' } })
    expect(item('New Task…')).toMatchObject({
      command: { kind: 'new-task' },
      accelerator: 'CmdOrCtrl+N',
    })
    expect(item('Settings…')).toMatchObject({
      command: { kind: 'settings' },
      accelerator: 'CmdOrCtrl+,',
    })
    expect(item('Quit TED completely')).toMatchObject({
      command: { kind: 'quit' },
      accelerator: 'CmdOrCtrl+Q',
    })
  })

  test('leaves out problems and updates when there are none, and says when nothing waits', () => {
    expect(labels(statusMenu({ activity: noActivity, waiting: 0, banners: [] }, now))).toEqual([
      'Nothing waiting on you',
      'No Runs working',
      '—',
      'Open TED',
      'New Task…',
      'Settings…',
      '—',
      'Quit TED completely',
    ])
  })

  test('a dismissed warning stays off the menu and the icon until it comes back', () => {
    const dismissed = banner({ dismissedUntil: '2026-11-09T10:00:00.000Z' })
    const state = { activity: noActivity, waiting: 0, banners: [dismissed] }

    expect(labels(statusMenu(state, now))).not.toContain('Something')
    expect(trayWarning(state.banners, now)).toBe(false)
    expect(trayWarning(state.banners, new Date('2026-11-09T11:00:00.000Z'))).toBe(true)
  })

  test('Runs read in the singular and leave out an empty queue', () => {
    const labelFor = (a: Activity) =>
      labels(statusMenu({ activity: a, waiting: 0, banners: [] }, now))[1]

    expect(labelFor(activity({ working: 1, active: 1 }))).toBe('1 of 1 Run working')
    expect(labelFor(activity({ working: 0, active: 2 }))).toBe('0 of 2 Runs working')
    expect(labelFor({ ...noActivity, runs: { working: 0, active: 0, queued: 3 } })).toBe(
      'No Runs working · 3 queued',
    )
  })
})

describe('menu-bar icon and window title', () => {
  test('the icon shows the waiting count above zero and a dot only for app-wide banners', () => {
    expect(trayLabel(3)).toBe('3')
    expect(trayLabel(0)).toBe('')
    expect(trayWarning([banner({ factoryId: 'nb' })], now)).toBe(false)
    expect(trayWarning([banner({})], now)).toBe(true)
  })

  test('the window title names TED Dev and carries the count only on Linux', () => {
    expect(windowTitle('linux', 3)).toBe('TED Dev (3)')
    expect(windowTitle('linux', 0)).toBe('TED Dev')
    expect(windowTitle('darwin', 3)).toBe('TED Dev')
  })

  test('the menu-bar icon’s tooltip names TED Dev', () => {
    expect(trayToolTip(0)).toBe('TED Dev')
    expect(trayToolTip(2)).toBe('TED Dev · 2 waiting on you')
  })

  test('the Dock badge shows the waiting count, and nothing at zero', () => {
    expect(dockBadge(4)).toBe('4')
    expect(dockBadge(0)).toBe('')
  })
})

describe('the app menu holds every menu-bar item', () => {
  const state = {
    activity: activity({ working: 1, active: 1 }),
    waiting: 2,
    banners: [banner({ id: 'disk', text: 'Disk almost full' })],
  }
  const flatten = (entries: MenuEntry[]): MenuEntry[] =>
    entries.flatMap((e) => (e.type === 'submenu' ? flatten(e.submenu) : [e]))
  const commands = (entries: MenuEntry[]) =>
    flatten(entries).flatMap((e) => (e.type === 'item' ? [e.label] : []))

  test.each(['darwin', 'linux'] as const)('on %s', (platform) => {
    const menu = commands(appMenu(platform, state, now))

    for (const label of commands(statusMenu(state, now))) expect(menu).toContain(label)
  })

  test('on Linux, a TED menu holds the menu-bar items in the same order', () => {
    const [ted] = appMenu('linux', state, now)

    expect(ted).toMatchObject({ type: 'submenu', label: 'TED Dev' })
    if (ted?.type !== 'submenu') throw new Error('no TED menu')
    expect(labels(ted.submenu)).toEqual(labels(statusMenu(state, now)))
  })
})

describe('quitting', () => {
  const working = activity({ working: 1, active: 2 })

  test('scheduled Tasks count as background work and explain why TED should keep running', () => {
    const pending = activity({ scheduledTasks: 2 })
    expect(quitPlan(pending, 'ask')).toBe('ask')
    expect(quitDialog(pending).message).toContain('2 Tasks are scheduled to start')
    expect(quitPlan(pending, 'stop')).toBe('stop')
  })

  test('with nothing running, Quit ends TED without asking', () => {
    expect(quitPlan(noActivity, 'ask')).toBe('stop')
    expect(quitPlan(noActivity, 'keep-running')).toBe('stop')
  })

  test('with work running, Quit follows the remembered choice or asks', () => {
    expect(quitPlan(working, 'ask')).toBe('ask')
    expect(quitPlan(working, 'keep-running')).toBe('keep-running')
    expect(quitPlan(working, 'stop')).toBe('stop')
    expect(quitPlan(activity({ automationsOn: 1 }), 'ask')).toBe('ask')
  })

  test('the dialog defaults to keeping work running and offers Don’t ask again', () => {
    expect(quitDialog(working)).toEqual({
      title: 'Quit TED?',
      message: '2 Runs are still going. Keep TED running in the background so they finish?',
      buttons: ['Keep running', 'Stop them and quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: 'Don’t ask again',
    })
  })

  test('the dialog has the spec’s wording when only Automations are on', () => {
    expect(quitDialog(activity({ automationsOn: 2 })).message).toBe(
      '2 Automations are on. Keep TED running in the background so they fire?',
    )
    expect(quitDialog(activity({ automationsOn: 1 })).message).toBe(
      '1 Automation is on. Keep TED running in the background so it fires?',
    )
  })

  test('a Factory still cloning asks before quitting', () => {
    expect(quitPlan(activity({ factoriesSettingUp: 1 }), 'ask')).toBe('ask')
    expect(quitDialog(activity({ factoriesSettingUp: 1 })).message).toBe(
      '1 Factory is still cloning. Keep TED running in the background so it finishes?',
    )
  })

  test('an open Task shell asks before quitting', () => {
    expect(quitPlan(activity({ shellsRunning: 1 }), 'ask')).toBe('ask')
    expect(quitDialog(activity({ shellsRunning: 1 })).message).toBe(
      '1 Task shell is open. Keep TED running in the background so it keeps going?',
    )
    expect(quitDialog(activity({ shellsRunning: 2 })).message).toBe(
      '2 Task shells are open. Keep TED running in the background so they keep going?',
    )
  })

  test('the dialog names both when Runs and Automations are going', () => {
    expect(quitDialog(activity({ active: 1, automationsOn: 2 })).message).toBe(
      '1 Run is still going and 2 Automations are on. Keep TED running in the background?',
    )
  })

  test('each answer acts, and Don’t ask again remembers it unless it was Cancel', () => {
    expect(quitAnswer(0, false)).toEqual({ action: 'keep-running' })
    expect(quitAnswer(1, false)).toEqual({ action: 'stop' })
    expect(quitAnswer(2, false)).toEqual({ action: 'cancel' })
    expect(quitAnswer(0, true)).toEqual({ action: 'keep-running', remember: 'keep-running' })
    expect(quitAnswer(1, true)).toEqual({ action: 'stop', remember: 'stop' })
    expect(quitAnswer(2, true)).toEqual({ action: 'cancel' })
  })
})

describe('closing the window on Linux', () => {
  test('the first close says TED is still running, once', () => {
    expect(closeNotice('linux', false)).toEqual({
      title: 'TED Dev',
      body: 'TED Dev is still running in the background. Open it again from your app launcher.',
    })
    expect(closeNotice('linux', true)).toBeUndefined()
    expect(closeNotice('darwin', false)).toBeUndefined()
  })
})

describe('problem notifications', () => {
  test('a stops-work problem notifies once with its banner text and opens its Settings section', () => {
    expect(
      problemNotice(
        banner({
          severity: 'stops-work',
          text: 'Claude usage limit · resets 14:20 · 3 Runs paused',
          action: { label: 'Open', opens: { kind: 'settings', section: 'agents' } },
        }),
      ),
    ).toEqual({
      title: 'TED Dev',
      body: 'Claude usage limit · resets 14:20 · 3 Runs paused',
      opens: { kind: 'settings', section: 'agents' },
    })
    expect(
      problemNotice(banner({ severity: 'stops-work', text: 'You’re offline · 5 Runs paused' })),
    ).toMatchObject({ opens: { kind: 'open-ted' } })
  })

  test('warnings never notify', () => {
    expect(problemNotice(banner({ severity: 'warning' }))).toBeUndefined()
  })
})

describe('Task merged notifications', () => {
  const merged = (at: string, changes: Partial<Task> = {}) =>
    ({
      id: 't1',
      factoryId: 'f1',
      displayId: 'NB-28',
      title: 'Image paste in the editor',
      stage: 'done',
      merged: { at, pullRequests: [470, 88] },
      ...changes,
    }) as Task
  const now = Date.parse('2026-11-09T12:00:30Z')

  test('a Task that just reached Done notifies and opens the Task', () => {
    expect(mergedNotice(merged('2026-11-09T12:00:00Z'), now)).toEqual({
      title: 'NB-28 merged',
      body: 'Image paste in the editor · PR #470, #88',
      opens: { kind: 'open-task', taskId: 't1', factoryId: 'f1' },
    })
  })

  test('Tasks that merged a while ago, archived Tasks and unmerged Tasks don’t', () => {
    expect(mergedNotice(merged('2026-11-09T11:50:00Z'), now)).toBeUndefined()
    expect(
      mergedNotice(
        merged('2026-11-09T12:00:00Z', { archived: { at: '', ended: { kind: 'never-started' } } }),
        now,
      ),
    ).toBeUndefined()
    expect(
      mergedNotice(
        { ...merged('2026-11-09T12:00:00Z'), stage: 'merge', merged: undefined } as unknown as Task,
        now,
      ),
    ).toBeUndefined()
  })
})
