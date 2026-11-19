// @vitest-environment jsdom
import type { BacklogStarts, FactoryLayout } from '@ted/protocol'
import { noBacklogStarts } from '@ted/protocol/backlog-starts'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import {
  BacklogStartsMenu,
  backlogStartsSummary,
  backlogStatus,
  startsAutomatically,
  startsOnItsOwn,
} from '../src/renderer/components/BacklogStarts.tsx'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { factory, task } from './support/fixtures.ts'

const factories = [
  factory({ id: 'a', name: 'Ted', position: 0 }),
  factory({ id: 'b', name: 'Mobius', position: 1 }),
  factory({ id: 'c', name: 'Personal site', position: 2 }),
]
const layout: FactoryLayout = {
  items: [
    { group: { id: 'g1', name: 'Kriya Design', factoryIds: ['a', 'b'] } },
    { factoryId: 'c' },
  ],
}
const on = (changes: Partial<BacklogStarts> = {}): BacklogStarts => ({
  ...noBacklogStarts,
  enabled: true,
  ...changes,
})

test('the summary names what takes part, and says Off or counts when there are many', () => {
  expect(backlogStartsSummary(noBacklogStarts, factories, layout)).toBe('Off')
  expect(backlogStartsSummary(on({ all: true }), factories, layout)).toBe('All Factories')
  expect(backlogStartsSummary(on(), factories, layout)).toBe('No Factories chosen')
  expect(
    backlogStartsSummary(on({ groupIds: ['g1'], factoryIds: ['a', 'c'] }), factories, layout),
  ).toBe('Kriya Design, Personal site')
  const many = [
    ...factories,
    factory({ id: 'd', name: 'Acme', position: 3 }),
    factory({ id: 'e', name: 'Northwind', position: 4 }),
  ]
  expect(
    backlogStartsSummary(on({ groupIds: ['g1'], factoryIds: ['c', 'd', 'e'] }), many, layout),
  ).toBe('1 group, 3 Factories')
})

test('a Backlog row says it starts automatically only when nothing else holds it', () => {
  const starts = startsAutomatically(on({ groupIds: ['g1'] }), layout)
  const backlog = task({ factoryId: 'a', stage: 'backlog' })
  expect(startsOnItsOwn(backlog, starts)).toBe(true)
  expect(startsOnItsOwn({ ...backlog, factoryId: 'c' }, starts)).toBe(false)
  expect(startsOnItsOwn({ ...backlog, blockedBy: ['x'] }, starts)).toBe(true)
  expect(startsOnItsOwn({ ...backlog, blockedBy: ['x'], openBlockers: ['DEV-1'] }, starts)).toBe(
    false,
  )
  expect(startsOnItsOwn({ ...backlog, statuses: ['stopped'] }, starts)).toBe(false)
  expect(startsOnItsOwn({ ...backlog, statuses: ['failed'] }, starts)).toBe(false)
  expect(startsOnItsOwn({ ...backlog, snoozedUntil: '2026-11-20T09:00:00.000Z' }, starts)).toBe(
    false,
  )
  expect(startsOnItsOwn({ ...backlog, backlogWait: 'task-lead' }, starts)).toBe(false)
  expect(startsOnItsOwn({ ...backlog, stage: 'work' }, starts)).toBe(false)
})

test('a Backlog row Ted won’t start says why, and the rest say they start or show nothing', () => {
  const starts = startsAutomatically(on({ groupIds: ['g1'] }), layout)
  const backlog = task({ factoryId: 'a', stage: 'backlog' })
  expect(backlogStatus(backlog, starts)).toEqual({ label: 'Starts automatically' })
  expect(backlogStatus({ ...backlog, factoryId: 'c' }, starts)).toBeUndefined()
  expect(
    (['task-lead', 'automation', 'follow-up', 'start-failed', 'repo'] as const).map((backlogWait) =>
      backlogStatus({ ...backlog, backlogWait }, starts),
    ),
  ).toEqual([
    {
      label: 'Filed by a Task Lead',
      hint: 'Turn on “Include agent-filed Tasks” or start it yourself.',
    },
    {
      label: 'From an Automation',
      hint: 'Turn on “Include agent-filed Tasks” or start it yourself.',
    },
    {
      label: 'Follow-up of a follow-up',
      hint: 'Agents’ follow-ups of follow-ups always start by hand.',
    },
    { label: 'Auto-start failed', hint: 'Start it yourself to see the error.' },
    { label: 'Waiting for the repo', hint: 'Ted is still cloning this Factory’s repo.' },
  ])
})

