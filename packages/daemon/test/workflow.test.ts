import { describe, expect, test } from 'vitest'
import {
  checkLayer,
  type LayerFiles,
  readDefaultLayer,
  resolveAgentChoices,
  resolveWorkflow,
} from '../src/workflow/index.ts'

const defaults = () => readDefaultLayer()

const library = (files: LayerFiles) => checkLayer({ kind: 'library', files })
const factory = (files: LayerFiles) => checkLayer({ kind: 'factory', files })

describe('TED defaults', () => {
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

  test('put Gates on Design and Review, Merge on with no Gate, and max_back 3 except Validate 5', async () => {
    const { settings } = resolveWorkflow([await defaults()])

    expect(settings.stages.design?.gate).toBe(true)
    expect(settings.stages.review?.gate).toBe(true)
    expect(settings.stages.merge).toMatchObject({ enabled: true, gate: false })
    expect(settings.stages.work?.max_back).toBe(3)
    expect(settings.stages.validate?.max_back).toBe(5)
    expect(settings.stages.validate?.loop_check).toBe(3)
    expect(settings.stages.clarify?.depth).toBe('auto')
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

  test('stages.backlog.enabled: false leaves Backlog out; Done always stays last', async () => {
    const workflow = resolveWorkflow([
      await defaults(),
      library({ 'workflow.yaml': 'version: 1\nstages:\n  backlog: { enabled: false }\n' }),
    ])

    expect(workflow.stages[0]).toBe('intake')
    expect(workflow.stages.at(-1)).toBe('done')
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
})

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
      '',
    ].join('\n')
    expect(problems({ 'workflow.yaml': apps })).toEqual([
      `error .ted/workflow.yaml 7 14 an App \`url\` must be a localhost address, such as http://localhost:\${PORT}`,
      'error .ted/workflow.yaml 8 15 two Apps would both set `TED_APP_WEB_PORT`',
      'error .ted/workflow.yaml 10 15 `port` must be a number from 1 to 65535',
      'error .ted/workflow.yaml 11 9 each App needs a `name`',
      'error .ted/workflow.yaml 12 9 the App API needs a `run` command',
      'error .ted/workflow.yaml 13 15 `kind` must be web, command or ios-simulator',
      'error .ted/workflow.yaml 14 16 `ready` must be url or start',
      'warning .ted/workflow.yaml 15 16 TED sets `PORT` itself or keeps it out of worktrees, so it ignores it here',
    ])
  })

  test('an unknown Stage id in order or stages is an error', () => {
    expect(
      problems({
        'workflow.yaml': 'version: 1\norder: [intake, security, work]\nstages:\n  deploy: {}\n',
      }),
    ).toEqual([
      'error .ted/workflow.yaml 2 17 unknown Stage `security`',
      'error .ted/workflow.yaml 4 3 unknown Stage `deploy`',
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

  test('an empty or unreadable Stage file is an error; an unknown one is ignored with a warning', () => {
    const layer = checkLayer({
      kind: 'library',
      files: { 'stages/work.md': '  \n', 'stages/design.md': null, 'stages/security.md': '# S\n' },
    })

    expect(layer.problems.map((p) => [p.severity, p.file, p.message])).toEqual([
      ['error', 'stages/work.md', 'the Stage file is empty'],
      ['error', 'stages/design.md', 'TED couldn’t read the Stage file'],
      [
        'warning',
        'stages/security.md',
        'TED has no Stage `security`, so it ignores this file. To add a step, edit the built-in Stage file it belongs to.',
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
      'error stages 1 1 TED couldn’t read the stages folder',
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
      'error .ted/workflow.yaml 1 16 `lead.agent` must be claude or codex',
      'error .ted/workflow.yaml 2 11 `reviewer` must be codex, claude or same',
      'error .ted/workflow.yaml 3 20 `planner.effort` must be one of low, medium, high, xhigh, max, ultra',
      'error .ted/workflow.yaml 4 14 `permissions` must be auto or bypass',
      'error .ted/workflow.yaml 5 19 `max_working_runs` must be a whole number above 0',
      'error .ted/workflow.yaml 7 21 `stages.clarify.depth` must be one of auto, none, few, grilling',
      'error .ted/workflow.yaml 9 15 `stages.validate.max_back` must be a whole number, 0 or more',
      'error .ted/workflow.yaml 10 17 `stages.validate.loop_check` must be a whole number above 0, or false',
      'error .ted/workflow.yaml 11 14 each Check needs a `run` command',
      'error .ted/workflow.yaml 12 23 `stages.review.based_on` must be text',
    ])
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
      '12:44 the Check’s `repo: nowhere` names no entry in `repos`',
    ])
  })

  test('a name must be lowercase letters, digits and dashes; merge_method and timeouts are checked', () => {
    expect(
      repoProblems(
        [
          'repos:',
          '  - name: My App',
          '    merge_method: fast-forward',
          '    worktree:',
          '      setup: { run: "x", timeout: soon }',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      '2:11 a repo `name` uses only lowercase letters, digits and dashes',
      '3:19 `merge_method` must be squash, merge or rebase',
      '5:35 `timeout` must be a duration such as 30s, 15m or 1h',
    ])
  })

  test('a primary remote that names another repo is ignored with a warning', () => {
    const layer = checkLayer({
      kind: 'factory',
      files: { 'workflow.yaml': 'repos:\n  - name: app\n    remote: kriya/other\n' },
      primaryRepo: 'acme/app',
    })

    expect(layer.problems.map((p) => [p.severity, p.message])).toEqual([
      ['warning', 'the primary repo is the one holding .ted/, so TED ignores this `remote`'],
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
