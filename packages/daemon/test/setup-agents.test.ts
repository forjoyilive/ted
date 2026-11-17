import type { SetupAgentProposal } from '@ted/protocol/setup-agents'
import { keptSetupAgents } from '@ted/protocol/setup-agents'
import { expect, test } from 'vitest'
import { setupAgentDifferences } from '../src/tasks/setup-agents.ts'
import { checkLayer } from '../src/workflow/check.ts'

const release: SetupAgentProposal = {
  id: 'release',
  name: 'Release helper',
  about: 'Cuts a release',
  powers: ['ask', 'read_code'],
  instructions: '# Release helper\n\nHelps cut a release.\n',
}

const checker: SetupAgentProposal = {
  id: 'checker',
  name: 'Checker',
  about: 'Runs the tests',
  powers: ['read_code', 'run_commands'],
  commands: [{ name: 'test', command: 'pnpm test' }],
  instructions: '# Checker\n',
}

const migrations: SetupAgentProposal = {
  id: 'migrations',
  name: 'Migrations',
  about: 'Plans migrations',
  powers: ['propose_tasks'],
  agent: 'codex',
  model: 'gpt-5',
  instructions: '# Migrations\n',
}

const layer = (files: Record<string, string>) => checkLayer({ kind: 'factory', files })

const written = {
  'agents.yaml': [
    'release:',
    '  name: Release helper',
    '  powers: [read_code, ask]',
    'migrations:',
    '  name: Migrations',
    '  agent: codex',
    '  model: gpt-5',
    '  powers: [propose_tasks]',
    '',
  ].join('\n'),
  'agents/release.md': '# Release helper\n\nHelps cut a release.\n\n',
  'agents/migrations.md': '# Migrations\n',
}

test('Agent files that match the approved Agents pass', () => {
  expect(layer(written).problems).toEqual([])
  expect(setupAgentDifferences([release, migrations], layer(written), [])).toEqual([])
  expect(setupAgentDifferences([], layer({}), [])).toEqual([])
})

test('a removed Agent left on the branch is refused', () => {
  const kept = keptSetupAgents([release, migrations], ['migrations'])
  expect(setupAgentDifferences(kept, layer(written), [])).toEqual([
    'migrations is on the branch but not in the approved proposal',
  ])
})

test('every way the files can differ from the approved Agents is named', () => {
  const changed = layer({
    'agents.yaml': [
      'release:',
      '  name: Releases',
      '  powers: [ask, read_code, manage_tasks]',
      'migrations:',
      '  name: Migrations',
      '  agent: claude',
      '  powers: [propose_tasks]',
      'extra:',
      '  name: Extra',
      '  powers: []',
      '',
    ].join('\n'),
    'agents/release.md': '# Release helper\n\nSomething else.\n',
    'agents/migrations.md': '# Migrations\n',
    'agents/extra.md': '# Extra\n',
  })
  expect(setupAgentDifferences([release, migrations], changed, [])).toEqual([
    'extra is on the branch but not in the approved proposal',
    'release’s name is “Releases”, not “Release helper”',
    'release’s powers are ask, manage_tasks, read_code, but the approved proposal gives ask, read_code',
    '.ted/agents/release.md differs from the approved instructions',
    'migrations’s Provider is “claude”, not “codex”',
    'migrations’s model is not set, not “gpt-5”',
  ])
})

test('Agent files with no approved Agents are refused', () => {
  expect(setupAgentDifferences([], layer(written), [])).toEqual([
    '.ted/agents.yaml is on the branch, but the approved proposal has no Agents',
    'migrations is on the branch but not in the approved proposal',
    'release is on the branch but not in the approved proposal',
  ])
  expect(setupAgentDifferences([release], layer({}), [])).toEqual([
    'release is approved but missing from .ted/agents.yaml',
  ])
})

test('a setup Agent can’t reuse an id an inherited layer defines', () => {
  expect(setupAgentDifferences([release], layer(written), ['coordinator', 'release'])).toEqual([
    'release is already defined in TED’s defaults or the Library; a setup Agent needs an id of its own',
    'migrations is on the branch but not in the approved proposal',
  ])
})

test('commands on the branch must be the approved commands', () => {
  const files = (commands: string[]) =>
    layer({
      'agents.yaml': [
        'checker:',
        '  name: Checker',
        '  powers: [read_code, run_commands]',
        ...commands,
        '',
      ].join('\n'),
      'agents/checker.md': '# Checker\n',
    })
  expect(
    setupAgentDifferences([checker], files(['  commands:', '    test: pnpm test']), []),
  ).toEqual([])
  expect(
    setupAgentDifferences(
      [checker],
      files(['  commands:', '    test: pnpm test', '    wipe: rm -rf .']),
      [],
    ),
  ).toEqual([
    'checker’s commands are test: pnpm test; wipe: rm -rf ., but the approved proposal gives test: pnpm test',
  ])
  expect(setupAgentDifferences([checker], files([]), [])).toEqual([
    'checker’s commands are none, but the approved proposal gives test: pnpm test',
  ])
  const joined: SetupAgentProposal = {
    ...checker,
    commands: [{ name: 'lint', command: 'x; test: pnpm test' }],
  }
  expect(
    setupAgentDifferences(
      [joined],
      files(['  commands:', '    lint: x', '    test: pnpm test']),
      [],
    ),
  ).toHaveLength(1)
})
