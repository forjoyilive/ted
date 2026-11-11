import { createHash, randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type AgentChoiceInput,
  type AgentKind,
  type AgentRowView,
  type AgentStageId,
  agentRoles,
  agentStageIds,
  type CheckView,
  type ClarifyDepth,
  type DiffLine,
  type Effort,
  type FactorySettingsChanges,
  type FactorySettingsView,
  type FileChange,
  type IntegrationsHealth,
  type InvalidSettings,
  type LayerKind,
  type MergeSettingsRequest,
  type RepoSettingsInput,
  type RepoSettingsView,
  type SaveSettingsRequest,
  type SaveSettingsResult,
  type SettingsPreview,
  type SettingsSource,
  type StageDrift,
  type StageId,
  type StageRowView,
  type Task,
  type WorkflowProblem,
} from '@ted/protocol'
import { fileChange } from '@ted/protocol/diff'
import type { CheckTries } from './check-tries.ts'
import { RequestError } from './errors.ts'
import { clonePath } from './factories.ts'
import { openTasksUsing } from './factory-removal.ts'
import type { Factories } from './factory-setup.ts'
import { exists } from './files.ts'
import * as git from './git.ts'
import type { Gh } from './github/gh.ts'
import { factoryPermissions } from './permissions.ts'
import { redactSecrets } from './redact.ts'
import type { StoredFactory, StoredFactoryRepo, TedStore } from './store/index.ts'
import {
  chooseMethod,
  deleteBranch,
  type MergeTarget,
  mergePullRequest,
  nextStep,
  readPullRequests,
} from './tasks/merge.ts'
import { parsePullRequestUrl } from './tasks/pull-requests.ts'
import type { CreateTaskInput } from './tasks/tasks.ts'
import { resolveAgentChoices } from './workflow/agent-choices.ts'
import {
  type CheckedLayer,
  checkLayer,
  githubRepoOf,
  type LayerFiles,
  maxFactoryRepos,
  type WorkflowSettings,
} from './workflow/check.ts'
import { driftView, type FoundDrift, findDrift } from './workflow/drift.ts'
import {
  applyChanges,
  defaultName,
  inputProblems,
  isRepo,
  repoSettingsFrom,
} from './workflow/edit.ts'
import { readGitLayer, stageFileHash } from './workflow/layers.ts'
import { resolveWorkflow } from './workflow/resolve.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface FactorySettings {
  view(factoryId: string): Promise<FactorySettingsView>
  preview(factoryId: string, changes: FactorySettingsChanges): Promise<SettingsPreview>
  save(factoryId: string, request: SaveSettingsRequest): Promise<SaveSettingsResult>
  merge(factoryId: string, request: MergeSettingsRequest): Promise<SaveSettingsResult>
  forget(factoryId: string): void
  mergeInherited(factoryId: string, stage: AgentStageId): Promise<Task>
}

export interface FactorySettingsOptions {
  store: TedStore
  gh: Gh
  workflows: Workflows
  reposDir: string
  health: () => Promise<IntegrationsHealth | undefined>
  factories: Pick<Factories, 'checkRepo' | 'approveRepos'>
  checkTries: Pick<CheckTries, 'list'>
  installed: (agent: AgentKind) => boolean
  createTask: (input: CreateTaskInput) => Promise<Task>
  mergeTries?: number
  mergeWaitMs?: number
}

interface Base {
  commit: string
  current: LayerFiles
  files: LayerFiles
  text: string | undefined
  source: SettingsSource
  version: string
  settings: WorkflowSettings | undefined
  problems: WorkflowProblem[]
  repos: RepoSettingsInput[]
  inherited: CheckedLayer[]
}

const knownFile = (file: string) =>
  file === 'workflow.yaml' ||
  file === 'notes.md' ||
  agentStageIds.some((id) => file === `stages/${id}.md`)

export const settingsTitle = 'Update TED settings'

