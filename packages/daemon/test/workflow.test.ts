import type { RepoSettingsInput } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { appDeclarations } from '../src/apps/declared.ts'
import { promptGuidance } from '../src/guidance.ts'
import { workflowAccessChanges } from '../src/workflow/access.ts'
import { applyChanges, repoSettingsFrom } from '../src/workflow/edit.ts'
import {
  boardStages,
  checkLayer,
  inheritedFrom,
  type LayerFiles,
  readDefaultLayer,
  resolveAgentChoices,
  resolveWorkflow,
  withStagesInUse,
} from '../src/workflow/index.ts'
import { sameFiles, sharedDefaultLayer } from '../src/workflow/layers.ts'
import {
  setupWorkflow,
  withForcedGates,
  withoutGates,
  withRecorded,
  withTaskGates,
} from '../src/workflow/resolve.ts'
import { nextStageMessage, subAgentPrompt, tedSubAgentPrompt } from '../src/workflow/workflow.ts'

const defaults = () => readDefaultLayer()

const library = (files: LayerFiles) => checkLayer({ kind: 'library', files })
const factory = (files: LayerFiles) => checkLayer({ kind: 'factory', files })

describe('Ted defaults', () => {
  test('sub-agent instructions carry writing guidance for delegated work and Ted reviews', async () => {
    for (const prompt of [
      await subAgentPrompt(
        'NB-1',
        'Investigate login failures.',
        promptGuidance({ aiDisclosure: false }),
      ),
      await tedSubAgentPrompt('Review the change.', promptGuidance({ aiDisclosure: false })),
    ]) {
      expect(prompt).toContain('## Write clearly for the user')
      expect(prompt).toContain(
        'Plain language must preserve technical meaning, risks and uncertainty.',
      )
      expect(prompt).toContain('session numbers, process IDs, log file names')
    }
  })

  test('sub-agent instructions ask for the AI disclosure line only when the setting is on', async () => {
    for (const disclose of [true, false]) {
      const guidance = promptGuidance({ aiDisclosure: disclose })
      for (const prompt of [
        await subAgentPrompt('NB-1', 'Investigate login failures.', guidance),
        await tedSubAgentPrompt('Review the change.', guidance),
      ]) {
        if (disclose) {
          expect(prompt).toContain('From Opus 5.5 via Ted:')
          expect(prompt).toContain('Pull request titles don’t get it.')
        } else expect(prompt).not.toContain('via Ted:')
      }
    }
  })

  test('run every built-in Stage in order, Backlog first and Done last', async () => {
    const workflow = resolveWorkflow([await defaults()])

    expect(workflow.stages).toEqual([
      'backlog',
      'intake',
      'clarify',
      'design',
      'work',
      'validate',
      'review',
      'merge',
      'done',
    ])
  })

  test('are valid and have a Stage file for every agent Stage', async () => {
    const layer = await defaults()
    const workflow = resolveWorkflow([layer])

    expect(layer.problems).toEqual([])
    for (const id of workflow.stages.filter((s) => s !== 'backlog' && s !== 'done')) {
      expect(workflow.stageFile(id)).toMatchObject({ layer: 'ted', path: `stages/${id}.md` })
      expect(workflow.stageFile(id)?.text).toMatch(/^# /)
    }
  })

  test('tell Clarify to ask every question that is ready in one round', async () => {
    const text = resolveWorkflow([await defaults()]).stageFile('clarify')?.text ?? ''

    expect(text).toContain('Put every question you can ask now in the round')
    expect(text).not.toContain('a handful')
    expect(text).not.toMatch(/"title": "[^"]*· \d+ questions"/)
  })

  test('put Gates on Design and Review, Merge on with no Gate, and max_back 3 except Validate 8', async () => {
    const { settings } = resolveWorkflow([await defaults()])

    expect(settings.stages.design?.gate).toBe(true)
    expect(settings.stages.review?.gate).toBe(true)
    expect(settings.stages.merge).toMatchObject({ enabled: true, gate: false })
    expect(settings.stages.work?.max_back).toBe(3)
    expect(settings.stages.work?.lead_closes_failures).toBe(true)
    expect(settings.stages.validate?.max_back).toBe(8)
    expect(settings.stages.validate?.loop_check).toBe(5)
    expect(settings.stages.validate?.p1_only_from).toBe(2)
    expect(settings.stages.clarify?.depth).toBe('auto')
  })

  test('leave other sub-agents in Validate off', async () => {
    const { settings } = resolveWorkflow([await defaults()])

    expect(settings.stages.validate?.sub_agents).toBeUndefined()
  })
})

describe('layers', () => {
  test('order is all or nothing: the most specific layer with one wins outright', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      library({ 'workflow.yaml': 'version: 1\norder: [intake, work, validate, merge]\n' }),
      factory({ 'workflow.yaml': 'version: 1\norder: [intake, design, work]\n' }),
    ])

    expect(workflow.stages).toEqual(['backlog', 'intake', 'design', 'work', 'done'])
  })

  test('a layer without order inherits it whole', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      library({ 'workflow.yaml': 'version: 1\norder: [intake, work, merge]\n' }),
      factory({ 'workflow.yaml': 'version: 1\nstages:\n  work: { gate: true }\n' }),
    ])

    expect(workflow.stages).toEqual(['backlog', 'intake', 'work', 'merge', 'done'])
  })

  test('stages.<id> settings merge key by key', async () => {
    const { settings } = resolveWorkflow([
      await defaults(),
      library({ 'workflow.yaml': 'version: 1\nstages:\n  design: { max_back: 1 }\n' }),
      factory({ 'workflow.yaml': 'version: 1\nstages:\n  design: { gate: false }\n' }),
    ])

    expect(settings.stages.design).toEqual({ gate: false, max_back: 1 })
  })

  test('a Factory turns off the Library’s P1-only round and keeps its sub-agents setting', async () => {
    const { settings } = resolveWorkflow([
      await defaults(),
      library({
        'workflow.yaml': 'version: 1\nstages:\n  validate: { p1_only_from: 3, sub_agents: true }\n',
      }),
      factory({ 'workflow.yaml': 'version: 1\nstages:\n  validate: { p1_only_from: false }\n' }),
    ])

    expect(settings.stages.validate).toMatchObject({
      max_back: 8,
      loop_check: 5,
      p1_only_from: false,
      sub_agents: true,
    })
  })

  test('lead, reviewer and planner merge key by key, and a plain name sets the agent', async () => {
    const { settings } = resolveWorkflow([
      await defaults(),
      library({
        'workflow.yaml':
          'version: 1\nlead: { agent: claude, model: opus, effort: high }\nreviewer: codex\nplanner: { agent: codex }\n',
      }),
      factory({
        'workflow.yaml':
          'version: 1\nlead: { effort: low }\nreviewer: { model: o4 }\nplanner: claude\n',
      }),
    ])

    expect(settings.lead).toEqual({ agent: 'claude', model: 'opus', effort: 'low' })
    expect(settings.reviewer).toEqual({ agent: 'codex', model: 'o4' })
    expect(settings.planner).toEqual({ agent: 'claude' })
  })

  test('unset agents default to Claude Code if installed, else Codex; the reviewer to the other kind', async () => {
    const both = { claude: true, codex: true }
    const onlyCodex = { claude: false, codex: true }
    const onlyClaude = { claude: true, codex: false }
    const none = resolveWorkflow([await defaults()]).settings

    expect(resolveAgentChoices(none, both)).toEqual({
      lead: { agent: 'claude' },
      reviewer: { agent: 'codex' },
      planner: { agent: 'claude' },
    })
    expect(resolveAgentChoices(none, onlyCodex)).toEqual({
      lead: { agent: 'codex' },
      reviewer: { agent: 'codex' },
      planner: { agent: 'codex' },
    })
    expect(resolveAgentChoices(none, onlyClaude).reviewer).toEqual({ agent: 'claude' })

    const set = resolveWorkflow([
      await defaults(),
      factory({
        'workflow.yaml':
          'version: 1\nlead: { agent: codex, model: gpt-6-astra, effort: xhigh }\nreviewer: { agent: same, effort: low }\nplanner: { model: opus }\n',
      }),
    ]).settings
    expect(resolveAgentChoices(set, both)).toEqual({
      lead: { agent: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
      reviewer: { agent: 'codex', effort: 'low' },
      planner: { agent: 'claude', model: 'opus' },
    })
  })

  test('a Stage file in a more specific layer replaces the inherited one as a whole', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      library({ 'stages/work.md': '# Work\n\nLibrary work.\n' }),
      factory({ 'stages/review.md': '# Review\n\nFactory review.\n' }),
    ])

    expect(workflow.stageFile('work')).toEqual({
      layer: 'library',
      path: 'stages/work.md',
      text: '# Work\n\nLibrary work.\n',
    })
    expect(workflow.stageFile('review')).toEqual({
      layer: 'factory',
      path: '.ted/stages/review.md',
      text: '# Review\n\nFactory review.\n',
    })
    expect(workflow.stageFile('design')?.layer).toBe('ted')
  })

  test('stages.<id>.enabled: false turns a Stage off without editing order', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      factory({ 'workflow.yaml': 'version: 1\nstages:\n  design: { enabled: false }\n' }),
    ])

    expect(workflow.stages).not.toContain('design')
    expect(workflow.stages).toContain('clarify')
  })

  test('Cleanup comes last, before Done, only when it is on and lists a step, and its instructions list the steps', async () => {
    const yaml = (cleanup: string) => ({
      'workflow.yaml': `version: 1\norder: [intake, work, merge]\nstages:\n  cleanup:\n${cleanup}`,
    })
    const on = resolveWorkflow([
      await defaults(),
      factory(
        yaml(
          '    enabled: true\n    steps:\n      - { name: Post note, instruction: Post the link. }\n',
        ),
      ),
    ])

    expect(on.stages).toEqual(['backlog', 'intake', 'work', 'merge', 'cleanup', 'done'])
    expect(on.next('merge')).toBe('cleanup')
    expect(on.next('cleanup')).toBe('done')
    expect(boardStages(on).map((s) => s.id)).toEqual([
      'backlog',
      'intake',
      'work',
      'merge',
      'cleanup',
      'done',
    ])
    expect(boardStages(on).find((s) => s.id === 'cleanup')).toMatchObject({
      enabled: true,
      gate: false,
    })
    expect(nextStageMessage(on, 'cleanup')).toContain('1. **Post note**\n\n   Post the link.')
    expect(
      boardStages(resolveWorkflow([await defaults()])).map((s) => [s.id, s.enabled]),
    ).toContainEqual(['cleanup', false])
    expect(boardStages(resolveWorkflow([await defaults()])).at(-2)?.id).toBe('cleanup')
    for (const off of [
      '    enabled: true\n    steps: []\n',
      '    steps:\n      - { name: Post note, instruction: Post the link. }\n',
      '    enabled: false\n',
    ]) {
      expect(resolveWorkflow([await defaults(), factory(yaml(off))]).stages).not.toContain(
        'cleanup',
      )
    }
    expect(resolveWorkflow([await defaults()]).stages).not.toContain('cleanup')
  })

  test('stages.backlog.enabled: false is ignored with a warning; Backlog stays first and Done last', async () => {
    const layer = library({
      'workflow.yaml': 'version: 1\nstages:\n  backlog: { enabled: false }\n',
    })
    const workflow = resolveWorkflow([await defaults(), layer])

    expect(layer.problems.map((p) => [p.severity, p.line, p.message])).toEqual([
      ['warning', 3, 'Backlog can’t be turned off; Ted ignores this'],
    ])
    expect(workflow.stages[0]).toBe('backlog')
    expect(workflow.stages.at(-1)).toBe('done')
    expect(boardStages(workflow)[0]).toMatchObject({ id: 'backlog', enabled: true })
  })

  test('Factory-only keys in the Library are ignored with a warning', async () => {
    const layer = library({
      'workflow.yaml': 'version: 1\npermissions: bypass\nmax_working_runs: 2\n',
    })
    const { settings } = resolveWorkflow([await defaults(), layer])

    expect(layer.problems.map((p) => [p.severity, p.line, p.message])).toEqual([
      ['warning', 2, '`permissions` can only be set in a Factory’s .ted/workflow.yaml'],
      ['warning', 3, '`max_working_runs` can only be set in a Factory’s .ted/workflow.yaml'],
    ])
    expect(settings.permissions).toBeUndefined()
    expect(settings.max_working_runs).toBeUndefined()
  })

  test('only the Library names sockets; a Factory can’t, and the old list form grants nothing', async () => {
    const named = library({
      'workflow.yaml':
        'version: 1\nsandbox_sockets:\n  docker: /var/run/docker.sock\n  colima: ~/.colima/docker.sock\n  ssh-agent: $SSH_AUTH_SOCK\n',
    })
    const repo = factory({
      'workflow.yaml': 'version: 1\nsandbox_sockets: { db: /run/db.sock }\n',
    })
    const { settings } = resolveWorkflow([await defaults(), named, repo])
    expect(named.problems).toEqual([])
    expect(repo.problems.map((p) => [p.severity, p.line, p.message])).toEqual([
      [
        'error',
        2,
        '`sandbox_sockets` can only be set in your Library (Settings → Library), so a repo can’t open a socket on its own. Ask for a socket the Library names with `socket:<name>` in `sandbox_access`',
      ],
    ])
    expect(settings.sandbox_sockets).toEqual([
      { name: 'docker', path: '/var/run/docker.sock' },
      { name: 'colima', path: '~/.colima/docker.sock' },
      { name: 'ssh-agent', path: '$SSH_AUTH_SOCK' },
    ])

    for (const kind of ['library', 'factory'] as const) {
      const old = checkLayer({
        kind,
        files: { 'workflow.yaml': 'version: 1\nsandbox_sockets: [/var/run/docker.sock]\n' },
      })
      expect(old.settings.sandbox_sockets).toBeUndefined()
      expect(old.problems.map((p) => [p.severity, p.message])).toEqual([
        [
          'warning',
          'a list of `sandbox_sockets` no longer grants anything, because it let every command reach those sockets. Name each socket in your Library (Settings → Library, `sandbox_sockets: { <name>: <path> }`), then add `socket:<name>` to `sandbox_access` on each App, Check or worktree setup that uses it. Listed here: /var/run/docker.sock',
        ],
      ])
    }
    expect(
      resolveWorkflow([
        await defaults(),
        named,
        factory({ 'workflow.yaml': 'version: 1\nsandbox_sockets: [/run/a.sock]\n' }),
      ]).settings.sandbox_sockets,
    ).toHaveLength(3)

    const message =
      '`sandbox_sockets` must map socket names (lowercase letters, digits and -) to socket paths: absolute, starting with ~/, or a whole $NAME'
    for (const bad of [
      'docker: docker.sock',
      'docker: /run/../a.sock',
      'docker: $HOME/a.sock',
      'Docker: /run/a.sock',
      'docker: yes',
    ]) {
      const layer = library({ 'workflow.yaml': `version: 1\nsandbox_sockets: { ${bad} }\n` })
      expect(layer.problems.map((p) => p.message)).toEqual([message])
    }
  })

  test('sandbox_reads lists files and folders, and the later layer’s list wins', async () => {
    const good = factory({
      'workflow.yaml': 'version: 1\nsandbox_reads: [/srv/fixtures, ~/.npmrc, $GRADLE_HOME]\n',
    })
    const { settings } = resolveWorkflow([
      await defaults(),
      library({ 'workflow.yaml': 'version: 1\nsandbox_reads: [/srv/other]\n' }),
      good,
    ])
    expect(good.problems).toEqual([])
    expect(settings.sandbox_reads).toEqual(['/srv/fixtures', '~/.npmrc', '$GRADLE_HOME'])

    for (const bad of ['.npmrc', '/srv/../etc', '$HOME/.aws', '~', 'yes']) {
      const layer = factory({ 'workflow.yaml': `version: 1\nsandbox_reads: ['${bad}']\n` })
      expect(layer.problems.map((p) => p.message)).toEqual([
        '`sandbox_reads` must be a list of files or folders: absolute, starting with ~/, or a whole $NAME',
      ])
    }
  })

  test('sandbox_network sets the Factory’s network level, and the later layer’s level wins', async () => {
    const good = factory({ 'workflow.yaml': 'version: 1\nsandbox_network: none\n' })
    const { settings } = resolveWorkflow([
      await defaults(),
      library({ 'workflow.yaml': 'version: 1\nsandbox_network: outbound\n' }),
      good,
    ])
    expect(good.problems).toEqual([])
    expect(settings.sandbox_network).toBe('none')

    const bad = factory({ 'workflow.yaml': 'version: 1\nsandbox_network: all\n' })
    expect(bad.problems.map((p) => p.message)).toEqual([
      '`sandbox_network` must be none, localhost or outbound',
    ])
  })

  test('Factory notes come from the Factory layer', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      factory({ 'notes.md': '# Product\n\nA widget shop.\n' }),
    ])

    expect(workflow.notes).toBe('# Product\n\nA widget shop.\n')
  })
})

