import type { AgentFileRow } from '@ted/protocol/agent-files'
import { blankAgentInstructions } from '@ted/protocol/agent-files'
import { expect, test } from 'vitest'
import {
  type AgentDraft,
  agentChangedFiles,
  agentChanges,
  agentDrafts,
  agentIdFrom,
  agentProblem,
  newAgentDraft,
  overrideDraft,
  resolvedChoice,
} from '../src/renderer/agent-files.ts'

const planner: AgentFileRow = {
  id: 'planner',
  name: 'Planner',
  powers: ['ask', 'propose_tasks', 'read_code'],
  from: 'ted',
  builtIn: true,
  inherited: {
    layer: 'ted',
    settings: { name: 'Planner', powers: ['ask', 'propose_tasks', 'read_code'] },
    instructions: '# Planner',
  },
}
const notes: AgentFileRow = {
  id: 'notes',
  name: 'Notes',
  powers: ['ask'],
  from: 'factory',
  builtIn: false,
  own: { settings: { name: 'Notes', powers: ['ask'] }, instructions: '# Notes' },
}

test('an override copies the inherited Agent, and a save sends only what changed', () => {
  const loaded = agentDrafts([planner, notes])
  expect(loaded).toEqual([
    { id: 'notes', settings: { name: 'Notes', powers: ['ask'] }, instructions: '# Notes' },
  ])
  const override = overrideDraft(planner)
  const draft: AgentDraft[] = [
    { ...override, settings: { ...override.settings, model: ' ' } },
    { id: 'notes', settings: { name: ' Notes ', powers: ['ask'] }, instructions: '# Notes' },
  ]
  expect(agentChanges(draft, loaded)).toEqual([
    {
      id: 'planner',
      settings: { name: 'Planner', powers: ['ask', 'propose_tasks', 'read_code'] },
      instructions: '# Planner',
    },
  ])
})

test('removing an Agent clears both of its files', () => {
  const loaded = agentDrafts([notes])
  const changes = agentChanges([], loaded)
  expect(changes).toEqual([{ id: 'notes', settings: null, instructions: null }])
  expect(agentChangedFiles(changes, '.ted/')).toEqual(['.ted/agents.yaml', '.ted/agents/notes.md'])
})

test('a new Agent starts from the Blank recipe with an id that is free', () => {
  const agent = newAgentDraft(['new-agent'])
  expect(agent).toEqual({
    id: 'new-agent-2',
    added: true,
    settings: { name: '', powers: [] },
    instructions: blankAgentInstructions,
  })
  expect(agentProblem(agent, [])).toBe('Give the Agent a name.')
  expect(agentProblem({ ...agent, settings: { name: 'Notes' } }, ['new-agent-2'])).toBe(
    'Another Agent already uses the id new-agent-2.',
  )
  expect(agentProblem({ ...agent, id: 'Bad Id', settings: { name: 'Notes' } }, [])).toMatch(
    /lowercase letters/,
  )
  expect(agentProblem({ ...agent, settings: { name: 'Notes' } }, [])).toBeUndefined()
  expect(agentIdFrom('  Release Notes — v2!  ')).toBe('release-notes-v2')
})

test('the editor shows the Provider and model a save resolves to', () => {
  const inherited = { name: 'Scout', agent: 'claude' as const, model: 'opus' }
  expect(resolvedChoice({ agent: 'codex' }, inherited)).toEqual({ agent: 'codex' })
  expect(resolvedChoice({ agent: 'claude' }, inherited)).toEqual({ agent: 'claude', model: 'opus' })
  expect(resolvedChoice({}, inherited)).toEqual({ agent: 'claude', model: 'opus' })
  expect(resolvedChoice({ agent: 'codex', model: 'gpt-5.5' }, inherited)).toEqual({
    agent: 'codex',
    model: 'gpt-5.5',
  })
  expect(resolvedChoice({ name: 'New' }, undefined)).toEqual({})
})

test('a save sends the commands trimmed, drops blank rows, and the editor names a bad command', () => {
  const loaded = agentDrafts([notes])
  const draft: AgentDraft[] = [
    {
      id: 'notes',
      settings: {
        name: 'Notes',
        powers: ['read_code', 'run_commands'],
        commands: [
          { name: ' test ', command: ' pnpm test ' },
          { name: 'web-lint', command: 'pnpm lint', repo: 'web' },
          { name: '', command: '' },
        ],
      },
      instructions: '# Notes',
    },
  ]
  expect(agentChanges(draft, loaded)).toEqual([
    {
      id: 'notes',
      settings: {
        name: 'Notes',
        powers: ['read_code', 'run_commands'],
        commands: [
          { name: 'test', command: 'pnpm test' },
          { name: 'web-lint', command: 'pnpm lint', repo: 'web' },
        ],
      },
    },
  ])
  const withCommands = (commands: { name: string; command: string }[]): AgentDraft => ({
    id: 'notes',
    settings: { name: 'Notes', commands },
    instructions: '# Notes',
  })
  expect(agentProblem(withCommands([{ name: 'Run Tests', command: 'x' }]), [])).toBe(
    '`Run Tests` isn’t a command name. Use lowercase letters, digits and hyphens.',
  )
  expect(
    agentProblem(
      withCommands([
        { name: 'test', command: 'a' },
        { name: 'test', command: 'b' },
      ]),
      [],
    ),
  ).toBe('Two commands are named test.')
  expect(agentProblem(withCommands([{ name: 'test', command: ' ' }]), [])).toBe(
    'Give the test command something to run.',
  )
  expect(agentProblem(withCommands([{ name: 'test', command: 'pnpm test' }]), [])).toBeUndefined()
})

test('the Release recipe starts with its powers and empty commands to fill in, and outside commands must be plain words', () => {
  const release = newAgentDraft(['release'], 'release')
  expect(release).toMatchObject({
    id: 'release-2',
    added: true,
    settings: {
      name: 'Release',
      powers: ['ask', 'read_code', 'run_commands', 'run_outside'],
      outsideCommands: [
        { name: 'build', command: '' },
        { name: 'publish', command: '' },
        { name: 'discard', command: '' },
      ],
    },
  })
  expect(release.instructions).toContain('ted agent run-outside publish')
  expect(agentProblem(release, [])).toBe('Give the check command something to run.')
  const filled: AgentDraft = {
    ...release,
    settings: {
      ...release.settings,
      commands: [{ name: 'check', command: 'pnpm lint' }],
      outsideCommands: [
        { name: 'build', command: 'pnpm release <version>' },
        { name: 'publish', command: 'pnpm release publish && git push' },
      ],
    },
  }
  expect(agentProblem(filled, [])).toBe(
    'The outside command publish has `&&`, which isn’t a plain word; outside commands take no quotes or shell characters.',
  )
  expect(
    agentChanges(
      [
        {
          ...filled,
          settings: {
            ...filled.settings,
            outsideCommands: [{ name: 'build', command: ' pnpm release <version> ' }],
          },
        },
      ],
      [],
    ),
  ).toMatchObject([
    { settings: { outsideCommands: [{ name: 'build', command: 'pnpm release <version>' }] } },
  ])
})
