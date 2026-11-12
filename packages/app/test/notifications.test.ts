import {
  type Banner,
  defaultMachineSettings,
  type MachineSettings,
  type Task,
  type WaitingRequest,
} from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import type { MenuCommand } from '../src/background.ts'
import { createNotifications, foldWindowMs, type NoticeToShow } from '../src/notifications.ts'
import { initialNavigation, navigate } from '../src/renderer/navigation.ts'
import { tedStopsText } from '../src/renderer/ted-stops.ts'

const request = (id: string, extra: Partial<WaitingRequest> = {}): WaitingRequest =>
  ({
    source: 'task',
    id,
    factoryId: 'nb',
    createdAt: '2026-11-09T10:00:00.000Z',
    headline: `Question ${id}`,
    kind: 'question',
    failed: false,
    taskId: `task-${id}`,
    displayId: 'NB-3',
    taskTitle: 'Add dark mode',
    ...extra,
  }) as WaitingRequest

const banner = (changes: Partial<Banner>): Banner => ({
  id: 'claude',
  problem: 'claude',
  severity: 'stops-work',
  text: 'Claude Code is signed out · 3 Runs paused',
  raisedAt: '2026-11-09T10:00:00.000Z',
  ...changes,
})

function harness(
  options: { settings?: Partial<MachineSettings>; asksPermission?: boolean; asked?: boolean } = {},
) {
  let clock = Date.parse('2026-11-09T10:00:00.000Z')
  let asked = options.asked ?? true
  const settings = { ...defaultMachineSettings, ...options.settings }
  const shown: { notice: NoticeToShow; open: () => void; closed: boolean }[] = []
  const opened: MenuCommand[] = []
  const notifications = createNotifications({
    notifier: {
      show(notice, onClick) {
        const entry = { notice, open: onClick, closed: false }
        shown.push(entry)
        return {
          close: () => {
            entry.closed = true
          },
        }
      },
      badge: () => undefined,
    },
    settings: () => settings,
    open: (notice) => opened.push(notice.opens),
    asksPermission: options.asksPermission ?? false,
    asked: () => asked,
    markAsked: () => {
      asked = true
    },
    now: () => clock,
  })
  return {
    notifications,
    shown,
    opened,
    visible: () => shown.filter((s) => !s.closed).map((s) => s.notice.body),
    settings,
    tick: (ms: number) => {
      clock += ms
    },
    asked: () => asked,
  }
}