describe('next Stage', () => {
  test('follows the Workflow and ends in Done', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      factory({ 'workflow.yaml': 'version: 1\norder: [intake, work, merge]\n' }),
    ])

    expect(workflow.next('backlog')).toBe('intake')
    expect(workflow.next('intake')).toBe('work')
    expect(workflow.next('merge')).toBe('done')
    expect(workflow.next('done')).toBe('done')
  })

  test('from a Stage the Workflow no longer has, goes to the next built-in Stage it does have', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      factory({ 'workflow.yaml': 'version: 1\norder: [intake, work, merge]\n' }),
    ])

    expect(workflow.next('clarify')).toBe('work')
    expect(workflow.next('validate')).toBe('merge')
  })
  test('from a custom Stage the Workflow no longer has, goes to the next Stage of the recorded order that it still has', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      factory({ 'workflow.yaml': 'version: 1\norder: [intake, work, validate, merge]\n' }),
    ])
    const recorded = ['intake', 'security', 'work', 'validate', 'release-notes', 'review', 'merge']

    expect(workflow.next('security', recorded)).toBe('work')
    expect(workflow.next('release-notes', recorded)).toBe('merge')
    expect(
      withRecorded(
        workflow,
        recorded.map((stage) => ({ stage })),
      ).next('release-notes'),
    ).toBe('merge')
  })
})