export function createFactorySettings(options: FactorySettingsOptions): FactorySettings {
  const { store, gh, workflows, reposDir } = options
  const saving = new Set<string>()
  const receipts = new Map<
    string,
    {
      id: string
      target: MergeTarget
      pullRequest: SaveSettingsResult['pullRequest']
      at: number
    }
  >()

  function find(factoryId: string): StoredFactory {
    const factory = store.getFactory(factoryId)
    if (!factory) throw new RequestError(404, 'no such Factory')
    if (factory.clonedAt === undefined) {
      throw new RequestError(409, `${factory.name} is still being cloned`)
    }
    return factory
  }

  async function load(factory: StoredFactory, fetch: boolean): Promise<Base> {
    const clone = clonePath(reposDir, factory)
    if (fetch) {
      await workflows.resolve(factory, { fetch: true }).catch((error: unknown) => {
        console.error(`couldn’t read ${factory.repo}’s Workflow:`, error)
      })
    }
    const commit = await git.revParse(clone, `origin/${factory.defaultBranch}`)
    const layer = await readGitLayer(clone, commit)
    const current = layer?.files ?? {}
    const checked = checkLayer({ kind: 'factory', files: current, primaryRepo: factory.repo })
    let files: LayerFiles
    let source: SettingsSource
    if (checked.valid) {
      files = current
      source = typeof current['workflow.yaml'] === 'string' ? 'file' : 'none'
    } else {
      const last = store.lastValidWorkflowLayer(`factory:${factory.id}`)
      files = last?.files ?? {}
      source = typeof files['workflow.yaml'] === 'string' ? 'last-valid' : 'none'
    }
    const shown = checkLayer({ kind: 'factory', files, primaryRepo: factory.repo })
    const workflowText = files['workflow.yaml']
    const text = typeof workflowText === 'string' ? workflowText : undefined
    const settings = text === undefined ? undefined : shown.settings
    const hash = createHash('sha256').update(`${source}\0`)
    for (const [name, value] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      if (knownFile(name)) hash.update(`${name}\0${value ?? '\0unreadable'}\0`)
    }
    return {
      commit,
      current,
      files,
      text,
      source,
      version: hash.digest('hex').slice(0, 12),
      settings,
      problems: checked.problems,
      repos: repoSettingsFrom(settings, factory.repos),
      inherited: await workflows.inherited(),
    }
  }

  async function github(): Promise<FactorySettingsView['github']> {
    const health = await options.health().catch(() => undefined)
    if (!health) return { ready: false, problem: 'TED couldn’t check GitHub.' }
    const { cli, hosts } = health.github
    if (cli.state === 'not-installed') {
      return { ready: false, problem: 'The GitHub CLI isn’t installed, so TED can’t save.' }
    }
    if (cli.state !== 'ready') {
      return { ready: false, problem: 'The GitHub CLI needs fixing before TED can save.' }
    }
    const host = hosts.find((h) => h.host === 'github.com')
    if (!host || host.state === 'signed-out') {
      return { ready: false, problem: 'GitHub is signed out, so TED can’t save.' }
    }
    return {
      ready: host.state !== 'failed',
      ...(host.login !== undefined && { login: host.login }),
      ...(host.state === 'failed' && { problem: 'TED couldn’t reach GitHub.' }),
    }
  }

  async function localFolder(repo: RepoSettingsInput) {
    const folder = store.localFolder(repo.repo)
    if (folder === undefined) return undefined
    const found = await isDirectory(folder)
    const copies = await Promise.all(
      repo.copy
        .filter((file) => isPlainPath(file))
        .map(async (file) => ({
          path: file,
          found: found && (await exists(path.join(folder, file))),
        })),
    )
    return { path: folder, found, copies }
  }

  function edited(
    base: Base,
    factory: StoredFactory,
    changes: FactorySettingsChanges,
  ): { problems: WorkflowProblem[]; files: Record<string, string | null> } {
    if (changes.permissions !== undefined) {
      throw new RequestError(
        400,
        'Permission mode is local to this computer; use Factory settings permissions',
      )
    }
    const problems = [
      ...inputProblems(changes, base.repos),
      ...removalProblems(base, factory, changes),
    ]
    if (problems.length > 0) return { problems, files: {} }
    const inherited = resolveWorkflow(base.inherited)
    const basedOn: Partial<Record<AgentStageId, string | null>> = {}
    const after: LayerFiles = Object.fromEntries(
      Object.entries(base.files).filter(([name]) => knownFile(name)),
    )
    for (const [id, text] of Object.entries(changes.stageFiles ?? {}) as [
      AgentStageId,
      string | null | undefined,
    ][]) {
      if (text === undefined) continue
      const file = `stages/${id}.md`
      if (text === null) {
        if (after[file] !== undefined) basedOn[id] = null
        delete after[file]
        continue
      }
      if (typeof after[file] !== 'string') {
        const from = inherited.stageFile(id)
        if (from) basedOn[id] = stageFileHash(from.text)
      }
      after[file] = text
    }
    for (const id of changes.keepStageFiles ?? []) {
      const from = inherited.stageFile(id)
      if (typeof after[`stages/${id}.md`] === 'string' && from && basedOn[id] === undefined) {
        basedOn[id] = stageFileHash(from.text)
      }
    }
    if (changes.notes !== undefined) {
      if (changes.notes.trim() === '') delete after['notes.md']
      else after['notes.md'] = changes.notes
    }
    after['workflow.yaml'] = applyChanges(base.text, changes, base.repos, basedOn)
    const checked = checkLayer({ kind: 'factory', files: after, primaryRepo: factory.repo })
    const errors = checked.problems.filter((p) => p.severity === 'error')
    if (errors.length > 0) return { problems: errors, files: {} }
    const writes: Record<string, string | null> = {}
    const names = new Set([...Object.keys(after), ...Object.keys(base.current)])
    for (const name of [...names].filter(knownFile).sort(fileOrder)) {
      const next = after[name] ?? null
      const before = base.current[name]
      if (before === undefined && next === null) continue
      if (next !== before) writes[`.ted/${name}`] = next
    }
    return { problems: [], files: writes }
  }

  function removalProblems(
    base: Base,
    factory: StoredFactory,
    changes: FactorySettingsChanges,
  ): WorkflowProblem[] {
    return base.repos.flatMap((repo) => {
      if (changes.repos.some((r) => r.was === repo.was)) return []
      const open = openTasksUsing(store, factory, repo.repo)
      if (open.length === 0) return []
      return [
        {
          severity: 'error' as const,
          file: '.ted/workflow.yaml',
          line: 0,
          column: 0,
          message: `${repo.repo} is in the Repos field of open Tasks ${open.map((t) => t.displayId).join(', ')}. Remove it from them, or finish or archive them, first.`,
        },
      ]
    })
  }

  function fileChanges(base: Base, files: Record<string, string | null>): FileChange[] {
    return Object.entries(files).map(([file, text]) => {
      const before = base.current[file.slice('.ted/'.length)]
      return fileChange(file, typeof before === 'string' ? before : '', text ?? '')
    })
  }

  function stageRows(base: Base): StageRowView[] {
    const own = checkLayer({ kind: 'factory', files: base.files })
    const inherited = resolveWorkflow(base.inherited)
    const full = resolveWorkflow([...base.inherited, own])
    const drifts = findDrift(base.inherited, own)
    const ids: StageId[] = ['backlog', ...agentStageIds, 'done']
    const { overnightMode } = store.settings()
    return ids.map((id) => {
      const stage = full.settings.stages[id]
      const agent = id !== 'backlog' && id !== 'done' ? id : undefined
      const inOrder = agent === undefined || full.order.includes(agent)
      const drift = drifts.find((d) => d.stage === id)
      const file = agent ? full.stageFile(agent) : undefined
      const from = agent ? inherited.stageFile(agent) : undefined
      const factoryFile = agent ? own.stageFiles[agent] : undefined
      const basedOn = own.settings.stages[id]?.based_on
      return {
        id,
        inOrder,
        enabled: inOrder && (id === 'done' || stage?.enabled !== false),
        gate: stage?.gate === true,
        ...(agent && {
          effort: (own.settings.stages[id]?.effort ?? null) as Effort | null,
          ...(inherited.settings.stages[id]?.effort !== undefined && {
            inheritedEffort: inherited.settings.stages[id]?.effort as Effort,
          }),
          inheritedEffortFrom:
            base.inherited
              .slice()
              .reverse()
              .find((layer) => layer.settings.stages[id]?.effort !== undefined)?.kind ?? 'ted',
        }),
        ...(agent && stage?.gate === true && overnightMode && { overnight: true as const }),
        ...(stage?.max_back !== undefined && agent && { maxBack: stage.max_back }),
        ...(id === 'clarify' && { depth: (stage?.depth ?? 'auto') as ClarifyDepth }),
        ...(id === 'validate' && {
          p1OnlyFrom: stage?.p1_only_from ?? false,
          subAgents: stage?.sub_agents === true,
        }),
        ...(id === 'work' && { leadClosesFailures: stage?.lead_closes_failures === true }),
        from: file?.layer ?? 'ted',
        ...(factoryFile !== undefined && { factoryFile }),
        ...(from &&
          from.layer !== 'factory' && { inherited: { layer: from.layer, text: from.text } }),
        ...(basedOn !== undefined && { basedOn }),
        ...(drift && { drift: driftView(drift, (hash) => store.seenStageFileText(hash)) }),
      }
    })
  }

  function agentRows(base: Base): AgentRowView[] {
    const inherited = resolveWorkflow(base.inherited).settings
    const library = base.inherited.find((l) => l.kind === 'library')?.settings
    const resolved = resolveAgentChoices(inherited, {
      claude: options.installed('claude'),
      codex: options.installed('codex'),
    })
    return agentRoles.map((role) => {
      const own = base.settings?.[role]
      const shown = { ...inherited[role], agent: inherited[role]?.agent ?? resolved[role].agent }
      const inheritedFrom: LayerKind = library?.[role] ? 'library' : 'ted'
      return {
        role,
        ...(own && { own: choiceInput(own) }),
        inherited: choiceInput(shown),
        inheritedFrom,
        from: own ? 'factory' : inheritedFrom,
      }
    })
  }

  async function invalid(factory: StoredFactory, base: Base): Promise<InvalidSettings | undefined> {
    const error = base.problems.find((p) => p.severity === 'error')
    if (!error) return undefined
    const last = store.lastValidWorkflowLayer(`factory:${factory.id}`)
    const at = last
      ? await git
          .commitDate(clonePath(reposDir, factory), last.version)
          .catch(() => last.acceptedAt)
      : undefined
    const url = `https://github.com/${factory.repo}/blob/${encodeURIComponent(factory.defaultBranch)}/${error.file}${error.line > 0 ? `#L${error.line}` : ''}`
    return {
      file: error.file,
      line: error.line,
      column: error.column,
      message: error.message,
      url,
      ...(last && at !== undefined && { lastValid: { version: last.version, at } }),
    }
  }

  function sideEffects(base: Base, changes: FactorySettingsChanges): string[] {
    const effects: string[] = []
    for (const repo of changes.repos) {
      if (repo.was === undefined) {
        effects.push(
          `TED clones ${repo.repo} once this merges. A New setup Task can set up its Checks and Apps.`,
        )
      } else if (repo.was !== repo.name) {
        effects.push(`Checks that run in ${repo.was} now run in ${repo.name}.`)
      }
    }
    for (const repo of base.repos) {
      if (!changes.repos.some((r) => r.was === repo.was)) {
        effects.push(
          `${repo.repo} leaves the Factory with its Apps and Checks. Its clone is deleted once no Factory uses it.`,
        )
      }
    }
    return effects
  }

  async function mergeNow(
    factory: StoredFactory,
    target: MergeTarget,
  ): Promise<{ merged: boolean; reason?: string; terminal?: true }> {
    const tries = options.mergeTries ?? 10
    const where = `${factory.repo}’s ${target.base} branch`
    for (let attempt = 0; attempt < tries; attempt++) {
      const pr = (
        await readPullRequests(gh, [{ key: target.name, repo: target.repo, number: target.number }])
      ).get(target.name)
      if (!pr) return { merged: false, reason: 'GitHub didn’t return the pull request.' }
      if (pr.baseRefName !== target.base) {
        return {
          merged: false,
          reason: 'The pull request’s target branch changed. Review it on GitHub.',
          terminal: true,
        }
      }
      const step = nextStep(target, pr)
      switch (step.kind) {
        case 'merged':
          return { merged: true }
        case 'merge': {
          const method = chooseMethod(target.method, pr.allowed)
          if (!method)
            return { merged: false, reason: `GitHub allows no merge method on ${factory.repo}.` }
          try {
            await mergePullRequest(gh, target, method, { auto: false })
          } catch (error) {
            const message = redactSecrets(error instanceof Error ? error.message : String(error))
            return { merged: false, reason: `GitHub didn’t merge it: ${message}` }
          }
          if (!pr.deleteBranchOnMerge) {
            await deleteBranch(gh, target).catch((error: unknown) =>
              console.error(
                `couldn’t delete the branch ${target.branch} on ${target.repo}:`,
                redactSecrets(error instanceof Error ? error.message : String(error)),
              ),
            )
          }
          return { merged: true }
        }
        case 'wait':
          if (step.on === 'review') {
            return {
              merged: false,
              reason: `${where} needs an approving review, so TED left the pull request open.`,
            }
          }
          if (pr.mergeStateStatus === 'BLOCKED') {
            return {
              merged: false,
              reason: `${where} needs passing checks before merging, so TED left the pull request open.`,
            }
          }
          break
        case 'conflict':
          return {
            merged: false,
            reason: `The pull request conflicts with ${target.base}, so TED left it open.`,
          }
        case 'behind':
          return {
            merged: false,
            reason: `${target.base} changed after TED saved, so TED left the pull request open.`,
          }
        case 'closed':
          return { merged: false, reason: 'The pull request was closed on GitHub.', terminal: true }
        case 'changed':
          return {
            merged: false,
            reason:
              'Someone pushed to the settings branch. Review the changes on GitHub before merging.',
            terminal: true,
          }
        default:
          break
      }
      await sleep(options.mergeWaitMs ?? 1000)
    }
    return {
      merged: false,
      reason: 'GitHub hasn’t said whether the pull request can merge yet, so TED left it open.',
    }
  }

  return {
    async view(factoryId) {
      const factory = find(factoryId)
      const base = await load(factory, true)
      const repos: RepoSettingsView[] = await Promise.all(
        base.repos.map(async (repo, i) => {
          const folder = await localFolder(repo)
          return {
            ...repo,
            was: repo.was ?? repo.name,
            primary: i === 0,
            ...(folder && { localFolder: folder }),
          }
        }),
      )
      const checks: CheckView[] = (base.settings?.stages.validate?.checks ?? []).map((c, was) => ({
        was,
        name: c.name,
        run: c.run,
        ...(c.repo !== undefined && { repo: c.repo }),
        ...(c.timeout !== undefined && { timeout: c.timeout }),
      }))
      const notes = base.files['notes.md']
      const problem = await invalid(factory, base)
      return {
        factoryId: factory.id,
        repo: factory.repo,
        defaultBranch: factory.defaultBranch,
        source: base.source,
        version: base.version,
        repos,
        problems: base.problems,
        github: await github(),
        stages: stageRows(base),
        ignoredStageFiles: Object.keys(base.current)
          .filter((name) => name.startsWith('stages/') && !knownFile(name))
          .map((name) => `.ted/${name}`),
        checks,
        tries: await options.checkTries.list(factory.id),
        agents: agentRows(base),
        permissions: factoryPermissions(store, factory.id),
        repoPermissions: base.settings?.permissions === 'bypass' ? 'bypass' : 'auto',
        ...(base.settings?.max_working_runs !== undefined && {
          maxWorkingRuns: base.settings.max_working_runs,
        }),
        machineMaxWorkingRuns: store.settings().maxWorkingRuns,
        notes: typeof notes === 'string' ? notes : '',
        ...(problem && { invalid: problem }),
      }
    },

    async preview(factoryId, changes) {
      const factory = find(factoryId)
      const base = await load(factory, false)
      const { problems, files } = edited(base, factory, changes)
      return {
        files: fileChanges(base, files),
        problems,
        sideEffects: sideEffects(base, changes),
        valid: problems.length === 0 && Object.keys(files).length > 0,
        turnsOnBypass: false,
      }
    },

    async save(factoryId, { changes, mode, version }) {
      const factory = find(factoryId)
      const account = await github()
      if (!account.ready) throw new RequestError(409, account.problem ?? 'GitHub isn’t ready.')
      if (saving.has(factory.id)) {
        throw new RequestError(409, 'TED is already saving this Factory’s settings.')
      }
      saving.add(factory.id)
      try {
        const base = await load(factory, true)
        if (base.version !== version) {
          throw new RequestError(
            409,
            'The TED settings changed on GitHub after this page loaded. Discard your changes to see them, then edit again.',
          )
        }
        const { problems, files } = edited(base, factory, changes)
        const first = problems[0]
        if (first) {
          const at = first.line > 0 ? ` (line ${first.line})` : ''
          throw new RequestError(400, `${first.message}${at}`)
        }
        if (Object.keys(files).length === 0) throw new RequestError(400, 'There’s nothing to save.')
        const added = changes.repos.filter((r) => r.was === undefined).map((r) => r.repo)
        for (const repo of added) {
          const check = await options.factories.checkRepo({
            source: { remote: repo },
            primary: false,
          })
          if (!check.ok) throw new RequestError(409, check.problem?.text ?? `TED can’t add ${repo}`)
        }
        const clone = clonePath(reposDir, factory)
        const branch = `ted/settings-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`
        const commit = await git.commitAndPush(clone, {
          base: base.commit,
          files,
          message: settingsTitle,
          branch,
          url: factory.cloneUrl,
        })
        const out = await gh.run(
          [
            'pr',
            'create',
            '--repo',
            factory.repo,
            '--head',
            branch,
            '--base',
            factory.defaultBranch,
            '--title',
            settingsTitle,
            '--body-file',
            '-',
          ],
          { input: pullRequestBody(sideEffects(base, changes)) },
        )
        const pullRequest = parsePullRequestUrl(out)
        if (!pullRequest) throw new RequestError(502, 'GitHub didn’t return the pull request.')
        options.factories.approveRepos(factory.id, added)
        const method = base.settings?.repos?.[0]?.merge_method
        const target: MergeTarget = {
          name: 'settings',
          repo: factory.repo,
          number: pullRequest.number,
          branch,
          base: factory.defaultBranch,
          expectedHead: commit,
          hasCi: false,
          method: method === 'merge' || method === 'rebase' ? method : 'squash',
        }
        if (!store.getFactory(factory.id)) throw new RequestError(404, 'no such Factory')
        const receipt = randomBytes(16).toString('hex')
        receipts.set(factory.id, { id: receipt, target, pullRequest, at: Date.now() })
        if (mode !== 'merge') return { pullRequest, merged: false, receipt }
        const { terminal, ...result } = await mergeNow(factory, target)
        if (result.merged) {
          await workflows.resolve(factory, { fetch: true }).catch((error: unknown) => {
            console.error(`couldn’t read ${factory.repo}’s Workflow:`, error)
          })
        }
        return { pullRequest, ...result, ...(terminal ? {} : { receipt }) }
      } finally {
        saving.delete(factory.id)
      }
    },

    forget(factoryId) {
      receipts.delete(factoryId)
    },

    async merge(factoryId, { receipt }) {
      const factory = find(factoryId)
      if (saving.has(factory.id)) {
        throw new RequestError(409, 'TED is already saving or merging this Factory’s settings.')
      }
      saving.add(factory.id)
      try {
        const saved = receipts.get(factory.id)
        if (!saved || saved.id !== receipt || Date.now() - saved.at > 24 * 60 * 60 * 1000) {
          if (saved && Date.now() - saved.at > 24 * 60 * 60 * 1000) receipts.delete(factory.id)
          throw new RequestError(
            409,
            'TED no longer has this settings save. Open the pull request on GitHub to review and merge it.',
          )
        }
        if (saved.target.repo !== factory.repo || saved.target.base !== factory.defaultBranch) {
          throw new RequestError(
            409,
            'The Factory’s repo or default branch changed. Review the pull request on GitHub.',
          )
        }
        const account = await github()
        if (!account.ready) throw new RequestError(409, account.problem ?? 'GitHub isn’t ready.')
        const { terminal, ...result } = await mergeNow(factory, saved.target)
        if (result.merged) {
          await workflows.resolve(factory, { fetch: true }).catch((error: unknown) => {
            console.error(
              `couldn’t read ${factory.repo}’s Workflow:`,
              redactSecrets(error instanceof Error ? error.message : String(error)),
            )
          })
        }
        return { pullRequest: saved.pullRequest, ...result, ...(terminal ? {} : { receipt }) }
      } catch (error) {
        if (error instanceof RequestError) throw error
        throw new RequestError(
          502,
          redactSecrets(error instanceof Error ? error.message : String(error)),
        )
      } finally {
        saving.delete(factory.id)
      }
    },

    async mergeInherited(factoryId, stage) {
      const factory = find(factoryId)
      const base = await load(factory, true)
      const own = checkLayer({ kind: 'factory', files: base.files })
      const drift = findDrift(base.inherited, own).find((d) => d.stage === stage)
      if (!drift) {
        throw new RequestError(409, `${stage}.md has no inherited changes to merge`)
      }
      const view = driftView(drift, (hash) => store.seenStageFileText(hash))
      return options.createTask({
        title: `Merge inherited changes into ${stage}.md`,
        description: mergeDescription(drift, view),
        factory: factory.key,
        priority: 'none',
        clarifyDepth: 'none',
        forcedGates: ['review'],
        changesSettings: true,
        start: true,
      })
    },
  }
}

