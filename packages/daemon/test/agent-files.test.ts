import { describe, expect, test } from 'vitest'
import { coordinatorInstructions } from '../src/coordinators/coordinators.ts'
import { promptGuidance } from '../src/guidance.ts'
import { plannerInstructions } from '../src/plans/prompts.ts'
import { resolveAgents } from '../src/workflow/agent-files.ts'
import { inheritedFrom } from '../src/workflow/check.ts'
import { driftCount, findAgentDrift } from '../src/workflow/drift.ts'
import {
  checkLayer,
  type LayerFiles,
  readDefaultLayer,
  resolveWorkflow,
} from '../src/workflow/index.ts'
import { stageFileHash } from '../src/workflow/layers.ts'

const problems = (files: LayerFiles) =>
  checkLayer({ kind: 'factory', files }).problems.map((p) =>
    [p.severity, p.file, p.line, p.column, p.message].join(' '),
  )

const off = promptGuidance({ aiDisclosure: false })

describe('Ted’s built-in Agents', () => {
  test('are the Coordinator and the Planner, with their powers and instructions files', async () => {
    const layer = await readDefaultLayer()
    expect(layer.problems).toEqual([])
    const workflow = resolveWorkflow([layer])

    expect(workflow.agents.map(({ instructions: _, ...agent }) => agent)).toEqual([
      {
        id: 'coordinator',
        name: 'Coordinator',
        powers: ['ask', 'manage_tasks', 'manage_automations', 'manage_agents'],
        source: 'ted',
        path: 'agents/coordinator.md',
      },
      {
        id: 'planner',
        name: 'Planner',
        powers: ['ask', 'propose_tasks', 'read_code'],
        source: 'ted',
        path: 'agents/planner.md',
      },
    ])
    expect(workflow.agent('coordinator')?.instructions).toMatch(/^# You are the Coordinator/)
    expect(workflow.agent('planner')?.instructions).toMatch(/^# You are the planner/)
  })

  test('chat prompts put the Agent’s instructions inside Ted’s own text', async () => {
    const workflow = resolveWorkflow([await readDefaultLayer()])
    const builtIn = workflow.agent('coordinator')
    const coordinator = coordinatorInstructions(
      builtIn?.instructions ?? '',
      builtIn?.powers ?? [],
      off,
    )
    expect(coordinator).toMatch(
      /^# You are the Coordinator for one Ted Factory\nHelp the human compare Tasks/,
    )
    expect(coordinator).toContain('Act only on a request from the human in THIS conversation.')

    const planner = plannerInstructions({
      role: 'Plan only the database changes.',
      powers: ['ask', 'propose_tasks', 'read_code'],
      guidance: off,
      factory: { id: 'f', name: 'Widgets', repo: 'acme/widgets' } as never,
      entries: [],
      folder: '/tmp/plan',
    })
    expect(planner).toMatch(/^Plan only the database changes\.\n\n## Write clearly/)
    expect(planner).toContain('This chat is in the Widgets Factory.')
    expect(planner).toContain('ted task propose --file <file>')
  })

  test('chat prompts ask for the AI disclosure line only when the setting is on', () => {
    const line = 'From Opus 5.5 via Ted:'
    expect(coordinatorInstructions('Watch.', [], promptGuidance({ aiDisclosure: true }))).toContain(
      line,
    )
    expect(
      coordinatorInstructions('Watch.', [], promptGuidance({ aiDisclosure: false })),
    ).not.toContain('via Ted:')
    const planner = (disclose: boolean) =>
      plannerInstructions({
        role: 'Plan.',
        powers: [],
        guidance: promptGuidance({ aiDisclosure: disclose }),
        factory: { id: 'f', name: 'Widgets', repo: 'acme/widgets' } as never,
        entries: [],
        folder: '/tmp/plan',
      })
    expect(planner(true)).toContain(line)
    expect(planner(false)).not.toContain('via Ted:')
  })

  test('a chat’s preamble lists only the commands its powers allow', () => {
    const role = 'Watch the releases.'
    const none = coordinatorInstructions(role, [], off)
    expect(none).toContain('You have no Ted commands in this chat.')
    for (const text of ['ted coordinator', 'ted ask', 'ted task propose', 'working folder'])
      expect(none).not.toContain(text)

    const manage = coordinatorInstructions(role, ['manage_tasks'], off)
    expect(manage).toContain('ted coordinator tasks')
    expect(manage).toContain('Start means Backlog to Queued')
    expect(manage).not.toContain('ted ask')
    expect(manage).not.toContain('ted coordinator automation')

    const automations = coordinatorInstructions(role, ['manage_automations'], off)
    expect(automations).toContain('ted coordinator automation draft --operation <unique-id>')
    expect(automations).toContain('You can never turn on “Start the Tasks it creates”')
    expect(automations).not.toContain('ted coordinator tasks')

    const ask = coordinatorInstructions(role, ['ask'], off)
    expect(ask).toContain('ted ask "<question>"')
    expect(ask).toContain('ted ask --round <file>')
    expect(ask).toContain('After you ask, end your turn')
    expect(ask).not.toContain('ted coordinator')
    expect(ask).not.toContain('ted task propose')

    const propose = coordinatorInstructions(role, ['propose_tasks'], off)
    expect(propose).toContain('ted task propose --file <file>')
    expect(propose).not.toContain('ted ask')

    const where =
      'Your working folder is a fresh checkout of acme/widgets at the latest base branch.'
    expect(coordinatorInstructions(role, ['read_code'], off, where)).toContain(where)
    expect(coordinatorInstructions(role, ['ask'], off, where)).not.toContain(where)

    const plannerWith = (powers: Parameters<typeof plannerInstructions>[0]['powers']) =>
      plannerInstructions({
        role: 'Plan.',
        powers,
        guidance: off,
        factory: { id: 'f', name: 'Widgets', repo: 'acme/widgets' } as never,
        entries: [],
        folder: '/tmp/plan',
      })
    const bare = plannerWith([])
    expect(bare).not.toContain('ted ask --round')
    expect(bare).not.toContain('ted task propose')
    expect(bare).not.toContain('fresh checkout')
    expect(plannerWith(['ask'])).toContain('ted ask --round')
    expect(plannerWith(['ask'])).not.toContain('ted task propose')
    expect(plannerWith(['propose_tasks'])).toContain('ted task propose')
  })

  test('a chat with Run commands in the copy lists ted agent run and its named commands', () => {
    const role = 'Review the change.'
    const where = 'Your working folder is a fresh checkout of acme/widgets.'
    const commands = [
      { name: 'test', command: 'pnpm vitest run\n  packages/protocol' },
      { name: 'web-lint', command: 'pnpm lint', repo: 'web' },
    ]
    const runs = coordinatorInstructions(role, ['read_code', 'run_commands'], off, where, commands)
    expect(runs).toContain('- ted agent run <name>: Ted runs one of the commands below')
    expect(runs).toContain('  - test: `pnpm vitest run packages/protocol`')
    expect(runs).toContain('  - web-lint (in web): `pnpm lint`')
    expect(runs).toContain('run repo code other than through ted agent run')
    expect(coordinatorInstructions(role, ['read_code'], off, where, commands)).not.toContain(
      'ted agent run',
    )
    expect(
      coordinatorInstructions(role, ['read_code', 'run_commands'], off, where, []),
    ).not.toContain('ted agent run')

    const planner = plannerInstructions({
      role: 'Plan.',
      powers: ['read_code', 'run_commands'],
      guidance: off,
      factory: { id: 'f', name: 'Widgets', repo: 'acme/widgets' } as never,
      entries: [],
      folder: '/tmp/plan',
      commands,
    })
    expect(planner).toContain('- ted agent run <name>')
    expect(planner).toContain('  - test: `pnpm vitest run packages/protocol`')
  })
})

describe('checking Agent files', () => {
  test('a new Agent with a name, powers and instructions is valid', () => {
    expect(
      problems({
        'agents.yaml':
          'reviewer-bot:\n  name: Reviewer\n  agent: codex\n  model: gpt-5.5\n  powers: [ask, read_code]\n',
        'agents/reviewer-bot.md': 'Review what the user points at.\n',
      }),
    ).toEqual([])
  })

  test('a description is one line of up to 140 characters and resolves onto the Agent', () => {
    const layer = checkLayer({
      kind: 'factory',
      files: {
        'agents.yaml': 'notes:\n  name: Notes\n  description: "  Drafts release notes.  "\n',
        'agents/notes.md': 'Write notes.\n',
      },
    })
    expect(layer.problems).toEqual([])
    expect(resolveAgents([layer]).find((a) => a.id === 'notes')?.description).toBe(
      'Drafts release notes.',
    )
    expect(
      problems({
        'agents.yaml': [
          'notes:',
          '  name: Notes',
          `  description: ${'x'.repeat(141)}`,
          'scout:',
          '  name: Scout',
          '  description: |',
          '    One line.',
          '    Another line.',
          '',
        ].join('\n'),
        'agents/notes.md': 'Write notes.\n',
        'agents/scout.md': 'Scout.\n',
      }),
    ).toEqual([
      'error .ted/agents.yaml 3 16 `notes.description` must be one line of text of up to 140 characters',
      'error .ted/agents.yaml 6 16 `scout.description` must be one line of text of up to 140 characters',
    ])
  })

  test('reports an unknown key, an unknown power, a missing name, a bad id and a missing instructions file', () => {
    expect(
      problems({
        'agents.yaml': [
          'helper:',
          '  powers: [ask, launch_missiles]',
          '  colour: blue',
          'Bad_Id:',
          '  name: Bad',
          'scout:',
          '  name: Scout',
          '  agent: gemini',
          '',
        ].join('\n'),
        'agents/helper.md': 'Help.\n',
      }),
    ).toEqual([
      'error .ted/agents.yaml 1 1 `helper` needs a `name`',
      'error .ted/agents.yaml 2 17 unknown power `launch_missiles` in `helper.powers`; the powers are ask, manage_tasks, manage_automations, propose_tasks, read_code, manage_agents, run_commands, run_outside',
      'error .ted/agents.yaml 3 3 unknown key `helper.colour`; an Agent has name, description, agent, model, powers, commands, outside_commands, based_on',
      'error .ted/agents.yaml 4 1 `Bad_Id` isn’t an Agent id; an Agent id is lowercase letters, digits and hyphens, up to 40 characters',
      'error .ted/agents.yaml 6 1 `scout` has no instructions file; add agents/scout.md',
      'error .ted/agents.yaml 8 10 `scout.agent` must be claude, codex, antigravity or pi',
    ])
  })

  test('the Planner can’t have Manage Tasks or Manage Automations: check reports it and resolving drops it', () => {
    const files = {
      'agents.yaml':
        'planner:\n  name: Planner\n  powers: [ask, manage_tasks, manage_automations]\n',
      'agents/planner.md': 'Plan.\n',
    }
    expect(problems(files)).toEqual([
      'error .ted/agents.yaml 1 1 `planner` can’t have `manage_tasks`; the Planner runs in a planning chat',
      'error .ted/agents.yaml 1 1 `planner` can’t have `manage_automations`; the Planner runs in a planning chat',
    ])
    expect(
      resolveAgents([
        {
          kind: 'factory',
          agentSettings: {
            planner: { name: 'Planner', powers: ['ask', 'manage_tasks', 'manage_automations'] },
          },
          agentFiles: { planner: 'Plan.\n' },
        },
      ])[0]?.powers,
    ).toEqual(['ask'])
  })

  test('named commands are a map of names to a command or to a command and a repo', () => {
    const files = {
      'agents.yaml': [
        'reviewer:',
        '  name: Reviewer',
        '  powers: [read_code, run_commands]',
        '  commands:',
        '    test: pnpm vitest run packages/protocol',
        '    web-lint:',
        '      command: pnpm lint',
        '      repo: web',
        '',
      ].join('\n'),
      'agents/reviewer.md': 'Review.\n',
    }
    expect(problems(files)).toEqual([])
    expect(
      resolveWorkflow([checkLayer({ kind: 'factory', files })]).agent('reviewer'),
    ).toMatchObject({
      powers: ['read_code', 'run_commands'],
      commands: [
        { name: 'test', command: 'pnpm vitest run packages/protocol' },
        { name: 'web-lint', command: 'pnpm lint', repo: 'web' },
      ],
    })
  })

  test('reports bad commands and Run commands in the copy without Read the code', () => {
    expect(
      problems({
        'agents.yaml': [
          'reviewer:',
          '  name: Reviewer',
          '  powers: [run_commands]',
          '  commands:',
          '    Bad_Name: pnpm test',
          '    empty: ""',
          '    odd:',
          '      command: pnpm test',
          '      shell: zsh',
          '    elsewhere:',
          '      command: pnpm test',
          '      repo: ../up',
          '',
        ].join('\n'),
        'agents/reviewer.md': 'Review.\n',
      }),
    ).toEqual([
      'error .ted/agents.yaml 1 1 `reviewer`: Run commands in the copy needs Read the code, because the commands run in the chat’s copy of the code',
      'error .ted/agents.yaml 5 5 `Bad_Name` isn’t a command name; a command name is lowercase letters, digits and hyphens, up to 40 characters',
      'error .ted/agents.yaml 6 12 `reviewer.commands.empty` must be a command of up to 2000 characters',
      'error .ted/agents.yaml 9 7 unknown key `reviewer.commands.odd.shell`; a command has command and repo',
      'error .ted/agents.yaml 12 13 `reviewer.commands.elsewhere.repo` must be a repo name',
    ])
    const many = Array.from({ length: 21 }, (_, i) => `    c${i}: echo ${i}`)
    expect(
      problems({
        'agents.yaml': ['scout:', '  name: Scout', '  commands:', ...many, ''].join('\n'),
        'agents/scout.md': 'Scout.\n',
      }),
    ).toEqual(['error .ted/agents.yaml 4 5 `scout.commands` has more than 20 commands'])
    expect(
      resolveAgents([
        {
          kind: 'factory',
          agentSettings: {
            scout: {
              name: 'Scout',
              powers: ['ask', 'run_commands'],
              commands: [{ name: 'test', command: 'pnpm test' }],
            },
          },
          agentFiles: { scout: 'Scout.\n' },
        },
      ])[0],
    ).toMatchObject({ powers: ['ask'], commands: [{ name: 'test', command: 'pnpm test' }] })
  })

  test('an instructions file no agents.yaml lists is ignored with a warning; an empty one is an error', () => {
    expect(
      problems({
        'agents.yaml': 'scout:\n  name: Scout\n',
        'agents/scout.md': '  \n',
        'agents/stray.md': 'Hello.\n',
      }),
    ).toEqual([
      'error .ted/agents/scout.md 1 1 the instructions file is empty',
      'warning .ted/agents/stray.md 1 1 No agents.yaml lists `stray`, so Ted ignores this file. Add `stray` to agents.yaml to use it.',
    ])
  })
})

describe('Agent layers', () => {
  test('a higher layer overrides the keys it names and the instructions it has; sources follow', async () => {
    const library = checkLayer({
      kind: 'library',
      files: {
        'agents.yaml':
          'coordinator:\n  powers: [manage_tasks]\n  agent: claude\n  model: opus\nscout:\n  name: Scout\n  agent: claude\n  model: opus\n',
        'agents/coordinator.md': 'Coordinate briefly.\n',
        'agents/scout.md': 'Scout the code.\n',
      },
    })
    const defaults = await readDefaultLayer()
    const factory = checkLayer({
      kind: 'factory',
      files: {
        'agents.yaml': 'scout:\n  name: Repo scout\n  powers: [read_code]\n  agent: codex\n',
      },
      inherited: inheritedFrom([defaults, library]),
    })
    expect([...library.problems, ...factory.problems]).toEqual([])
    const workflow = resolveWorkflow([defaults, library, factory])

    expect(workflow.agent('coordinator')).toMatchObject({
      name: 'Coordinator',
      powers: ['manage_tasks'],
      agent: 'claude',
      model: 'opus',
      instructions: 'Coordinate briefly.\n',
      source: 'library',
      path: 'agents/coordinator.md',
    })
    expect(workflow.agent('planner')).toMatchObject({ source: 'ted' })
    expect(workflow.agent('scout')).toMatchObject({
      name: 'Repo scout',
      powers: ['read_code'],
      instructions: 'Scout the code.\n',
      source: 'factory',
      path: 'agents/scout.md',
      agent: 'codex',
    })
    expect(workflow.agent('scout')?.model).toBeUndefined()
  })

  test('a layer’s commands replace the inherited commands as a whole', () => {
    const library = checkLayer({
      kind: 'library',
      files: {
        'agents.yaml':
          'scout:\n  name: Scout\n  powers: [read_code, run_commands]\n  commands:\n    test: pnpm test\n    lint: pnpm lint\n',
        'agents/scout.md': 'Scout.\n',
      },
    })
    const factory = checkLayer({
      kind: 'factory',
      files: { 'agents.yaml': 'scout:\n  commands:\n    check: pnpm check\n' },
      inherited: inheritedFrom([library]),
    })
    expect([...library.problems, ...factory.problems]).toEqual([])
    expect(resolveWorkflow([library]).agent('scout')?.commands).toHaveLength(2)
    expect(resolveWorkflow([library, factory]).agent('scout')).toMatchObject({
      powers: ['read_code', 'run_commands'],
      commands: [{ name: 'check', command: 'pnpm check' }],
    })
  })

  test('an override of a built-in Agent shows as drift once the built-in text changes', async () => {
    const defaults = await readDefaultLayer()
    const builtIn = defaults.agentFiles.planner ?? ''
    const override = (basedOn: string) =>
      checkLayer({
        kind: 'library',
        files: {
          'agents.yaml': `planner:\n  based_on: ${basedOn}\n`,
          'agents/planner.md': 'Plan in fewer rounds.\n',
        },
      })

    expect(findAgentDrift([defaults], override(stageFileHash(builtIn)))).toEqual([])
    expect(findAgentDrift([defaults], override('abc1234'))).toEqual([
      {
        agent: 'planner',
        basedOn: 'abc1234',
        current: stageFileHash(builtIn),
        layer: 'ted',
        inherited: builtIn,
        own: 'Plan in fewer rounds.\n',
      },
    ])
    expect(driftCount([defaults], override('abc1234'))).toBe(1)
  })
})