const customYaml = [
  'version: 1',
  'order: [intake, security, work, validate, release-notes, review, merge]',
  'stages:',
  '  release-notes:',
  '    name: Release notes',
  '    gate: true',
  '',
].join('\n')

const customFiles = {
  'workflow.yaml': customYaml,
  'stages/security.md': '# Security\n\nCheck the change for secrets.\n',
  'stages/release-notes.md': '# Release notes\n\nWrite them.\n',
}

describe('custom Stages', () => {
  test('run where order puts them, with their own Stage file, display name and send-back limit 3', async () => {
    const workflow = resolveWorkflow([await defaults(), factory(customFiles)])

    expect(workflow.stages).toEqual([
      'backlog',
      'intake',
      'security',
      'work',
      'validate',
      'release-notes',
      'review',
      'merge',
      'done',
    ])
    expect(workflow.next('validate')).toBe('release-notes')
    expect(workflow.stageFile('security')).toMatchObject({
      layer: 'factory',
      path: '.ted/stages/security.md',
    })
    expect(workflow.name('release-notes')).toBe('Release notes')
    expect(workflow.name('security')).toBe('Security')
    expect(workflow.settings.stages.security).toMatchObject({ max_back: 3 })
    expect(workflow.settings.stages['release-notes']).toMatchObject({ gate: true, max_back: 3 })
    expect(nextStageMessage(workflow, 'release-notes')).toContain(
      'Ted moved this Task to Release notes.',
    )
    expect(boardStages(workflow).filter((stage) => stage.custom)).toEqual([
      { id: 'security', name: 'Security', enabled: true, gate: false, custom: true },
      { id: 'release-notes', name: 'Release notes', enabled: true, gate: true, custom: true },
    ])

    const recorded = ['intake', 'work', 'validate', 'audit', 'review', 'merge'].map((stage) => ({
      stage,
      ...(stage === 'audit' && { name: 'Audit pass' }),
    }))
    const listed = withStagesInUse(boardStages(workflow), [
      { stage: 'audit', recorded },
      { stage: 'clarify', recorded: undefined },
    ])
    expect(listed.map((s) => s.id)).toEqual([
      'backlog',
      'intake',
      'security',
      'clarify',
      'work',
      'validate',
      'release-notes',
      'audit',
      'review',
      'merge',
      'cleanup',
      'done',
    ])
    expect(listed.find((s) => s.id === 'audit')).toEqual({
      id: 'audit',
      name: 'Audit pass',
      custom: true,
      removed: true,
      enabled: false,
      gate: false,
    })
    expect(listed.find((s) => s.id === 'clarify')).toEqual({
      id: 'clarify',
      name: 'Clarify',
      removed: true,
      enabled: false,
      gate: false,
    })
  })

  test('a custom Stage whose file a lower layer no longer has is left out', async () => {
    const stored = checkLayer({
      kind: 'factory',
      files: { 'workflow.yaml': customYaml, 'stages/security.md': '# Security\n' },
      inherited: { files: ['release-notes'] },
    })
    const workflow = resolveWorkflow([await defaults(), stored])

    expect(workflow.missing).toEqual(['release-notes'])
    expect(workflow.stages).not.toContain('release-notes')
    expect(workflow.next('validate')).toBe('review')
  })

  test('forced and setup Gates keep custom Stages where order puts them', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      factory({
        ...customFiles,
        'workflow.yaml': customYaml.replace(
          'order: [intake, security, work, validate, release-notes, review, merge]',
          'order: [intake, security, work, validate, release-notes, merge]',
        ),
      }),
    ])

    expect(withForcedGates(workflow, ['review', 'security']).stages).toEqual([
      'backlog',
      'intake',
      'security',
      'work',
      'validate',
      'release-notes',
      'review',
      'merge',
      'done',
    ])
    expect(withForcedGates(workflow, ['security']).settings.stages.security).toMatchObject({
      gate: true,
    })
    expect(setupWorkflow(workflow).order).toEqual([
      'intake',
      'security',
      'clarify',
      'design',
      'work',
      'validate',
      'release-notes',
      'review',
      'merge',
    ])
    expect(withoutGates(workflow).off).toEqual(['release-notes'])
    expect(withTaskGates(workflow, { security: true }).settings.stages.security).toMatchObject({
      gate: true,
    })
  })
})

const badId =
  'a custom Stage id is lowercase letters, digits and hyphens, up to 40 characters, and not a built-in id'

const problems = (files: LayerFiles, kind: 'library' | 'factory' = 'factory') =>
  checkLayer({ kind, files }).problems.map((p) =>
    [p.severity, p.file, p.line, p.column, p.message].join(' '),
  )

