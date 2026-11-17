import { describe, expect, test } from 'vitest'
import { coordinatorInstructions } from '../src/coordinators/coordinators.ts'
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

describe('TED’s built-in Agents', () => {
  test('are the Coordinator and the Planner, with their powers and instructions files', async () => {
    const layer = await readDefaultLayer()
    expect(layer.problems).toEqual([])
    const workflow = resolveWorkflow([layer])

    expect(workflow.agents.map(({ instructions: _, ...agent }) => agent)).toEqual([
      {
        id: 'coordinator',
        name: 'Coordinator',
        powers: ['ask', 'manage_tasks'],
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

  test('chat prompts put the Agent’s instructions inside TED’s own text', async () => {
    const workflow = resolveWorkflow([await readDefaultLayer()])
    const builtIn = workflow.agent('coordinator')
    const coordinator = coordinatorInstructions(builtIn?.instructions ?? '', builtIn?.powers ?? [])
    expect(coordinator).toMatch(
      /^# You are the Coordinator for one TED Factory\nHelp the human compare Tasks/,
    )
    expect(coordinator).toContain('Act only on a request from the human in THIS conversation.')

    const planner = plannerInstructions({
      role: 'Plan only the database changes.',
      powers: ['ask', 'propose_tasks', 'read_code'],
      factory: { id: 'f', name: 'Widgets', repo: 'acme/widgets' } as never,
      entries: [],
      folder: '/tmp/plan',
    })
    expect(planner).toMatch(/^Plan only the database changes\.\n\n## Write clearly/)
    expect(planner).toContain('This chat is in the Widgets Factory.')
    expect(planner).toContain('ted task propose --file <file>')
  })

  test('a chat’s preamble lists only the commands its powers allow', () => {
    const role = 'Watch the releases.'
    const none = coordinatorInstructions(role, [])
    expect(none).toContain('You have no TED commands in this chat.')
    for (const text of ['ted coordinator', 'ted ask', 'ted task propose', 'working folder'])
      expect(none).not.toContain(text)

    const manage = coordinatorInstructions(role, ['manage_tasks'])
    expect(manage).toContain('ted coordinator tasks')
    expect(manage).toContain('Start means Backlog to Queued')
    expect(manage).not.toContain('ted ask')

    const ask = coordinatorInstructions(role, ['ask'])
    expect(ask).toContain('ted ask "<question>"')
    expect(ask).toContain('ted ask --round <file>')
    expect(ask).toContain('After you ask, end your turn')
    expect(ask).not.toContain('ted coordinator')
    expect(ask).not.toContain('ted task propose')

    const propose = coordinatorInstructions(role, ['propose_tasks'])
    expect(propose).toContain('ted task propose --file <file>')
    expect(propose).not.toContain('ted ask')

    const where =
      'Your working folder is a fresh checkout of acme/widgets at the latest base branch.'
    expect(coordinatorInstructions(role, ['read_code'], where)).toContain(where)
    expect(coordinatorInstructions(role, ['ask'], where)).not.toContain(where)

    const plannerWith = (powers: Parameters<typeof plannerInstructions>[0]['powers']) =>
      plannerInstructions({
        role: 'Plan.',
        powers,
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
      'error .ted/agents.yaml 2 17 unknown power `launch_missiles` in `helper.powers`; the powers are ask, manage_tasks, propose_tasks, read_code',
      'error .ted/agents.yaml 3 3 unknown key `helper.colour`; an Agent has name, agent, model, powers, based_on',
      'error .ted/agents.yaml 4 1 `Bad_Id` isn’t an Agent id; an Agent id is lowercase letters, digits and hyphens, up to 40 characters',
      'error .ted/agents.yaml 6 1 `scout` has no instructions file; add agents/scout.md',
      'error .ted/agents.yaml 8 10 `scout.agent` must be claude, codex or antigravity',
    ])
  })

  test('the Planner can’t have Manage Tasks: check reports it and resolving drops it', () => {
    const files = {
      'agents.yaml': 'planner:\n  name: Planner\n  powers: [ask, manage_tasks]\n',
      'agents/planner.md': 'Plan.\n',
    }
    expect(problems(files)).toEqual([
      'error .ted/agents.yaml 1 1 `planner` can’t have `manage_tasks`; the Planner runs in a planning chat',
    ])
    expect(
      resolveAgents([
        {
          kind: 'factory',
          agentSettings: { planner: { name: 'Planner', powers: ['ask', 'manage_tasks'] } },
          agentFiles: { planner: 'Plan.\n' },
        },
      ])[0]?.powers,
    ).toEqual(['ask'])
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
      'warning .ted/agents/stray.md 1 1 No agents.yaml lists `stray`, so TED ignores this file. Add `stray` to agents.yaml to use it.',
    ])
  })
})

describe('Agent layers', () => {
  test('a higher layer overrides the keys it names and the instructions it has; sources follow', async () => {
    const library = checkLayer({
      kind: 'library',
      files: {
        'agents.yaml': 'coordinator:\n  powers: [manage_tasks]\nscout:\n  name: Scout\n',
        'agents/coordinator.md': 'Coordinate briefly.\n',
        'agents/scout.md': 'Scout the code.\n',
      },
    })
    const defaults = await readDefaultLayer()
    const factory = checkLayer({
      kind: 'factory',
      files: { 'agents.yaml': 'scout:\n  name: Repo scout\n  powers: [read_code]\n' },
      inherited: inheritedFrom([defaults, library]),
    })
    expect([...library.problems, ...factory.problems]).toEqual([])
    const workflow = resolveWorkflow([defaults, library, factory])

    expect(workflow.agent('coordinator')).toMatchObject({
      name: 'Coordinator',
      powers: ['manage_tasks'],
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