describe('Inbox item notifications', () => {
  test('a new Inbox item sends one notification that opens its request in the Inbox; items already there don’t', () => {
    const { notifications, shown, opened } = harness()
    notifications.waiting([request('old')])
    expect(shown).toEqual([])

    notifications.waiting([request('old'), request('new', { kind: 'signoff', headline: 'Ready' })])
    notifications.waiting([request('old'), request('new', { kind: 'signoff', headline: 'Ready' })])

    expect(shown.map((s) => s.notice)).toEqual([
      { title: 'NB-3 Add dark mode', body: 'Sign-off: Ready', silent: true },
    ])
    shown[0]?.open()
    expect(opened).toEqual([
      { kind: 'open-inbox-request', taskId: 'task-new', factoryId: 'nb', requestId: 'new' },
    ])
  })

  test('a request that left the waiting list while snoozed notifies again when it returns', () => {
    const { notifications, shown } = harness()
    notifications.waiting([request('old'), request('later')])
    notifications.waiting([request('old')])
    expect(shown).toEqual([])
    notifications.waiting([request('old'), request('later')])
    expect(shown.map((s) => s.notice.body)).toEqual(['Question: Question later'])
  })

  test.each(['all-tasks', 'inbox'] as const)(
    'clicking a Task notification leaves %s for its request in the unanswered Inbox',
    (kind) => {
      const { notifications, shown, opened } = harness()
      notifications.waiting([])
      notifications.waiting([request('new')])
      shown[0]?.open()
      const command = opened[0]
      if (command?.kind !== 'open-inbox-request') throw new Error('Expected an Inbox destination')
      const before = navigate(initialNavigation, {
        type: 'open',
        screen: kind === 'inbox' ? { kind, factoryId: 'other', answered: true } : { kind },
      })
      const after = navigate(
        navigate(before, { type: 'open-settings', section: 'notifications' }),
        { ...command, type: 'open-inbox-request' },
      )
      expect(after.screen).toEqual({ kind: 'inbox' })
      expect(after.taskId).toBe('task-new')
      expect(after.requestId).toBe('new')
      expect(after.lastFactoryId).toBe('nb')
      expect(after.settings).toBeUndefined()
    },
  )

  test('FAILED asks, Automation questions and planning chat rounds notify too', () => {
    const { notifications, shown, opened } = harness()
    notifications.waiting([])
    notifications.waiting([
      request('f', { failed: true, headline: 'Task Lead stopped' }),
      {
        source: 'automation',
        id: 'q',
        factoryId: 'nb',
        createdAt: '',
        headline: 'Create NB tasks?',
        automationId: 'a',
        automationName: 'Daily triage',
      },
      {
        source: 'plan',
        id: 'p',
        factoryId: 'nb',
        createdAt: '',
        headline: 'Round 1',
        kind: 'round',
        planId: 'plan',
        planTitle: 'Split billing',
      },
    ])
    expect(shown.map((s) => [s.notice.title, s.notice.body])).toEqual([
      ['NB-3 Add dark mode', 'FAILED: Task Lead stopped'],
      ['Daily triage', 'Question: Create NB tasks?'],
      ['Split billing', 'Clarify round: Round 1'],
    ])
    shown[2]?.open()
    expect(opened).toEqual([{ kind: 'open-inbox' }])
  })

  test('four items within a minute fold into one notification, which opens the Inbox', () => {
    const { notifications, visible, shown, opened, tick } = harness()
    notifications.waiting([])
    const items: WaitingRequest[] = []
    for (const id of ['a', 'b', 'c', 'd']) {
      items.push(request(id))
      notifications.waiting([...items])
      tick(5_000)
    }
    expect(visible()).toEqual(['4 new items in your Inbox'])

    items.push(request('e'))
    notifications.waiting([...items])
    expect(visible()).toEqual(['5 new items in your Inbox'])
    shown.at(-1)?.open()
    expect(opened).toEqual([{ kind: 'open-inbox' }])

    tick(foldWindowMs)
    items.push(request('f'))
    notifications.waiting([...items])
    expect(visible()).toEqual(['5 new items in your Inbox', 'Question: Question f'])
  })

  test('three items within a minute each notify', () => {
    const { notifications, visible } = harness()
    notifications.waiting([])
    notifications.waiting([request('a'), request('b'), request('c')])
    expect(visible()).toEqual([
      'Question: Question a',
      'Question: Question b',
      'Question: Question c',
    ])
  })

  test('the Inbox items switch turns them off, and Play a sound turns the sound on', () => {
    const off = harness({ settings: { notifyInboxItems: false } })
    off.notifications.waiting([])
    off.notifications.waiting([request('a')])
    expect(off.shown).toEqual([])

    const loud = harness({ settings: { notifySound: true } })
    loud.notifications.waiting([])
    loud.notifications.waiting([request('a')])
    expect(loud.shown[0]?.notice.silent).toBe(false)
  })

  test('an uncounted request never notifies, not even once its Factory counts again', () => {
    const { notifications, shown } = harness()
    notifications.waiting([])
    notifications.waiting([request('quiet', { uncounted: true }), request('a')])
    expect(shown.map((s) => s.notice.body)).toEqual(['Question: Question a'])

    notifications.waiting([request('quiet'), request('a')])
    expect(shown).toHaveLength(1)
  })

  test('after a reconnect, the waiting requests are taken as already seen', () => {
    const { notifications, shown } = harness()
    notifications.waiting([])
    notifications.forget()
    notifications.waiting([request('a')])
    expect(shown).toEqual([])
  })
})

describe('problem notifications', () => {
  test('a stops-work problem notifies once when it starts and opens its Settings section', () => {
    const { notifications, shown, opened } = harness()
    notifications.problem(
      banner({ action: { label: 'Open', opens: { kind: 'settings', section: 'agents' } } }),
    )
    expect(shown.map((s) => s.notice.body)).toEqual(['Claude Code is signed out · 3 Runs paused'])
    shown[0]?.open()
    expect(opened).toEqual([{ kind: 'settings', section: 'agents' }])
  })

  test('warnings never notify', () => {
    const { notifications, shown } = harness()
    notifications.problem(banner({ severity: 'warning', text: 'Disk almost full' }))
    expect(shown).toEqual([])
  })

  test('the Problems that stop work switch turns them off', () => {
    const { notifications, shown } = harness({ settings: { notifyProblems: false } })
    notifications.problem(banner({}))
    expect(shown).toEqual([])
  })
})