describe('checking a layer', () => {
  test('YAML that doesn’t parse is an error at its line and column', () => {
    expect(problems({ 'workflow.yaml': 'version: 1\norder: [intake, work\n' })[0]).toMatch(
      /^error \.ted\/workflow\.yaml 3 1 /,
    )
  })

  test('a wrong type is an error at the value', () => {
    expect(
      problems({ 'workflow.yaml': 'version: 1\nstages:\n  work:\n    gate: yes please\n' }),
    ).toEqual(['error .ted/workflow.yaml 4 11 `stages.work.gate` must be true or false'])
  })

  test('a model that isn’t a plain model name is an error', () => {
    expect(
      problems({ 'workflow.yaml': 'version: 1\nlead: { model: --permission-mode }\n' }),
    ).toEqual(['error .ted/workflow.yaml 2 16 `lead.model` must be a model name'])
  })

  test('an unknown key is a warning, so a newer file still loads', () => {
    const layer = checkLayer({
      kind: 'factory',
      files: { 'workflow.yaml': 'version: 1\nshiny: true\nstages:\n  work: { sparkle: 1 }\n' },
    })

    expect(layer.problems.map((p) => [p.severity, p.line, p.column, p.message])).toEqual([
      ['warning', 2, 1, 'unknown key `shiny`'],
      ['warning', 4, 11, 'unknown key `stages.work.sparkle`'],
    ])
    expect(layer.valid).toBe(true)
  })

  test('Apps need a name and a run command, a localhost url and a port in range', () => {
    const apps = [
      'version: 1',
      'repos:',
      '  - name: app',
      '    apps:',
      '      - name: Web',
      '        run: npm run dev',
      `        url: "https://example.com:\${PORT}"`,
      '      - name: web',
      '        run: npm run api',
      '        port: 70000',
      '      - run: npm start',
      '      - name: API',
      '        kind: server',
      '        ready: soon',
      '        env: { PORT: "1" }',
      '      - name: Phone',
      '        kind: android-emulator',
      '        run: ./gradlew installDebug',
      '      - name: Desk',
      '        kind: command',
      '        electron: yes please',
      '        run: electron .',
      '      - name: Desk2',
      '        electron: true',
      '        run: electron .',
      '      - name: Desk3',
      '        kind: command',
      '        electron: true',
      '        run: electron .',
      '      - name: Desk4',
      '        kind: command',
      '        electron: true',
      '        run: electron . $TED_ELECTRON_ARGS',
      '      - name: Mobile',
      '        run: npm run dev',
      '        preview: watch',
      '      - name: Tool',
      '        kind: command',
      '        run: tool',
      '        preview: mobile',
      '      - name: Shop',
      '        run: npm run shop',
      '        preview: tablet',
      '',
    ].join('\n')
    expect(problems({ 'workflow.yaml': apps })).toEqual([
      `error .ted/workflow.yaml 7 14 an App \`url\` must be a localhost address, such as http://localhost:\${PORT}`,
      'error .ted/workflow.yaml 8 15 two Apps would both set `TED_APP_WEB_PORT`',
      'error .ted/workflow.yaml 10 15 `port` must be a number from 1 to 65535',
      'error .ted/workflow.yaml 11 9 each App needs a `name`',
      'error .ted/workflow.yaml 12 9 the App API needs a `run` command',
      'error .ted/workflow.yaml 13 15 `kind` must be web, command, ios-simulator or android-emulator',
      'error .ted/workflow.yaml 14 16 `ready` must be url or start',
      'warning .ted/workflow.yaml 15 16 Ted sets `PORT` itself or keeps it out of worktrees, so it ignores it here',
      'error .ted/workflow.yaml 16 9 the Android emulator App Phone needs a `device`: an Android virtual device name',
      'error .ted/workflow.yaml 21 19 `electron` must be true or false',
      'warning .ted/workflow.yaml 24 9 only a command App can be an Electron app',
      'warning .ted/workflow.yaml 28 9 pass $TED_ELECTRON_ARGS to Electron in `run`, or Ted can’t reach the app or start it in the sandbox',
      'error .ted/workflow.yaml 36 18 `preview` must be desktop, tablet or mobile',
      'warning .ted/workflow.yaml 40 9 only a web App has a `preview` size',
    ])
  })

  test('sandbox_access names only Ted’s access groups, on an App, a command check or worktree setup and teardown', () => {
    const yaml = [
      'version: 1',
      'repos:',
      '  - name: app',
      '    worktree:',
      '      setup: { run: make, sandbox_access: [ios-xcode] }',
      '      teardown:',
      '        run: clean',
      '        sandbox_access: ios-xcode',
      '    apps:',
      '      - name: Sim',
      '        kind: command',
      '        run: xcodebuild',
      '        sandbox_access: [ios-xcode, android-gradle, electron, socket:docker, socket:Bad]',
      'stages:',
      '  validate:',
      '    checks:',
      '      - name: Build',
      '        run: xcodebuild',
      '        sandbox_access: [ios-xcode]',
      '      - name: Review',
      '        instruction: Look it over',
      '        sandbox_access: [ios-xcode]',
      '',
    ].join('\n')
    const checked = checkLayer({ kind: 'factory', files: { 'workflow.yaml': yaml } })
    expect(problems({ 'workflow.yaml': yaml })).toEqual([
      'error .ted/workflow.yaml 8 25 `sandbox_access` must be a list of access groups: ios-xcode, ios-simulator, android-emulator, shared-tmp, electron, network, or socket:<name> for a socket your Library names',
      'error .ted/workflow.yaml 13 37 `android-gradle` isn’t a sandbox access group. Ted’s groups: ios-xcode, ios-simulator, android-emulator, shared-tmp, electron, network, or socket:<name> for a socket your Library names',
      'error .ted/workflow.yaml 13 78 `socket:Bad` isn’t a sandbox access group. Ted’s groups: ios-xcode, ios-simulator, android-emulator, shared-tmp, electron, network, or socket:<name> for a socket your Library names',
      'error .ted/workflow.yaml 22 9 an instruction check runs no command in the sandbox, so it takes no `sandbox_access`',
    ])
    expect(checked.settings.repos?.[0]?.worktree?.setup).toEqual({
      run: 'make',
      sandbox_access: ['ios-xcode'],
    })
    expect(checked.settings.stages.validate?.checks?.[0]).toEqual({
      name: 'Build',
      run: 'xcodebuild',
      sandbox_access: ['ios-xcode'],
    })
  })

  test('asking for a socket the Library doesn’t name is a warning, and the entry is kept', () => {
    const below = library({
      'workflow.yaml': 'version: 1\nsandbox_sockets: { docker: /var/run/docker.sock }\n',
    })
    const yaml = [
      'version: 1',
      'stages:',
      '  validate:',
      '    checks:',
      '      - name: E2E',
      '        run: pnpm e2e',
      '        sandbox_access: [electron, socket:docker, socket:db]',
      '',
    ].join('\n')
    const checked = checkLayer({
      kind: 'factory',
      files: { 'workflow.yaml': yaml },
      inherited: inheritedFrom([below]),
    })
    expect(checked.problems.map((p) => [p.severity, p.line, p.column, p.message])).toEqual([
      [
        'warning',
        7,
        51,
        'your Library names no socket `db`, so this command gets none until it does: add `db: <path>` under `sandbox_sockets` in the Library',
      ],
    ])
    expect(checked.settings.stages.validate?.checks?.[0]?.sandbox_access).toEqual([
      'electron',
      'socket:docker',
      'socket:db',
    ])
  })

  test('a bad Stage id in order or stages is an error at its line', () => {
    expect(
      problems({
        'workflow.yaml': 'version: 1\norder: [intake, Security, work]\nstages:\n  deploy_now: {}\n',
      }),
    ).toEqual([
      `error .ted/workflow.yaml 2 17 unknown Stage \`Security\`; ${badId}`,
      `error .ted/workflow.yaml 4 3 unknown Stage \`deploy_now\`; ${badId}`,
    ])
    expect(problems({ 'workflow.yaml': `order: [intake, ${'a'.repeat(41)}, work]\n` })).toEqual([
      `error .ted/workflow.yaml 1 17 unknown Stage \`${'a'.repeat(41)}\`; ${badId}`,
    ])
  })

  test('a custom Stage in order needs a Stage file in this layer or one below it', () => {
    const yaml = 'version: 1\norder: [intake, security, work, release-notes, merge]\n'
    expect(problems({ 'workflow.yaml': yaml, 'stages/security.md': '# Security\n' })).toEqual([
      'error .ted/workflow.yaml 2 33 `release-notes` has no Stage file; add stages/release-notes.md',
    ])
    const inherited = { files: ['release-notes'] }
    const layer = checkLayer({
      kind: 'factory',
      files: { 'workflow.yaml': yaml, 'stages/security.md': '# Security\n' },
      inherited,
    })
    expect(layer.problems).toEqual([])
    expect(layer.valid).toBe(true)
  })

  test('a custom Stage takes only name, gate, max_back, effort, enabled, based_on, priority and skip_busy_hold; a built-in Stage takes no name', () => {
    expect(
      problems({
        'workflow.yaml': [
          'order: [intake, security, work]',
          'stages:',
          '  security:',
          '    name: Security review',
          '    gate: true',
          '    max_back: 2',
          '    effort: high',
          '    depth: few',
          '  work:',
          '    name: Build',
          '',
        ].join('\n'),
        'stages/security.md': '# Security\n',
      }),
    ).toEqual([
      'error .ted/workflow.yaml 8 5 a custom Stage takes only `name`, `gate`, `max_back`, `effort`, `enabled`, `based_on`, `priority`, `skip_busy_hold`',
      'error .ted/workflow.yaml 10 5 only a custom Stage takes `name`',
    ])
    expect(
      problems({
        'workflow.yaml': `order: [intake, security, work]\nstages:\n  security:\n    name: "${'x'.repeat(61)}"\n`,
        'stages/security.md': '# Security\n',
      }),
    ).toEqual([
      'error .ted/workflow.yaml 4 11 `stages.security.name` must be one line of text, up to 60 characters',
    ])
    expect(
      problems({
        'workflow.yaml':
          'order: [intake, security, work]\nstages:\n  security:\n    name: "Sec\\u2067urity"\n',
        'stages/security.md': '# Security\n',
      }),
    ).toEqual([
      'error .ted/workflow.yaml 4 11 `stages.security.name` must be one line of text, up to 60 characters',
    ])
  })

  test('a custom Stage file that no order lists is ignored with a warning', () => {
    expect(
      problems({ 'workflow.yaml': 'version: 1\n', 'stages/security.md': '# Security\n' }),
    ).toEqual([
      'warning .ted/stages/security.md 1 1 No `order` lists `security`, so Ted ignores this file. Add `security` to `order` in workflow.yaml to run it as a Stage.',
    ])
  })

  test('order must start with intake, include work, end with merge and list each Stage once', () => {
    expect(problems({ 'workflow.yaml': 'order: [clarify, intake, work]\n' })).toEqual([
      'error .ted/workflow.yaml 1 8 `order` must start with `intake`',
    ])
    expect(problems({ 'workflow.yaml': 'order: [intake, design]\n' })).toEqual([
      'error .ted/workflow.yaml 1 8 `order` must include `work`',
    ])
    expect(problems({ 'workflow.yaml': 'order: [intake, merge, work]\n' })).toEqual([
      'error .ted/workflow.yaml 1 17 `merge` must be last in `order`',
    ])
    expect(problems({ 'workflow.yaml': 'order: [intake, work, work]\n' })).toEqual([
      'error .ted/workflow.yaml 1 23 `work` is listed twice in `order`',
    ])
    expect(problems({ 'workflow.yaml': 'order: [backlog, intake, work, done]\n' })).toEqual([
      'error .ted/workflow.yaml 1 9 `backlog` can’t be in `order`; it is always first',
      'error .ted/workflow.yaml 1 32 `done` can’t be in `order`; it is always last',
    ])
  })

  test('Backlog takes only enabled, Done takes nothing, and Work can’t be turned off', () => {
    expect(
      problems({
        'workflow.yaml':
          'stages:\n  backlog: { gate: true }\n  done: { enabled: false }\n  work: { enabled: false }\n',
      }),
    ).toEqual([
      'error .ted/workflow.yaml 2 14 Backlog takes only `enabled`',
      'error .ted/workflow.yaml 3 11 Done takes no settings',
      'error .ted/workflow.yaml 4 20 Work can’t be turned off',
    ])
  })

  test('Cleanup can’t be in order, takes only its own keys, and each step needs a unique one-line name and an instruction or a command', () => {
    const found = checkLayer({
      kind: 'factory',
      files: {
        'workflow.yaml': [
          'order: [intake, work, cleanup]',
          'stages:',
          '  cleanup:',
          '    gate: true',
          '    steps:',
          '      - { name: Post note }',
          '      - { instruction: Do it. }',
          '      - { name: Drop db, instruction: Drop it. }',
          '      - { name: Drop db, instruction: Again. }',
          '      - { name: "Two\\nlines", instruction: Do it. }',
          '      - { name: Both, instruction: Do it., command: make down }',
          '      - { name: Wait, instruction: Do it., timeout: 5m }',
          '      - { name: Slow, command: make down, timeout: soon }',
          '      - { name: Stop env, command: make down, timeout: 5m }',
          '      - { name: Prune, command: docker system prune -f }',
          '',
        ].join('\n'),
      },
    })

    expect(found.problems.map((p) => `${p.severity} ${p.message}`)).toEqual([
      'error `cleanup` can’t be in `order`; turn it on with `stages.cleanup.enabled`',
      'error Cleanup takes only `enabled`, `effort`, `based_on`, `steps`, `priority`, `skip_busy_hold`',
      'error each Cleanup step needs an `instruction` or a `command`',
      'error each Cleanup step needs a `name`',
      'error two Cleanup steps are named `Drop db`',
      'error a Cleanup step’s `name` must be one line',
      'error a Cleanup step has an `instruction` or a `command`, not both',
      'error only a Cleanup step with a `command` takes a `timeout`',
      'error `timeout` must be a duration such as 30s, 15m or 1h',
    ])
    expect(found.settings.stages.cleanup?.steps).toEqual([
      { name: 'Drop db', instruction: 'Drop it.' },
      { name: 'Stop env', command: 'make down', timeout: '5m' },
      { name: 'Prune', command: 'docker system prune -f' },
    ])
  })

  test('an empty or unreadable Stage file is an error; an unknown one is ignored with a warning', () => {
    const layer = checkLayer({
      kind: 'library',
      files: { 'stages/work.md': '  \n', 'stages/design.md': null, 'stages/Notes.md': '# S\n' },
    })

    expect(layer.problems.map((p) => [p.severity, p.file, p.message])).toEqual([
      ['error', 'stages/work.md', 'the Stage file is empty'],
      ['error', 'stages/design.md', 'Ted couldn’t read the Stage file'],
      [
        'warning',
        'stages/Notes.md',
        '`Notes` isn’t a Stage id, so Ted ignores this file. A custom Stage id is lowercase letters, digits and hyphens, up to 40 characters.',
      ],
    ])
    expect(layer.valid).toBe(false)
  })

  test('Intake can’t be turned off either', () => {
    expect(problems({ 'workflow.yaml': 'stages:\n  intake: { enabled: false }\n' })).toEqual([
      'error .ted/workflow.yaml 2 22 Intake can’t be turned off',
    ])
  })

  test('an unreadable stages folder is an error, so the last valid version stays in use', () => {
    expect(problems({ stages: null }, 'library')).toEqual([
      'error stages 1 1 Ted couldn’t read the stages folder',
    ])
  })

  test('version must be 1', () => {
    expect(problems({ 'workflow.yaml': 'version: 2\n' })).toEqual([
      'error .ted/workflow.yaml 1 10 `version` must be 1',
    ])
  })

  test('checks every key in the table', () => {
    expect(
      problems({
        'workflow.yaml': [
          'lead: { agent: gemini }',
          'reviewer: nobody',
          'planner: { effort: huge }',
          'permissions: yolo',
          'max_working_runs: 0',
          'stages:',
          '  clarify: { depth: lots }',
          '  validate:',
          '    max_back: -1',
          '    loop_check: true',
          '    checks: [{ name: Tests }]',
          '  review: { based_on: 12 }',
          '',
        ].join('\n'),
      }),
    ).toEqual([
      'error .ted/workflow.yaml 1 16 `lead.agent` must be claude, codex, antigravity or pi',
      'error .ted/workflow.yaml 2 11 `reviewer` must be codex, claude, antigravity, pi or same',
      'error .ted/workflow.yaml 3 20 `planner.effort` must be one of low, medium, high, xhigh, max, ultra',
      'error .ted/workflow.yaml 4 14 `permissions` must be auto or bypass',
      'error .ted/workflow.yaml 5 19 `max_working_runs` must be a whole number above 0',
      'error .ted/workflow.yaml 7 21 `stages.clarify.depth` must be one of auto, none, few, grilling',
      'error .ted/workflow.yaml 9 15 `stages.validate.max_back` must be a whole number, 0 or more',
      'error .ted/workflow.yaml 10 17 `stages.validate.loop_check` must be a whole number above 0, or false',
      'error .ted/workflow.yaml 11 14 each check needs a `run` command or an `instruction`',
      'error .ted/workflow.yaml 12 23 `stages.review.based_on` must be text',
    ])
  })

  test('p1_only_from takes a round of 2 or more or false, and sub_agents true or false', () => {
    const validate = (line: string) =>
      problems({ 'workflow.yaml': `stages:\n  validate:\n    ${line}\n` })
    for (const value of ['1', '0', '2.5', 'soon', 'true']) {
      expect(validate(`p1_only_from: ${value}`)).toEqual([
        'error .ted/workflow.yaml 3 19 `stages.validate.p1_only_from` must be a round number, 2 or more, or false',
      ])
    }
    for (const value of ['2', '7', 'false']) expect(validate(`p1_only_from: ${value}`)).toEqual([])
    expect(validate('sub_agents: 1')).toEqual([
      'error .ted/workflow.yaml 3 17 `stages.validate.sub_agents` must be true or false',
    ])
    for (const value of ['true', 'false']) expect(validate(`sub_agents: ${value}`)).toEqual([])
    expect(
      problems(
        { 'workflow.yaml': 'stages:\n  validate: { p1_only_from: 3, sub_agents: true }\n' },
        'library',
      ),
    ).toEqual([])
    expect(validate('max_back: 5\n    p1_only_from: 6')).toEqual([])
    expect(validate('p1_only_from: 7\n    max_back: 5')).toEqual([
      'warning .ted/workflow.yaml 3 5 `stages.validate.p1_only_from` is 7, but `max_back: 5` in this file lets Validate reach round 6 at most before Ted asks the human, so round 7 comes only if the human sends the Task back again',
    ])
    expect(
      problems({ 'workflow.yaml': 'stages:\n  work: { p1_only_from: 3, sub_agents: true }\n' }),
    ).toEqual([
      'warning .ted/workflow.yaml 2 11 unknown key `stages.work.p1_only_from`',
      'warning .ted/workflow.yaml 2 28 unknown key `stages.work.sub_agents`',
    ])
    const work = (line: string) => problems({ 'workflow.yaml': `stages:\n  work:\n    ${line}\n` })
    expect(work('lead_closes_failures: 1')).toEqual([
      'error .ted/workflow.yaml 3 27 `stages.work.lead_closes_failures` must be true or false',
    ])
    for (const value of ['true', 'false']) {
      expect(work(`lead_closes_failures: ${value}`)).toEqual([])
    }
    expect(validate('lead_closes_failures: true')).toEqual([
      'warning .ted/workflow.yaml 3 5 unknown key `stages.validate.lead_closes_failures`',
    ])
    const merge = (line: string) =>
      problems({ 'workflow.yaml': `stages:\n  merge:\n    ${line}\n` })
    expect(merge('commit_titles: 1')).toEqual([
      'error .ted/workflow.yaml 3 20 `stages.merge.commit_titles` must be true or false',
    ])
    for (const value of ['true', 'false']) expect(merge(`commit_titles: ${value}`)).toEqual([])
    expect(work('commit_titles: false')).toEqual([
      'warning .ted/workflow.yaml 3 5 unknown key `stages.work.commit_titles`',
    ])
    for (const value of ['-1', '1.5', 'high', 'true']) {
      expect(work(`priority: ${value}`)).toEqual([
        `error .ted/workflow.yaml 3 15 \`stages.work.priority\` must be a whole number, 0 or more`,
      ])
    }
    expect(work('skip_busy_hold: 1')).toEqual([
      'error .ted/workflow.yaml 3 21 `stages.work.skip_busy_hold` must be true or false',
    ])
    for (const id of ['intake', 'work', 'validate', 'merge']) {
      expect(
        problems({
          'workflow.yaml': `stages:\n  ${id}: { priority: 3, skip_busy_hold: true }\n`,
        }),
      ).toEqual([])
    }
    expect(
      problems({
        'workflow.yaml':
          'order: [intake, security, work]\nstages:\n  security: { priority: 0, skip_busy_hold: false }\n',
        'stages/security.md': '# Security\n',
      }),
    ).toEqual([])
  })

  test('Checks are Factory only', () => {
    expect(
      problems(
        { 'workflow.yaml': 'stages:\n  validate:\n    checks: [{ name: T, run: "true" }]\n' },
        'library',
      ),
    ).toEqual([
      'warning workflow.yaml 3 5 `stages.validate.checks` can only be set in a Factory’s .ted/workflow.yaml',
    ])
  })
})

