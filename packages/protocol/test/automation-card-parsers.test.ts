import { expect, test } from 'vitest'
import * as P from '../src/index.ts'
import type { JsonObject } from '../src/parse.ts'
import { rejects, roundTrip } from './parser-cases.ts'

const schedule = { kind: 'weekdays', at: '08:00' } as const
const create = {
  name: 'Morning Linear intake',
  prompt: 'Import my new Linear issues into Backlog.',
  schedule,
  agent: 'claude',
  model: 'opus',
  effort: 'high',
  on: false,
  checkout: true,
  template: 'linear-intake',
} as const

test('parseAutomationDraftRequest keeps every field of a create draft', () => {
  expect(
    P.parseAutomationDraftRequest({ operation: 'op-1', kind: 'create', fields: create }),
  ).toEqual({ operation: 'op-1', kind: 'create', create })
})

test('parseAutomationDraftRequest turns Start the Tasks it creates off on a drafted check', () => {
  const check = { command: 'pnpm check', timeout: '2h', runBy: '07:00', agentStep: 'always' }
  expect(
    P.parseAutomationDraftRequest({
      operation: 'op-2',
      kind: 'create',
      fields: { name: 'Nightly', schedule, check: { ...check, startTasks: false } },
    }),
  ).toEqual({
    operation: 'op-2',
    kind: 'create',
    create: { name: 'Nightly', prompt: '', schedule, check: { ...check, startTasks: false } },
  })
})

test('parseAutomationDraftRequest keeps every field of a change and a delete', () => {
  const edit = {
    name: 'Renamed',
    prompt: 'New prompt',
    schedule,
    agent: 'codex',
    model: null,
    effort: null,
    on: true,
    checkout: false,
    check: { command: 'pnpm check', runBy: null, startTasks: false },
  } as const
  expect(
    P.parseAutomationDraftRequest({
      operation: 'op-3',
      kind: 'edit',
      automation: ' a1 ',
      fields: edit,
    }),
  ).toEqual({ operation: 'op-3', kind: 'edit', automation: 'a1', edit })
  expect(
    P.parseAutomationDraftRequest({ operation: 'op-4', kind: 'delete', automation: 'a1' }),
  ).toEqual({ operation: 'op-4', kind: 'delete', automation: 'a1' })
})

test('draftBody turns a parsed draft back into the body the route reads', () => {
  for (const body of [
    { operation: 'op-1', kind: 'create', fields: create },
    { operation: 'op-3', kind: 'edit', automation: 'a1', fields: { name: 'Renamed' } },
    { operation: 'op-4', kind: 'delete', automation: 'a1' },
  ]) {
    const parsed = P.parseAutomationDraftRequest(body)
    expect(P.parseAutomationDraftRequest(P.draftBody(parsed))).toEqual(parsed)
  }
})

const draft = (fields: JsonObject, kind = 'create') => ({
  operation: 'op',
  kind,
  ...(kind !== 'create' && { automation: 'a1' }),
  fields,
})
rejects(
  P.parseAutomationDraftRequest,
  draft({ name: 'N', schedule, check: { command: 'pnpm check', startTasks: true } }),
  'a draft can’t turn on Start the Tasks it creates',
)
rejects(
  P.parseAutomationDraftRequest,
  draft({ check: { command: 'pnpm check', startTasks: true } }, 'edit'),
  'a draft can’t turn on Start the Tasks it creates',
)
rejects(
  P.parseAutomationDraftRequest,
  draft({ ...create, factory: 'NB' }),
  'a draft is always for this chat’s Factory',
)
rejects(P.parseAutomationDraftRequest, draft({ ...create, runNow: true }), 'can’t run')
rejects(
  P.parseAutomationDraftRequest,
  draft({ ...create, name: 'n'.repeat(121) }),
  'name is limited to 120 characters',
)
rejects(
  P.parseAutomationDraftRequest,
  draft({ ...create, prompt: 'p'.repeat(8001) }),
  'prompt is limited to 8000 characters',
)
rejects(P.parseAutomationDraftRequest, draft({}, 'edit'), 'fields must change at least one')
rejects(
  P.parseAutomationDraftRequest,
  draft(create, 'rename'),
  'kind must be create, edit or delete',
)
rejects(
  P.parseAutomationDraftRequest,
  { operation: 'op', kind: 'delete', automation: 'a1', fields: {} },
  'a delete draft has no fields',
)
rejects(
  P.parseAutomationDraftRequest,
  { operation: 'op', kind: 'edit', fields: { name: 'N' } },
  'automation must name an Automation by ID',
)
rejects(
  P.parseAutomationDraftRequest,
  { operation: 'two words', kind: 'create', fields: create },
  'operation must be a unique ID',
)

roundTrip(P.parseAutomationCardAnswer, { decision: 'confirm', startTasks: true })
rejects(
  P.parseAutomationCardAnswer,
  { decision: 'cancel', startTasks: true },
  'startTasks goes only with confirm',
)
rejects(P.parseAutomationCardAnswer, { decision: 'yes' }, 'decision must be confirm or cancel')
