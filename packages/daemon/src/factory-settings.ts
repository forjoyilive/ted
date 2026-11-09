import { createHash, randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  FactorySettingsChanges,
  FactorySettingsView,
  IntegrationsHealth,
  RepoSettingsInput,
  RepoSettingsView,
  SaveSettingsRequest,
  SaveSettingsResult,
  SettingsPreview,
  SettingsSource,
  WorkflowProblem,
} from '@ted/protocol'
import { RequestError } from './errors.ts'
import { clonePath } from './factories.ts'
import * as git from './git.ts'
import type { Gh } from './github/gh.ts'
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
import { checkLayer, githubRepoOf, type WorkflowSettings } from './workflow/check.ts'
import { fileChange } from './workflow/diff.ts'
import {
  applyChanges,
  defaultName,
  inputProblems,
  repoSettingsFrom,
  workflowFile,
} from './workflow/edit.ts'
import { readGitLayer } from './workflow/layers.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface FactorySettings {
  view(factoryId: string): Promise<FactorySettingsView>
  preview(factoryId: string, changes: FactorySettingsChanges): Promise<SettingsPreview>
  save(factoryId: string, request: SaveSettingsRequest): Promise<SaveSettingsResult>
}

export interface FactorySettingsOptions {
  store: TedStore
  gh: Gh
  workflows: Workflows
  reposDir: string
  health: () => Promise<IntegrationsHealth | undefined>
  mergeTries?: number
  mergeWaitMs?: number
}

interface Base {
  commit: string
  text: string | undefined
  source: SettingsSource
  version: string
  settings: WorkflowSettings | undefined
  problems: WorkflowProblem[]
  repos: RepoSettingsInput[]
}

export const settingsTitle = 'Update TED settings'

export function createFactorySettings(options: FactorySettingsOptions): FactorySettings {
  const { store, gh, workflows, reposDir } = options
  const saving = new Set<string>()

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
    const files = layer?.files ?? {}
    const checked = checkLayer({ kind: 'factory', files, primaryRepo: factory.repo })
    const current = files['workflow.yaml']
    let text: string | undefined
    let source: SettingsSource
    let settings: WorkflowSettings | undefined
    if (checked.valid) {
      text = typeof current === 'string' ? current : undefined
      source = text === undefined ? 'none' : 'file'
      settings = checked.settings
    } else {
      const last = store.lastValidWorkflowLayer(`factory:${factory.id}`)
      const lastText = last?.files['workflow.yaml']
      text = typeof lastText === 'string' ? lastText : undefined
      source = text === undefined ? 'none' : 'last-valid'
      settings =
        text === undefined
          ? undefined
          : checkLayer({
              kind: 'factory',
              files: { 'workflow.yaml': text },
              primaryRepo: factory.repo,
            }).settings
    }
    const version = createHash('sha256')
      .update(`${source}\0${text ?? ''}`)
      .digest('hex')
      .slice(0, 12)
    return {
      commit,
      text,
      source,
      version,
      settings,
      problems: checked.problems,
      repos: repoSettingsFrom(settings, factory.repos),
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

  function edited(base: Base, factory: StoredFactory, changes: FactorySettingsChanges) {
    const problems = inputProblems(changes, base.repos)
    if (problems.length > 0) return { problems, text: base.text ?? '' }
    const text = applyChanges(base.text, changes, base.repos)
    const checked = checkLayer({
      kind: 'factory',
      files: { 'workflow.yaml': text },
      primaryRepo: factory.repo,
    })
    return { problems: checked.problems.filter((p) => p.severity === 'error'), text }
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
  ): Promise<{ merged: boolean; reason?: string }> {
    const tries = options.mergeTries ?? 10
    const where = `${factory.repo}’s ${target.base} branch`
    for (let attempt = 0; attempt < tries; attempt++) {
      const pr = (await readPullRequests(gh, [target])).get(target.name)
      if (!pr) return { merged: false, reason: 'GitHub didn’t return the pull request.' }
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
          return { merged: false, reason: 'The pull request was closed on GitHub.' }
        case 'changed':
          return {
            merged: false,
            reason: 'Someone pushed to the settings branch, so TED left the pull request open.',
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
      return {
        factoryId: factory.id,
        repo: factory.repo,
        defaultBranch: factory.defaultBranch,
        source: base.source,
        version: base.version,
        repos,
        problems: base.problems,
        github: await github(),
      }
    },

    async preview(factoryId, changes) {
      const factory = find(factoryId)
      const base = await load(factory, false)
      const { problems, text } = edited(base, factory, changes)
      return {
        files: problems.length > 0 ? [] : [fileChange(workflowFile, base.text ?? '', text)],
        problems,
        sideEffects: sideEffects(base, changes),
        valid: problems.length === 0 && text !== (base.text ?? ''),
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
        const { problems, text } = edited(base, factory, changes)
        const first = problems[0]
        if (first) {
          const at = first.line > 0 ? ` (line ${first.line})` : ''
          throw new RequestError(400, `${first.message}${at}`)
        }
        if (text === (base.text ?? '')) throw new RequestError(400, 'There’s nothing to save.')
        const clone = clonePath(reposDir, factory)
        const branch = `ted/settings-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`
        const commit = await git.commitAndPush(clone, {
          base: base.commit,
          files: { [workflowFile]: text },
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
        if (mode !== 'merge') return { pullRequest, merged: false }
        const method = base.settings?.repos?.[0]?.merge_method
        const result = await mergeNow(factory, {
          name: 'settings',
          repo: factory.repo,
          number: pullRequest.number,
          branch,
          base: factory.defaultBranch,
          expectedHead: commit,
          hasCi: false,
          method: method === 'merge' || method === 'rebase' ? method : 'squash',
        })
        if (result.merged) {
          await workflows.resolve(factory, { fetch: true }).catch((error: unknown) => {
            console.error(`couldn’t read ${factory.repo}’s Workflow:`, error)
          })
        }
        return { pullRequest, ...result }
      } finally {
        saving.delete(factory.id)
      }
    },
  }
}

export function storedRepos(
  store: TedStore,
  factory: StoredFactory,
  settings: WorkflowSettings | undefined,
): StoredFactoryRepo[] | undefined {
  if (!settings?.repos || settings.repos.length === 0) return undefined
  const wanted: StoredFactoryRepo[] = []
  settings.repos.forEach((entry, i) => {
    const repo =
      i === 0 ? factory.repo : entry.remote === undefined ? undefined : githubRepoOf(entry.remote)
    if (repo === undefined) return
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

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isPlainPath(file: string): boolean {
  return !path.isAbsolute(file) && !/[*?[\]{}]/.test(file) && !file.split(/[\\/]/).includes('..')
}

async function isDirectory(folder: string): Promise<boolean> {
  return (await stat(folder).catch(() => undefined))?.isDirectory() ?? false
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}