test('the menu saves the switch and each choice at once, a choice made while off stays off, and a ticked group covers its Factories', async () => {
  const saved: BacklogStarts[] = []
  const api = bridge({
    setBacklogStarts: (starts) => {
      saved.push(starts as BacklogStarts)
      return defaultMachineSettings
    },
  })
  const { rerender } = render(
    <BacklogStartsMenu starts={noBacklogStarts} factories={factories} layout={layout} />,
  )
  const list = () => screen.getByRole('radiogroup', { name: 'Start from' })
  expect(
    screen.getByRole<HTMLButtonElement>('switch', { name: 'Include agent-filed Tasks' }).disabled,
  ).toBe(true)
  await user().click(screen.getByRole('checkbox', { name: /Personal site/ }))
  expect(saved.at(-1)).toEqual({ ...noBacklogStarts, factoryIds: ['c'] })
  const toggle = screen.getByRole<HTMLButtonElement>('switch', {
    name: 'Start Backlog Tasks automatically',
  })
  await waitFor(() => expect(toggle.disabled).toBe(false))
  await user().click(toggle)
  expect(saved.at(-1)).toEqual(on())

  rerender(<BacklogStartsMenu starts={on()} factories={factories} layout={layout} />)
  const include = screen.getByRole<HTMLButtonElement>('switch', {
    name: 'Include agent-filed Tasks',
  })
  await waitFor(() => expect(include.disabled).toBe(false))
  await user().click(include)
  expect(saved.at(-1)).toEqual(on({ includeAgentFiled: true }))
  await waitFor(() => expect(include.disabled).toBe(false))
  const group = within(screen.getByRole('group', { name: 'Kriya Design' }))
  await user().click(group.getByRole('checkbox', { name: /Kriya Design/ }))
  expect(saved.at(-1)).toEqual(on({ groupIds: ['g1'] }))

  rerender(
    <BacklogStartsMenu starts={on({ groupIds: ['g1'] })} factories={factories} layout={layout} />,
  )
  const ted = within(
    screen.getByRole('group', { name: 'Kriya Design' }),
  ).getByRole<HTMLInputElement>('checkbox', { name: /^Ted/ })
  expect(ted.checked).toBe(true)
  expect(ted.disabled).toBe(true)
  await user().click(screen.getByRole('checkbox', { name: /Personal site/ }))
  expect(saved.at(-1)).toEqual(on({ groupIds: ['g1'], factoryIds: ['c'] }))

  await user().click(within(list()).getByRole('radio', { name: 'All Factories' }))
  expect(saved.at(-1)).toEqual(on({ groupIds: ['g1'], all: true }))
  expect(api.request.mock.calls.filter(([name]) => name === 'setBacklogStarts')).toHaveLength(6)
})

test('the menu disables the switch and scope buttons while saving, keeps them usable after a failed save and shows why', async () => {
  const pending = deferred<never>()
  bridge({ setBacklogStarts: () => pending.promise })
  render(<BacklogStartsMenu starts={noBacklogStarts} factories={factories} layout={layout} />)
  const toggle = screen.getByRole<HTMLButtonElement>('switch', {
    name: 'Start Backlog Tasks automatically',
  })
  await user().click(toggle)
  expect(toggle.disabled).toBe(true)
  const scope = within(screen.getByRole('radiogroup', { name: 'Start from' }))
  const scopes = scope.getAllByRole<HTMLInputElement>('radio')
  expect(scopes.map((radio) => radio.disabled)).toEqual([true, true])
  await act(async () => pending.reject(new Error('Couldn’t save')))
  expect(scopes.map((radio) => radio.disabled)).toEqual([false, false])
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t save')
  expect(toggle.disabled).toBe(false)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

test('Settings → General and the All Tasks header change the same choice', async () => {
  const a = appState()
  a.state.factories = factories
  a.state.layout = layout
  a.state.settings = { ...a.state.settings, backlogStarts: on({ factoryIds: ['c'] }) }
  a.handle('setBacklogStarts', (starts) => {
    a.state.settings = { ...a.state.settings, backlogStarts: starts as BacklogStarts }
    a.emit({ type: 'settings-changed', settings: a.state.settings })
    return a.state.settings
  })
  a.mount()
  await a.settings()
  const group = within(await screen.findByRole('group', { name: 'Backlog starts' }))
  expect(
    group
      .getByRole('switch', { name: 'Start Backlog Tasks automatically' })
      .getAttribute('aria-checked'),
  ).toBe('true')
  expect(
    (await group.findByRole<HTMLInputElement>('checkbox', { name: /Personal site/ })).checked,
  ).toBe(true)
  await user().click(group.getByRole('checkbox', { name: /Kriya Design/ }))
  expect(a.state.settings.backlogStarts).toEqual(on({ groupIds: ['g1'], factoryIds: ['c'] }))

  await user().click(screen.getByRole('button', { name: /Back/ }))
  const nav = await screen.findByRole('navigation', { name: 'Sidebar' })
  await user().click(within(nav).getByRole('button', { name: /^All Tasks/ }))
  const header = await screen.findByRole('button', {
    name: 'Backlog starts: Kriya Design, Personal site',
  })
  await user().click(header)
  await user().click(screen.getByRole('switch', { name: 'Start Backlog Tasks automatically' }))
  expect(a.state.settings.backlogStarts.enabled).toBe(false)
  expect(await screen.findByRole('button', { name: 'Backlog starts: Off' })).toBeTruthy()
})