export function storedRepos(
  store: TedStore,
  factory: StoredFactory,
  settings: WorkflowSettings | undefined,
): StoredFactoryRepo[] | undefined {
  if (!settings?.repos || settings.repos.length === 0) return undefined
  if (settings.repos.length > maxFactoryRepos) return undefined
  const wanted: StoredFactoryRepo[] = []
  settings.repos.forEach((entry, i) => {
    const repo =
      i === 0 ? factory.repo : entry.remote === undefined ? undefined : githubRepoOf(entry.remote)
    if (repo === undefined || !isRepo(repo)) return
    if (wanted.some((w) => same(w.repo, repo))) return
    const known = factory.repos.find((r) => same(r.repo, repo))
    const ssh =
      entry.remote !== undefined && /^(?:ssh:\/\/|[^@/:]+@github\.com:)/i.test(entry.remote)
    wanted.push({
      repo: known?.repo ?? repo,
      name: entry.name ?? defaultName(repo),
      cloneUrl:
        known?.cloneUrl ?? (ssh ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`),
    })
  })
  if (factory.repos.every((kept) => wanted.some((w) => same(w.repo, kept.repo)))) return wanted
  const inUse = new Set(
    store
      .listTasks()
      .filter((t) => t.factoryId === factory.id && t.stage !== 'done' && !t.archived)
      .flatMap((t) => t.repos.map((r) => r.repo.toLowerCase())),
  )
  for (const kept of factory.repos) {
    if (!wanted.some((w) => same(w.repo, kept.repo)) && inUse.has(kept.repo.toLowerCase())) {
      wanted.push(kept)
    }
  }
  return wanted
}

function pullRequestBody(effects: string[]): string {
  return [
    'TED settings changed from Factory settings.',
    ...effects.map((e) => `- ${e}`),
    '---',
    'Opened by TED.',
  ].join('\n\n')
}

function mergeDescription(drift: FoundDrift, view: StageDrift): string {
  const file = `${drift.stage}.md`
  const source = drift.layer === 'ted' ? `TED’s default ${file}` : `The Library’s ${file}`
  const changes =
    view.diffOf === 'inherited'
      ? [
          '## Inherited changes',
          `What changed in ${source} since this Factory’s copy was made:`,
          fenced('diff', diffText(view.diff)),
        ]
      : [
          '## Inherited file now',
          `TED doesn’t have the version this copy was made from, so this is the whole of ${source} as it is now:`,
          fenced('markdown', drift.inherited),
        ]
  return [
    `${source} changed after this Factory overrode it. The override, .ted/stages/${file}, is based on ${drift.basedOn}; the inherited file is now ${drift.current}.`,
    `Fold the inherited changes into .ted/stages/${file}, keeping this Factory’s own changes, then set \`stages.${drift.stage}.based_on\` in .ted/workflow.yaml to \`${drift.current}\`. Change nothing else in .ted/.`,
    'Design has nothing to do for this Task: skip it.',
    ...changes,
    `## Current override (.ted/stages/${file})`,
    fenced('markdown', drift.own),
  ].join('\n\n')
}

function diffText(lines: readonly DiffLine[]): string {
  const marks = { same: ' ', added: '+', removed: '-' } as const
  return lines
    .map((line) => (line.kind === 'gap' ? `@@ ${line.text} @@` : `${marks[line.kind]}${line.text}`))
    .join('\n')
}

function fenced(language: string, text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}`
}

function fileOrder(a: string, b: string): number {
  const rank = (name: string) => (name === 'workflow.yaml' ? 0 : name === 'notes.md' ? 2 : 1)
  return rank(a) - rank(b) || a.localeCompare(b)
}

function choiceInput(choice: {
  agent?: string
  model?: string
  effort?: string
}): AgentChoiceInput {
  return {
    ...(choice.agent !== undefined && { agent: choice.agent }),
    ...(choice.model !== undefined && { model: choice.model }),
    ...(choice.effort !== undefined && { effort: choice.effort as Effort }),
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isPlainPath(file: string): boolean {
  return !path.isAbsolute(file) && !/[*?[\]{}]/.test(file) && !file.split(/[\\/]/).includes('..')
}

async function isDirectory(folder: string): Promise<boolean> {
  return (await stat(folder).catch(() => undefined))?.isDirectory() ?? false
}