describe('Task merged notifications', () => {
  const merged = {
    id: 't1',
    displayId: 'NB-3',
    title: 'Add dark mode',
    factoryId: 'nb',
    stage: 'done',
    merged: { at: '2026-11-09T10:00:00.000Z', pullRequests: [12] },
  } as unknown as Task

  test('are off by default', () => {
    const { notifications, shown } = harness()
    notifications.merged(merged)
    expect(shown).toEqual([])
  })

  test('when on, notify once per Task', () => {
    const { notifications, shown } = harness({
      settings: {
        notifyTaskMerged: true,
        factoryNotifications: { nb: { inboxItems: true, taskMerged: true } },
      },
    })
    notifications.merged(merged)
    notifications.merged(merged)
    expect(shown.map((s) => s.notice.title)).toEqual(['NB-3 merged'])
  })

  test('need both the app-wide switch and the Task’s Factory to be on', () => {
    const otherFactory = harness({
      settings: {
        notifyTaskMerged: true,
        factoryNotifications: { other: { inboxItems: true, taskMerged: true } },
      },
    })
    otherFactory.notifications.merged(merged)
    expect(otherFactory.shown).toEqual([])

    const switchOff = harness({
      settings: { factoryNotifications: { nb: { inboxItems: true, taskMerged: true } } },
    })
    switchOff.notifications.merged(merged)
    expect(switchOff.shown).toEqual([])
  })
})

describe('Tasks stopped when TED quit', () => {
  test('notify once while the window is hidden, and again only after the question was answered', () => {
    const { notifications, shown, opened } = harness()
    notifications.tedStops(2, false)
    expect(shown).toEqual([])

    notifications.tedStops(2, true)
    notifications.tedStops(2, true)
    expect(shown.map((s) => s.notice.body)).toEqual([
      '2 Tasks were working when TED quit. Open TED to restart them.',
    ])
    shown[0]?.open()
    expect(opened).toEqual([{ kind: 'open-ted' }])

    notifications.tedStops(0, true)
    notifications.tedStops(1, true)
    expect(shown.at(-1)?.notice.body).toBe(
      '1 Task was working when TED quit. Open TED to restart it.',
    )
    expect(shown).toHaveLength(2)
  })

  test('the dialog names the count, the button and what happens to the rest', () => {
    const all = tedStopsText({ count: 5, picked: 5, stoppedAt: '07:14', freeSlots: 4 })
    expect(all.heading).toBe('5 Tasks were working when TED quit')
    expect(all.lead).toContain('TED stopped their Task Leads at 07:14.')
    expect(all.restart).toBe('Restart all 5')
    expect(all.note).toBe('Tasks start in queue order as working slots free up.')

    const some = tedStopsText({ count: 5, picked: 3, stoppedAt: '07:14', freeSlots: 4 })
    expect(some.restart).toBe('Restart 3 Tasks')
    expect(some.note).toBe('2 stay stopped.')

    const one = tedStopsText({ count: 1, picked: 1, stoppedAt: '07:14', freeSlots: 4 })
    expect(one.heading).toBe('1 Task was working when TED quit')
    expect(one.restart).toBe('Restart')
    expect(one.note).toBeUndefined()
  })
})

describe('notification permission', () => {
  test('macOS is asked when the first Inbox item arrives, and nothing notifies before that', () => {
    const h = harness({ asksPermission: true, asked: false, settings: { notifyTaskMerged: true } })
    h.notifications.problem(banner({}))
    expect(h.shown).toEqual([])
    expect(h.asked()).toBe(false)

    h.notifications.waiting([])
    expect(h.asked()).toBe(false)
    h.notifications.waiting([request('a')])
    expect(h.asked()).toBe(true)
    expect(h.shown).toHaveLength(1)

    h.notifications.problem(banner({ id: 'offline', text: 'You’re offline' }))
    expect(h.shown).toHaveLength(2)
  })

  test('with Inbox items off, the first Inbox item still lets the other kinds notify', () => {
    const h = harness({ asksPermission: true, asked: false, settings: { notifyInboxItems: false } })
    h.notifications.waiting([])
    h.notifications.waiting([request('a')])
    expect(h.shown).toEqual([])
    expect(h.asked()).toBe(true)

    h.notifications.problem(banner({}))
    expect(h.shown).toHaveLength(1)
  })
})