describe('repos', () => {
  const repoProblems = (yaml: string) =>
    checkLayer({ kind: 'factory', files: { 'workflow.yaml': yaml }, primaryRepo: 'acme/app' })
      .problems.filter((p) => p.severity === 'error')
      .map((p) => `${p.line}:${p.column} ${p.message}`)

  test('a full two-repo example is valid', () => {
    expect(
      repoProblems(
        [
          'repos:',
          '  - name: app',
          '    merge_method: squash',
          '    worktree:',
          '      setup: "npm ci"',
          '      env: { EXPO_NO_TELEMETRY: "1" }',
          '      copy: [".env"]',
          '    apps:',
          '      - { name: Web, run: "npm run web" }',
          '  - name: api',
          '    remote: git@github.com:kriya/api.git',
          '    base_branch: develop',
          '    merge_method: rebase',
          '    worktree:',
          '      setup: { run: "bundle install", timeout: 20m }',
          '      teardown: "bin/rails db:drop"',
          'stages:',
          '  validate:',
          '    checks:',
          '      - { name: API tests, run: "bin/rails test", repo: api, timeout: 10m }',
          '',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  test('reports duplicate names, the same repo twice, a missing remote, a non-GitHub remote and a Check naming no repo', () => {
    expect(
      repoProblems(
        [
          'repos:',
          '  - name: app',
          '  - name: app',
          '    remote: https://github.com/kriya/api',
          '  - name: api2',
          '    remote: git@github.com:kriya/api.git',
          '  - name: web',
          '  - name: lab',
          '    remote: https://gitlab.com/kriya/lab.git',
          'stages:',
          '  validate:',
          '    checks: [{ name: T, run: "true", repo: nowhere }]',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      '3:11 two repos are named `app`',
      '6:13 kriya/api is listed twice in `repos`',
      '7:5 a secondary repo needs a `remote`',
      '9:13 `remote` must be a GitHub repo',
      '12:44 the check’s `repo: nowhere` names no entry in `repos`',
    ])
  })

  test('a name must be lowercase letters, digits and dashes; merge_method, pull_request_ci and timeouts are checked', () => {
    expect(
      repoProblems(
        [
          'repos:',
          '  - name: My App',
          '    merge_method: fast-forward',
          '    pull_request_ci: sometimes',
          '    worktree:',
          '      setup: { run: "x", timeout: soon }',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      '2:11 a repo `name` uses only lowercase letters, digits and dashes',
      '3:19 `merge_method` must be squash, merge or rebase',
      '4:22 `pull_request_ci` must be auto, none or required',
      '6:35 `timeout` must be a duration such as 30s, 15m or 1h',
    ])
  })

  test('a primary remote that names another repo is ignored with a warning', () => {
    const layer = checkLayer({
      kind: 'factory',
      files: { 'workflow.yaml': 'repos:\n  - name: app\n    remote: kriya/other\n' },
      primaryRepo: 'acme/app',
    })

    expect(layer.problems.map((p) => [p.severity, p.message])).toEqual([
      ['warning', 'the primary repo is the one holding .ted/, so Ted ignores this `remote`'],
    ])
  })
})

test('Task Gates override inheritance without enabling Stages, and mandatory Gates win', async () => {
  const { withTaskGates, withForcedGates, setupWorkflow } = await import(
    '../src/workflow/resolve.ts'
  )
  const inherited = resolveWorkflow([
    await defaults(),
    factory({ 'workflow.yaml': 'version: 1\norder: [intake, design, work, review, merge]\n' }),
  ])
  const own = withTaskGates(inherited, {
    design: false,
    work: true,
    validate: true,
    merge: true,
    review: false,
  })
  expect(own.stages).toEqual(inherited.stages)
  expect(own.settings.stages.design?.gate).toBe(false)
  expect(own.settings.stages.work?.gate).toBe(true)
  expect(own.settings.stages.merge?.gate).toBe(true)
  expect(inherited.settings.stages.design?.gate).toBe(true)
  expect(withForcedGates(own, ['review']).settings.stages.review?.gate).toBe(true)
  expect(setupWorkflow(own).settings.stages.design?.gate).toBe(true)
  expect(withTaskGates(inherited, {}).settings.stages.design?.gate).toBe(true)
  const changed = resolveWorkflow([
    await defaults(),
    factory({ 'workflow.yaml': 'version: 1\nstages:\n  design: { gate: false }\n' }),
  ])
  expect(withTaskGates(changed, {}).settings.stages.design?.gate).toBe(false)
  expect(withTaskGates(changed, { design: true }).settings.stages.design?.gate).toBe(true)
})

describe('Stage effort', () => {
  test('inherits by Stage and overrides only the chosen Stage', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      library({
        'workflow.yaml':
          'version: 1\nstages:\n  design: { effort: high }\n  work: { effort: medium }\n',
      }),
      factory({ 'workflow.yaml': 'version: 1\nstages:\n  design: { effort: ultra }\n' }),
    ])
    expect(workflow.settings.stages.design?.effort).toBe('ultra')
    expect(workflow.settings.stages.work?.effort).toBe('medium')
    expect(workflow.settings.stages.intake?.effort).toBeUndefined()
  })

  test('rejects invalid effort values and effort on holding Stages', () => {
    for (const [id, value] of [
      ['work', 'huge'],
      ['work', 'null'],
      ['backlog', 'high'],
      ['done', 'medium'],
    ]) {
      expect(
        factory({ 'workflow.yaml': `version: 1\nstages:\n  ${id}: { effort: ${value} }\n` }).valid,
      ).toBe(false)
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(
        factory({ 'workflow.yaml': `version: 1\nstages:\n  work: { effort: ${effort} }\n` }).valid,
      ).toBe(true)
    }
  })
})

describe('shared layers', () => {
  test('every read of Ted’s defaults is its own copy of one parsed layer', async () => {
    const shared = await sharedDefaultLayer()
    expect(await sharedDefaultLayer()).toBe(shared)
    const first = await defaults()
    const second = await defaults()
    expect(first).toEqual(shared)
    expect(first).not.toBe(shared)
    first.settings.order?.push('merge')
    first.settings.stages.work = { enabled: false }
    first.stageFiles.work = 'changed'
    first.files['workflow.yaml'] = 'changed'
    expect(second).toEqual(shared)
    expect(await defaults()).toEqual(second)
  })

  test('layer files are the same when every name and text matches', () => {
    const files = { 'workflow.yaml': 'version: 1\n', 'stages/work.md': null }
    expect(sameFiles(files, files)).toBe(true)
    expect(sameFiles(files, { 'stages/work.md': null, 'workflow.yaml': 'version: 1\n' })).toBe(true)
    expect(sameFiles(files, { ...files, 'workflow.yaml': 'version: 2\n' })).toBe(false)
    expect(sameFiles(files, { ...files, 'notes.md': '' })).toBe(false)
    expect(sameFiles(files, { 'workflow.yaml': 'version: 1\n', 'notes.md': null })).toBe(false)
    expect(sameFiles({}, {})).toBe(true)
  })
})

describe('instruction Checks', () => {
  const checks = (lines: string[]) => {
    const layer = factory({
      'workflow.yaml': ['stages:', '  validate:', '    checks:', ...lines, ''].join('\n'),
    })
    return {
      messages: layer.problems.map((p) => p.message),
      checks: layer.settings?.stages.validate?.checks,
    }
  }

  test('an instruction Check takes fix, timeout, agent, model and effort', () => {
    expect(
      checks([
        '      - name: Docs drift',
        '        instruction: |',
        '          Check the docs.',
        '          Fix what is out of date.',
        '        fix: true',
        '        timeout: 30m',
        '        agent: same',
        '        model: opus',
        '        effort: high',
        '      - { name: Tests, run: pnpm test, timeout: 5m }',
      ]),
    ).toEqual({
      messages: [],
      checks: [
        {
          name: 'Docs drift',
          instruction: 'Check the docs.\nFix what is out of date.\n',
          fix: true,
          timeout: '30m',
          agent: 'same',
          model: 'opus',
          effort: 'high',
        },
        { name: 'Tests', run: 'pnpm test', timeout: '5m' },
      ],
    })
  })

  test('a Check is refused with both run and instruction, neither, repo on an instruction, or fix, agent, model or effort on a command', () => {
    const refused = (line: string) => checks([`      - ${line}`]).messages
    expect(refused('{ name: A, run: x, instruction: y }')).toEqual([
      'a check has a `run` command or an `instruction`, not both',
    ])
    expect(refused('{ name: A }')).toEqual(['each check needs a `run` command or an `instruction`'])
    expect(refused('{ name: A, instruction: y, repo: ted }')).toEqual([
      'an instruction check runs across all the Task’s repos, so it takes no `repo`',
    ])
    expect(refused('{ name: A, run: x, fix: true }')).toEqual([
      'only an instruction check takes `fix`',
    ])
    expect(refused('{ name: A, run: x, agent: claude }')).toEqual([
      'only an instruction check takes `agent`',
    ])
    expect(refused('{ name: A, run: x, effort: low }')).toEqual([
      'only an instruction check takes `effort`',
    ])
    expect(refused('{ name: A, instruction: y, fix: yes }')).toEqual([
      'a check’s `fix` must be true or false',
    ])
    expect(refused('{ name: A, instruction: y, agent: gemini }')).toEqual([
      'a check’s `agent` must be codex, claude, antigravity, pi or same',
    ])
    expect(refused('{ name: A, instruction: y, timeout: soon }')).toEqual([
      '`timeout` must be a duration such as 30s, 15m or 1h',
    ])
  })

  test('a settings save writes instruction Checks after the commands, and a save of only the commands keeps them', () => {
    const instruction = {
      name: 'Docs drift',
      instruction: 'Check the docs.\nFix what is out of date.',
      fix: true,
      agent: 'claude',
      effort: 'high' as const,
    }
    const text = applyChanges(
      'version: 1\n',
      {
        checks: [{ name: 'Tests', run: 'pnpm test' }],
        instructionChecks: [instruction, { name: 'Review', instruction: 'Look again.' }],
      },
      [],
    )
    const saved = factory({ 'workflow.yaml': text })
    expect(saved.problems).toEqual([])
    expect(saved.settings?.stages.validate?.checks).toEqual([
      { name: 'Tests', run: 'pnpm test' },
      { ...instruction, instruction: 'Check the docs.\nFix what is out of date.' },
      { name: 'Review', instruction: 'Look again.' },
    ])

    const commandsOnly = applyChanges(
      text,
      { checks: [{ was: 0, name: 'Tests', run: 'pnpm test --run', timeout: '5m' }] },
      [],
    )
    expect(factory({ 'workflow.yaml': commandsOnly }).settings?.stages.validate?.checks).toEqual([
      { name: 'Tests', run: 'pnpm test --run', timeout: '5m' },
      { ...instruction, instruction: 'Check the docs.\nFix what is out of date.' },
      { name: 'Review', instruction: 'Look again.' },
    ])

    const edited = applyChanges(
      commandsOnly,
      { instructionChecks: [{ was: 2, name: 'Review', instruction: 'Look again.', fix: true }] },
      [],
    )
    expect(factory({ 'workflow.yaml': edited }).settings?.stages.validate?.checks).toEqual([
      { name: 'Tests', run: 'pnpm test --run', timeout: '5m' },
      { name: 'Review', instruction: 'Look again.', fix: true },
    ])
  })
})

describe('Cleanup settings edits', () => {
  const steps = [
    { name: 'Tell Asana', instruction: 'Comment on the Asana task.\nLink the pull request.' },
    { name: 'Stop stack', command: 'docker compose down', timeout: '2m' },
  ]
  const cleanupOf = (text: string) => {
    const layer = factory({ 'workflow.yaml': text })
    expect(layer.problems).toEqual([])
    return layer.settings?.stages.cleanup
  }

  test('a save writes enabled and the steps, and the layer checks clean', () => {
    const text = applyChanges('version: 1\n', { cleanup: { enabled: true, steps } }, [])
    expect(cleanupOf(text)).toEqual({ enabled: true, steps })
  })

  test('turning Cleanup off keeps its steps, and no steps is saved as an empty list', () => {
    const on = applyChanges('version: 1\n', { cleanup: { enabled: true, steps } }, [])
    const off = applyChanges(on, { cleanup: { enabled: false, steps } }, [])
    expect(cleanupOf(off)).toEqual({ enabled: false, steps })
    const cleared = applyChanges(off, { cleanup: { enabled: true, steps: [] } }, [])
    expect(cleanupOf(cleared)).toEqual({ enabled: true, steps: [] })
    expect(cleared).toContain('steps: []')
  })

  test('a Factory with no Cleanup steps keeps Cleanup off over a Library that turns it on', async () => {
    const libraryOn = library({
      'workflow.yaml': applyChanges('version: 1\n', { cleanup: { enabled: true, steps } }, []),
    })
    expect(resolveWorkflow([await defaults(), libraryOn]).stages).toContain('cleanup')
    for (const enabled of [true, false]) {
      const text = applyChanges('version: 1\n', { cleanup: { enabled, steps: [] } }, [])
      const resolved = resolveWorkflow([
        await defaults(),
        libraryOn,
        factory({ 'workflow.yaml': text }),
      ])
      expect(resolved.stages).not.toContain('cleanup')
    }
  })

  test('switching a step’s kind drops the other kind’s keys and keeps effort', () => {
    const text =
      'version: 1\nstages:\n  cleanup:\n    effort: low\n    enabled: true\n    steps:\n      - name: Stop stack\n        command: docker compose down\n        timeout: 2m\n'
    const edited = applyChanges(
      text,
      { cleanup: { enabled: true, steps: [{ name: 'Stop stack', instruction: 'Stop it.' }] } },
      [],
    )
    expect(cleanupOf(edited)).toEqual({
      effort: 'low',
      enabled: true,
      steps: [{ name: 'Stop stack', instruction: 'Stop it.' }],
    })
  })
})

describe('App preview size edits', () => {
  const stored = [{ repo: 'owner/web', name: 'web', cloneUrl: 'https://github.com/owner/web.git' }]
  const repo = (apps: RepoSettingsInput['apps']): RepoSettingsInput[] => [
    { was: 'web', repo: 'owner/web', name: 'web', env: [], copy: [], apps },
  ]

  test('a web App’s preview size saves, checks clean and reaches the App declaration', () => {
    const text = applyChanges(
      'version: 1\n',
      {
        repos: repo([
          { name: 'Site', kind: 'web', run: 'npm run dev', preview: 'mobile' },
          { name: 'Worker', kind: 'command', run: 'npm run worker', preview: 'tablet' },
        ]),
      },
      [],
    )
    const layer = factory({ 'workflow.yaml': text })
    expect(layer.problems).toEqual([])
    expect(text).toContain('preview: mobile')
    expect(text).not.toContain('preview: tablet')
    expect(repoSettingsFrom(layer.settings, stored)[0]?.apps).toMatchObject([
      { name: 'Site', preview: 'mobile' },
      { name: 'Worker' },
    ])
    expect(appDeclarations(layer.settings?.repos?.[0]?.apps)).toMatchObject([
      { name: 'Site', preview: 'mobile' },
      { name: 'Worker' },
    ])
    const cleared = applyChanges(
      text,
      { repos: repo([{ was: 0, name: 'Site', kind: 'web', run: 'npm run dev' }]) },
      repoSettingsFrom(layer.settings, stored),
    )
    expect(cleared).not.toContain('preview')
  })
})

describe('sandbox access through Settings edits', () => {
  test('saving Settings keeps sandbox_access on setup, teardown, Apps and command checks', () => {
    const yaml = [
      'version: 1',
      'repos:',
      '  - name: web',
      '    worktree:',
      '      setup: { run: make, sandbox_access: [ios-xcode] }',
      '      teardown: { run: clean, timeout: 5m, sandbox_access: [ios-xcode] }',
      '    apps:',
      '      - name: Sim',
      '        kind: command',
      '        run: xcodebuild',
      '        sandbox_access: [ios-xcode]',
      'stages:',
      '  validate:',
      '    checks:',
      '      - name: Build',
      '        run: xcodebuild',
      '        sandbox_access: [ios-xcode]',
      '',
    ].join('\n')
    const stored = [
      { repo: 'owner/web', name: 'web', cloneUrl: 'https://github.com/owner/web.git' },
    ]
    const edited = applyChanges(
      yaml,
      {
        repos: [
          {
            was: 'web',
            repo: 'owner/web',
            name: 'web',
            setup: { run: 'make all' },
            teardown: { run: 'clean' },
            env: [],
            copy: [],
            apps: [{ was: 0, name: 'Sim', kind: 'command', run: 'xcodebuild build' }],
          },
        ],
        checks: [{ was: 0, name: 'Build', run: 'xcodebuild test' }],
      },
      repoSettingsFrom(factory({ 'workflow.yaml': yaml }).settings, stored),
    )
    const layer = factory({ 'workflow.yaml': edited })
    expect(layer.problems).toEqual([])
    const repo = layer.settings.repos?.[0]
    expect(repo?.worktree?.setup).toEqual({ run: 'make all', sandbox_access: ['ios-xcode'] })
    expect(repo?.worktree?.teardown).toEqual({ run: 'clean', sandbox_access: ['ios-xcode'] })
    expect(appDeclarations(repo?.apps)).toMatchObject([
      { name: 'Sim', run: 'xcodebuild build', sandboxAccess: ['ios-xcode'] },
    ])
    expect(layer.settings.stages.validate?.checks).toEqual([
      { name: 'Build', run: 'xcodebuild test', sandbox_access: ['ios-xcode'] },
    ])
  })

  test('Settings read each group, add one where it is missing and remove one set to none', () => {
    const yaml = [
      'version: 1',
      'repos:',
      '  - name: web',
      '    worktree:',
      '      setup: { run: make, sandbox_access: [ios-xcode] }',
      '      teardown: clean',
      '    apps:',
      '      - name: Sim',
      '        kind: command',
      '        run: xcodebuild',
      '      - name: Old',
      '        run: serve',
      '        sandbox_access: [ios-xcode]',
      'stages:',
      '  validate:',
      '    checks:',
      '      - { name: Build, run: xcodebuild }',
      '',
    ].join('\n')
    const stored = [
      { repo: 'owner/web', name: 'web', cloneUrl: 'https://github.com/owner/web.git' },
    ]
    const current = repoSettingsFrom(factory({ 'workflow.yaml': yaml }).settings, stored)
    expect(current[0]).toMatchObject({
      setup: { run: 'make', sandboxAccess: ['ios-xcode'] },
      teardown: { run: 'clean' },
      apps: [
        { name: 'Sim', run: 'xcodebuild' },
        { name: 'Old', run: 'serve', sandboxAccess: ['ios-xcode'] },
      ],
    })
    expect(current[0]?.setup).not.toHaveProperty('sandbox_access')
    expect(current[0]?.apps[0]).not.toHaveProperty('sandboxAccess')
    const edited = applyChanges(
      yaml,
      {
        repos: [
          {
            was: 'web',
            repo: 'owner/web',
            name: 'web',
            setup: { run: 'make', sandboxAccess: [] },
            teardown: { run: 'clean', sandboxAccess: ['ios-xcode'] },
            env: [],
            copy: [],
            apps: [
              {
                was: 0,
                name: 'Sim',
                kind: 'command',
                run: 'xcodebuild',
                sandboxAccess: ['ios-xcode'],
              },
              { was: 1, name: 'Old', kind: 'web', run: 'serve', sandboxAccess: [] },
            ],
          },
        ],
        checks: [{ was: 0, name: 'Build', run: 'xcodebuild', sandboxAccess: ['ios-xcode'] }],
      },
      current,
    )
    expect(edited).toContain('setup: make\n')
    const layer = factory({ 'workflow.yaml': edited })
    expect(layer.problems).toEqual([])
    const repo = layer.settings.repos?.[0]
    expect(repo?.worktree?.setup).toEqual({ run: 'make' })
    expect(repo?.worktree?.teardown).toEqual({ run: 'clean', sandbox_access: ['ios-xcode'] })
    expect(appDeclarations(repo?.apps)).toMatchObject([
      { name: 'Sim', sandboxAccess: ['ios-xcode'] },
      { name: 'Old' },
    ])
    expect(appDeclarations(repo?.apps)[1]).not.toHaveProperty('sandboxAccess')
    expect(layer.settings.stages.validate?.checks).toEqual([
      { name: 'Build', run: 'xcodebuild', sandbox_access: ['ios-xcode'] },
    ])
  })

  test('a sign-off’s access changes compare sandbox_access between two workflow.yaml files', () => {
    const before = [
      'version: 1',
      'repos:',
      '  - name: mobile',
      '    worktree:',
      '      setup: { run: pod install, sandbox_access: [ios-xcode] }',
      '    apps:',
      '      - { name: iOS simulator, kind: command, run: sim.sh }',
      '      - { name: Gone, run: gone.sh, sandbox_access: [ios-xcode] }',
      'stages:',
      '  validate:',
      '    checks:',
      '      - { name: Build, run: xcodebuild }',
      '',
    ].join('\n')
    const after = [
      'version: 1',
      'repos:',
      '  - name: mobile',
      '    worktree:',
      '      setup: pod install',
      '    apps:',
      '      - { name: iOS simulator, kind: command, run: sim.sh, sandbox_access: [ios-xcode] }',
      'stages:',
      '  validate:',
      '    checks:',
      '      - { name: Build, run: xcodebuild, sandbox_access: [ios-xcode] }',
      '',
    ].join('\n')
    expect(workflowAccessChanges(before, after)).toEqual([
      { kind: 'setup', repo: 'mobile', name: 'setup', gained: [], lost: ['ios-xcode'] },
      { kind: 'app', repo: 'mobile', name: 'iOS simulator', gained: ['ios-xcode'], lost: [] },
      { kind: 'check', name: 'Build', gained: ['ios-xcode'], lost: [] },
      { kind: 'app', repo: 'mobile', name: 'Gone', gained: [], lost: ['ios-xcode'] },
    ])
    expect(workflowAccessChanges(after, after)).toEqual([])
    expect(workflowAccessChanges(undefined, after)).toHaveLength(2)
  })
})
