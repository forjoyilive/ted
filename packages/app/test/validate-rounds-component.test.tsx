// @vitest-environment jsdom
import type { LibraryView, StageRowView } from '@ted/protocol'
import { render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import {
  type SettingsDraft,
  type StageDraft,
  settingsChanges,
  stageEdited,
  unsavedChanges,
} from '../src/renderer/factory-settings.ts'
import { libraryChanges, libraryDraft, unsavedLibrary } from '../src/renderer/library.ts'
import { ValidateRounds, WorkFailures } from '../src/renderer/views/FactorySettingsSections.tsx'
import { user } from './support/component.ts'

type Rounds = Pick<StageDraft, 'p1OnlyFrom' | 'subAgents'>

function Row({ initial, onStage }: { initial: Rounds; onStage: (fields: Rounds) => void }) {
  const [stage, setStage] = useState(initial)
  return (
    <ValidateRounds
      stage={stage}
      onStage={(fields) => {
        onStage(fields)
        setStage({ ...stage, ...fields })
      }}
    />
  )
}

const select = () =>
  screen.getByRole('combobox', {
    name: 'Validate sends back only for P1 Findings',
  }) as HTMLSelectElement
const toggle = () => screen.getByRole('switch', { name: 'Other Sub-Agents in Validate' })

test('both Validate round settings start off and send what the human picks', async () => {
  const onStage = vi.fn()
  render(<Row initial={{ p1OnlyFrom: false, subAgents: false }} onStage={onStage} />)
  expect(select().value).toBe('off')
  expect(toggle().getAttribute('aria-checked')).toBe('false')

  await user().selectOptions(select(), 'From round 3')
  expect(onStage).toHaveBeenLastCalledWith({ p1OnlyFrom: 3 })
  expect(select().value).toBe('3')
  await user().selectOptions(select(), 'Off')
  expect(onStage).toHaveBeenLastCalledWith({ p1OnlyFrom: false })

  await user().click(toggle())
  expect(onStage).toHaveBeenLastCalledWith({ subAgents: true })
  expect(toggle().getAttribute('aria-checked')).toBe('true')
})

test('a round set by hand above the listed ones is still shown', () => {
  render(<Row initial={{ p1OnlyFrom: 9, subAgents: true }} onStage={vi.fn()} />)
  expect(select().value).toBe('9')
  expect(screen.getByRole('option', { name: 'From round 9' })).toBeTruthy()
  expect(toggle().getAttribute('aria-checked')).toBe('true')
})

test('the help says what each setting trades', async () => {
  render(<Row initial={{ p1OnlyFrom: false, subAgents: false }} onStage={vi.fn()} />)
  const [p1, subAgents] = screen.getAllByRole('button', { name: 'Help' })
  if (!p1 || !subAgents) throw new Error('no help buttons')
  await user().hover(p1)
  expect(screen.getByRole('tooltip').textContent).toContain(
    'A Finding from an earlier round that is still not fixed sends it back too.',
  )
  expect(screen.getByRole('tooltip').textContent).toContain(
    'Every other new Finding stays unfixed and is listed as a note for you at Review.',
  )
  expect(screen.getByRole('tooltip').textContent).toContain(
    'problems Validate found can merge if you approve without reading the notes',
  )
  await user().hover(subAgents)
  expect(
    screen
      .getAllByRole('tooltip')
      .map((tip) => tip.textContent)
      .join('\n'),
  ).toContain('a sub-agent that reviews the diff adds Findings that can cost another round')
})

type Closes = Pick<StageDraft, 'leadClosesFailures'>

function Work({ onStage }: { onStage: (fields: Closes) => void }) {
  const [stage, setStage] = useState<Closes>({ leadClosesFailures: false })
  return (
    <WorkFailures
      stage={stage}
      onStage={(fields) => {
        onStage(fields)
        setStage(fields)
      }}
    />
  )
}

test('the Work setting starts off, sends what the human picks and says what it trades', async () => {
  const onStage = vi.fn()
  render(<Work onStage={onStage} />)
  const closes = screen.getByRole('switch', { name: 'Task Lead closes its own fixed failures' })
  expect(closes.getAttribute('aria-checked')).toBe('false')
  await user().click(closes)
  expect(onStage).toHaveBeenLastCalledWith({ leadClosesFailures: true })
  expect(closes.getAttribute('aria-checked')).toBe('true')
  await user().hover(screen.getByRole('button', { name: 'Help' }))
  expect(screen.getByRole('tooltip').textContent).toContain(
    'TED doesn’t run the test, so you are trusting the Task Lead’s report.',
  )
})

const validate: StageRowView = {
  id: 'validate',
  name: 'Validate',
  inOrder: true,
  enabled: true,
  gate: false,
  maxBack: 5,
  p1OnlyFrom: false,
  subAgents: false,
  from: 'ted',
}

const library: LibraryView = {
  path: '/home/library',
  version: 'v1',
  stages: [validate],
  agents: [],
  problems: [],
}

function edit(draft: SettingsDraft, fields: Rounds): SettingsDraft {
  const stage = draft.stages.validate
  if (!stage) throw new Error('no Validate row')
  return { ...draft, stages: { ...draft.stages, validate: { ...stage, ...fields } } }
}

test('a change to either setting is one Library change each, and none when put back', () => {
  const loaded = libraryDraft(library)
  expect(libraryChanges(libraryDraft(library), loaded)).toEqual({})

  const draft = edit(loaded, { p1OnlyFrom: 2, subAgents: true })
  expect(libraryChanges(draft, loaded)).toEqual({
    stages: { validate: { p1OnlyFrom: 2, subAgents: true } },
  })
  expect(unsavedLibrary(draft, loaded)).toBe(2)
  expect([...stageEdited(draft, loaded, 'validate')]).toEqual(['p1OnlyFrom', 'subAgents'])

  const back = edit(draft, { p1OnlyFrom: false, subAgents: false })
  expect(libraryChanges(back, loaded)).toEqual({})
})

test('turning a set round off sends false, and counts as a workflow.yaml change', () => {
  const loaded = libraryDraft({ ...library, stages: [{ ...validate, p1OnlyFrom: 3 }] })
  const draft = edit(loaded, { p1OnlyFrom: false })
  expect(settingsChanges(draft, loaded).stages).toEqual({ validate: { p1OnlyFrom: false } })
  expect(unsavedChanges(draft, loaded)).toEqual({ count: 1, files: ['.ted/workflow.yaml'] })
})
