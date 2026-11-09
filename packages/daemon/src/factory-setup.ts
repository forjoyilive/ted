import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type CheckRepoRequest,
  type CreateFactoryRequest,
  type DaemonEvent,
  type Factory,
  keyProblem,
  type RepoCheck,
  type RepoProblem,
  type RepoSetup,
  type RepoSource,
  repoNamePattern,
} from '@ted/protocol'
import type { Banners } from './banners.ts'
import { RequestError } from './errors.ts'
import { cloneRemoved } from './factories.ts'
import * as git from './git.ts'
import { type Gh, GhError } from './github/gh.ts'
import type { IdleTimer } from './idle.ts'
import { redactSecrets } from './redact.ts'
import {
  basicFactory,
  placeholderFactory,
  type StoredFactory,
  type StoredFactoryRepo,
  type TedStore,
} from './store/index.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface Factories {
  list(): Promise<Factory[]>
  get(id: string): Promise<Factory>
  checkRepo(request: CheckRepoRequest): Promise<RepoCheck>
  create(request: CreateFactoryRequest): Promise<Factory>
  retry(factoryId: string): Promise<Factory>
  setLocalFolder(key: string, folder: string): Promise<Factory>
  rename(factoryId: string, name: string): Promise<Factory>
  setRepoFolder(factoryId: string, repoName: string, folder: string | undefined): Promise<Factory>
  syncRepos(factoryId: string, repos: StoredFactoryRepo[]): Promise<void>
  checkLocalFolders(): Promise<void>
  isCloned(factoryId: string): boolean
  start(): void
  close(): Promise<void>
}

export interface FactoriesOptions {
  store: TedStore
  banners: Banners
  gh: Gh
  workflows: Workflows
  reposDir: string
  emit: (event: DaemonEvent) => void
  login?: () => string | undefined
  onCloned?: (factory: StoredFactory) => void
  retryEveryMs?: number
  idle?: IdleTimer
}

export const cloneFailedProblem = 'clone-failed'
export const localFolderProblem = 'local-folder-missing'
export const repoAddedProblem = 'repo-added'
const maxNameLength = 60
const maxRepos = 10
const githubHost = 'github.com'
const segment = /^[A-Za-z0-9_.-]+$/

export function createFactories(options: FactoriesOptions): Factories {
  const { store, banners, gh, workflows, reposDir, emit } = options
  const progress = new Map<string, Map<string, RepoSetup>>()
  const running = new Map<string, Promise<void>>()
  const stopping = new AbortController()
  let timer: NodeJS.Timeout | undefined

  const account = () => {
    const login = options.login?.()
    return login === undefined
      ? 'the GitHub account TED uses'
      : `the GitHub account TED uses (${login})`
  }

  function find(id: string): StoredFactory {
    const factory = store.getFactory(id)
    if (!factory) throw new RequestError(404, 'no such Factory')
    return factory
  }

  async function view(factory: StoredFactory): Promise<Factory> {
    const repos = await Promise.all(
      factory.repos.map(async ({ repo, name }) => {
        const localFolder = await folderState(store.localFolder(repo))
        return { repo, name, ...(localFolder && { localFolder }) }
      }),
    )
    const primary = repos[0]?.localFolder
    const states = progress.get(factory.id)
    return {
      ...basicFactory(factory),
      repos,
      ...(primary && { localFolder: primary }),
      ...(factory.clonedAt === undefined && {
        setup: factory.repos.map(
          ({ repo }) => states?.get(repo) ?? { repo, state: 'waiting' as const },
        ),
      }),
    }
  }

  async function publish(factory: StoredFactory): Promise<Factory> {
    const shown = await view(factory)
    emit({ type: 'factory-updated', factory: shown })
    return shown
  }

  function setRepo(factory: StoredFactory, setup: RepoSetup): void {
    const states = progress.get(factory.id) ?? new Map<string, RepoSetup>()
    states.set(setup.repo, setup)
    progress.set(factory.id, states)
    void publish(factory).catch(() => undefined)
  }

  async function checkRepo({ source, primary }: CheckRepoRequest): Promise<RepoCheck> {
    const found = await locate(source)
    if ('problem' in found) {
      return {
        ok: false,
        notes: [],
        ...('folder' in found && { folder: found.folder }),
        problem: found.problem,
      }
    }
    const { repo, folder } = found
    const base = { repo, ...(folder !== undefined && { folder }) }
    const fail = (problem: RepoProblem): RepoCheck => ({ ...base, ok: false, notes: [], problem })

    let info: { full_name?: unknown; default_branch?: unknown; permissions?: { push?: unknown } }
    try {
      info = (await gh.api(`repos/${repo}`)) as typeof info
    } catch (error) {
      return fail(ghProblem(error, repo))
    }
    const canonical = typeof info.full_name === 'string' ? info.full_name : repo
    const defaultBranch = typeof info.default_branch === 'string' ? info.default_branch : 'main'
    const checked = { ...base, repo: canonical, defaultBranch, name: repoName(canonical) }
    const failChecked = (problem: RepoProblem): RepoCheck => ({
      ...checked,
      ok: false,
      notes: [],
      problem,
    })

    const owner = primary ? primaryOwner(canonical) : undefined
    if (owner) {
      return failChecked({
        kind: 'primary-elsewhere',
        text: `${canonical} is the primary repo of Factory ${owner.name}.`,
        detail: 'Add it as a second repo, or open that Factory.',
        fixes: [{ kind: 'open-factory', factoryId: owner.id, factoryName: owner.name }],
      })
    }
    if (info.permissions?.push !== true) {
      return failChecked({
        kind: 'read-only',
        text: `You can read ${canonical} but not push to it.`,
        detail: `TED pushes Task branches and opens pull requests, so ${account()} needs write access. Fork-only repos aren’t supported yet.`,
        fixes: [{ kind: 'check-again' }],
      })
    }
    try {
      await gh.api(`repos/${canonical}/commits?per_page=1`)
    } catch (error) {
      if (error instanceof GhError && error.status === 409) {
        return failChecked({
          kind: 'empty',
          text: 'This repo has no commits yet.',
          detail:
            'Task branches start from the default branch. Push a first commit, then check again.',
          fixes: [{ kind: 'check-again' }],
        })
      }
      return failChecked(ghProblem(error, canonical))
    }

    const notes: string[] = []
    const users = store
      .listFactories()
      .filter((f) => f.repos.some((r) => sameRepo(r.repo, canonical)))
      .map((f) => f.name)
    if (users.length > 0) {
      notes.push(`Also used by Factory ${users.join(', ')}. TED shares one clone between them.`)
    }
    if (primary) {
      const hasSettings = await gh
        .api(`repos/${canonical}/contents/.ted?ref=${encodeURIComponent(defaultBranch)}`)
        .then(
          () => true,
          () => false,
        )
      if (hasSettings) {
        notes.push(
          'Has TED settings already. They’ll be used, and the setup Task will wait in Backlog.',
        )
      }
    }
    return { ...checked, ok: true, notes }
  }

  function primaryOwner(repo: string): StoredFactory | undefined {
    return store.listFactories().find((f) => sameRepo(f.repo, repo))
  }

  function ghProblem(error: unknown, repo: string): RepoProblem {
    if (error instanceof GhError && (error.kind === 'missing' || error.kind === 'auth')) {
      return {
        kind: 'github',
        text:
          error.kind === 'missing'
            ? 'TED needs the GitHub CLI to check this repo.'
            : 'Sign in to GitHub so TED can check this repo.',
        fixes: [{ kind: 'github-settings' }],
      }
    }
    if (error instanceof GhError && error.status === 404) {
      return {
        kind: 'not-found',
        text: 'Repository not found, or your GitHub account can’t see it.',
        detail: `Check the spelling. A private repo needs access for ${account()}.`,
        fixes: [{ kind: 'check-again' }, { kind: 'github-settings' }],
      }
    }
    const reason = error instanceof Error ? error.message : String(error)
    return {
      kind: 'failed',
      text: `Couldn’t check ${repo}.`,
      detail: redactSecrets(reason),
      fixes: [{ kind: 'check-again' }],
    }
  }

  async function create(request: CreateFactoryRequest): Promise<Factory> {
    const name = typeof request.name === 'string' ? request.name.trim() : ''
    if (name === '') throw new RequestError(400, 'a Factory needs a name')
    const taken = [
      ...store.listFactories(),
      { key: placeholderFactory.key, name: 'the dev placeholder' },
    ]
    const keyError = keyProblem(request.key, taken)
    if (keyError)
      throw new RequestError(taken.some((f) => f.key === request.key) ? 409 : 400, keyError)
    if (!Array.isArray(request.repos) || request.repos.length === 0) {
      throw new RequestError(400, 'a Factory needs at least one repo')
    }
    if (request.repos.length > maxRepos) {
      throw new RequestError(400, `a Factory can have at most ${maxRepos} repos`)
    }
    const names = request.repos.map((r) => r.name)
    for (const repoName of names) {
      if (typeof repoName !== 'string' || !repoNamePattern.test(repoName)) {
        throw new RequestError(400, 'a repo name uses only lowercase letters, digits and -')
      }
    }
    if (new Set(names).size !== names.length) {
      throw new RequestError(400, 'each repo in a Factory needs its own name')
    }

    const checks = await Promise.all(
      request.repos.map((r, i) => checkRepo({ source: r.source, primary: i === 0 })),
    )
    const failed = checks.find((c) => !c.ok)
    if (failed) {
      throw new RequestError(409, failed.problem?.text ?? 'a repo didn’t pass its access check')
    }
    const repos: StoredFactoryRepo[] = await Promise.all(
      checks.map(async (check, i) => ({
        repo: check.repo ?? '',
        name: names[i] ?? '',
        cloneUrl: await cloneUrlFor(request.repos[i]?.source, check.repo ?? ''),
      })),
    )
    if (new Set(repos.map((r) => r.repo.toLowerCase())).size !== repos.length) {
      throw new RequestError(400, 'the same repo is in the list twice')
    }
    const primary = checks[0]
    const again = keyProblem(request.key, [
      ...store.listFactories(),
      { key: placeholderFactory.key, name: 'the dev placeholder' },
    ])
    if (again) throw new RequestError(409, again)
    if (primary?.repo !== undefined && primaryOwner(primary.repo)) {
      throw new RequestError(409, `${primary.repo} is already the primary repo of a Factory`)
    }

    const factory = store.createFactory({
      key: request.key,
      name,
      repos,
      defaultBranch: primary?.defaultBranch ?? 'main',
      showTutorial: request.showTutorial === true,
    })
    checks.forEach((check, i) => {
      const repo = repos[i]?.repo
      if (check.folder !== undefined && repo !== undefined) store.setLocalFolder(repo, check.folder)
    })
    cloneAll(factory)
    return publish(factory)
  }

  function cloneAll(factory: StoredFactory): Promise<void> {
    const current = running.get(factory.id)
    if (current) return current
    const release = options.idle?.hold()
    const work = (async () => {
      const results = await Promise.all(factory.repos.map((repo) => cloneOne(factory, repo)))
      if (stopping.signal.aborted) return
      if (!results.every(Boolean)) return
      banners.clear({ problem: cloneFailedProblem, factoryId: factory.id })
      const cloned = store.factoryCloned(factory.id)
      progress.delete(factory.id)
      await workflows.resolve(cloned, { fetch: false }).catch((error: unknown) => {
        console.error(`couldn’t read ${cloned.repo}’s Workflow:`, error)
      })
      await publish(cloned)
      options.onCloned?.(cloned)
    })()
      .catch((error: unknown) => console.error(`setting up ${factory.name} failed:`, error))
      .finally(() => {
        running.delete(factory.id)
        release?.()
      })
    running.set(factory.id, work)
    return work
  }

  const cloning = new Map<string, Promise<void>>()

  async function cloneOne(factory: StoredFactory, { repo, cloneUrl }: StoredFactoryRepo) {
    const clone = path.join(reposDir, ...repo.split('/'))
    try {
      await cloneRemoved(clone)
      const inFlight = cloning.get(clone)
      if (inFlight) {
        setRepo(factory, { repo, state: 'cloning' })
        await inFlight
      }
      if (await exists(clone)) {
        setRepo(factory, { repo, state: 'fetching' })
        const fetched = await git.fetch(clone).then(
          () => true,
          () => false,
        )
        const other = store
          .listFactories()
          .find((f) => f.id !== factory.id && f.repos.some((r) => sameRepo(r.repo, repo)))
        setRepo(factory, {
          repo,
          state: other ? 'shared' : 'cloned',
          ...(other && { sharedWith: other.name }),
          ...(!fetched && { detail: 'couldn’t fetch' }),
        })
        return true
      }
      const work = cloneInto(factory, repo, cloneUrl, clone)
      cloning.set(clone, work)
      try {
        await work
      } finally {
        cloning.delete(clone)
      }
      setRepo(factory, { repo, state: 'cloned', percent: 100 })
      return true
    } catch (error) {
      if (stopping.signal.aborted) return false
      const message = error instanceof Error ? error.message : String(error)
      setRepo(factory, {
        repo,
        state: 'failed',
        error: cloneReason(message),
        ...(suggestsSetupGit(cloneUrl, message, options.login?.()) && { suggestSetupGit: true }),
      })
      const failedRepos = (progress.get(factory.id) ?? new Map<string, RepoSetup>()).values()
      const first = [...failedRepos].find((r) => r.state === 'failed')?.repo ?? repo
      banners.raise({
        problem: cloneFailedProblem,
        factoryId: factory.id,
        severity: 'stops-work',
        text: `Couldn’t clone ${first} · ${factory.name} can’t start Tasks until it’s cloned`,
        action: { label: 'Retry' },
      })
      return false
    }
  }

  async function cloneInto(
    factory: StoredFactory,
    repo: string,
    cloneUrl: string,
    clone: string,
  ): Promise<void> {
    const partial = `${clone}.partial-${randomBytes(4).toString('hex')}`
    await mkdir(path.dirname(clone), { recursive: true })
    setRepo(factory, { repo, state: 'cloning', percent: 0 })
    let shown = -1
    try {
      await git.cloneWithProgress(
        cloneUrl,
        partial,
        ({ percent, detail }) => {
          if (percent === shown) return
          shown = percent
          setRepo(factory, { repo, state: 'cloning', percent, detail })
        },
        stopping.signal,
      )
      await rename(partial, clone)
    } finally {
      await rm(partial, { recursive: true, force: true })
    }
  }

  async function retry(factoryId: string): Promise<Factory> {
    const factory = find(factoryId)
    if (factory.clonedAt !== undefined) return view(factory)
    void cloneAll(factory)
    return view(factory)
  }

  async function checkLocalFolders(): Promise<void> {
    for (const factory of store.listFactories()) {
      for (const { repo, name } of factory.repos) {
        const folder = store.localFolder(repo)
        const ref = { problem: localFolderProblem, factoryId: factory.id, subject: repo }
        if (folder === undefined || (await folderState(folder))?.found) {
          banners.clear(ref)
          continue
        }
        banners.raise({
          ...ref,
          severity: 'warning',
          text: `Local folder for ${name} not found`,
          action: { label: 'Locate', choose: 'folder' },
        })
      }
    }
  }

  async function setLocalFolder(key: string, folder: string): Promise<Factory> {
    const factory = store.listFactories().find((f) => f.key === key)
    if (!factory) throw new RequestError(404, `no Factory with key ${key}`)
    store.setLocalFolder(factory.repo, await checkFolder(folder))
    await checkLocalFolders()
    return publish(factory)
  }

  async function renameFactory(factoryId: string, given: string): Promise<Factory> {
    const name = typeof given === 'string' ? given.trim() : ''
    if (name === '') throw new RequestError(400, 'a Factory needs a name')
    if (name.length > maxNameLength) {
      throw new RequestError(400, `a Factory name is at most ${maxNameLength} characters`)
    }
    find(factoryId)
    return publish(store.renameFactory(factoryId, name))
  }

  async function setRepoFolder(
    factoryId: string,
    repoName: string,
    folder: string | undefined,
  ): Promise<Factory> {
    const factory = find(factoryId)
    const repo = factory.repos.find((r) => r.name === repoName)?.repo
    if (repo === undefined) throw new RequestError(404, `${factory.name} has no repo ${repoName}`)
    if (folder === undefined) store.clearLocalFolder(repo)
    else store.setLocalFolder(repo, await checkFolder(folder))
    await checkLocalFolders()
    return publish(factory)
  }

  async function syncRepos(factoryId: string, wanted: StoredFactoryRepo[]): Promise<void> {
    const factory = store.getFactory(factoryId)
    if (!factory || wanted.length === 0) return
    const same =
      wanted.length === factory.repos.length &&
      wanted.every(
        (r, i) =>
          sameRepo(r.repo, factory.repos[i]?.repo ?? '') && r.name === factory.repos[i]?.name,
      )
    if (same) return
    const added = wanted.filter((r) => !factory.repos.some((s) => sameRepo(s.repo, r.repo)))
    const changed = store.changeFactoryRepos(factoryId, wanted)
    await publish(changed)
    for (const repo of added) {
      banners.raise({
        problem: repoAddedProblem,
        factoryId,
        subject: repo.repo,
        severity: 'warning',
        text: `${repo.repo} was added · a New setup Task can set up its Checks and Apps`,
      })
    }
    if (added.length === 0 || factory.clonedAt === undefined) return
    const release = options.idle?.hold()
    void Promise.all(added.map((repo) => cloneOne(changed, repo)))
      .catch((error: unknown) => console.error(`cloning ${factory.name}’s new repo failed:`, error))
      .finally(() => {
        progress.delete(factoryId)
        release?.()
        void publish(store.getFactory(factoryId) ?? changed).catch(() => undefined)
      })
  }

  banners.onAction(localFolderProblem, async (banner, { folder }) => {
    if (folder === undefined) throw new RequestError(400, 'choose a folder to locate it')
    const factory = banner.factoryId === undefined ? undefined : store.getFactory(banner.factoryId)
    const repo = factory?.repos.find((r) => bannerSubject(banner.id) === r.repo)?.repo
    if (!factory || repo === undefined) throw new RequestError(404, 'no such repo')
    store.setLocalFolder(repo, await checkFolder(folder))
    await checkLocalFolders()
    await publish(factory)
  })

  return {
    async list() {
      await checkLocalFolders()
      return Promise.all(store.listFactories().map(view))
    },
    get: async (id) => view(find(id)),
    checkRepo,
    create,
    retry,
    setLocalFolder,
    rename: renameFactory,
    setRepoFolder,
    syncRepos,
    checkLocalFolders,
    isCloned: (id) => store.getFactory(id)?.clonedAt !== undefined,
    start() {
      for (const factory of store.listFactories()) {
        if (factory.clonedAt === undefined) void cloneAll(factory)
      }
      void checkLocalFolders().catch(() => undefined)
      timer = setInterval(() => {
        for (const factory of store.listFactories()) {
          const states = progress.get(factory.id)
          const failed = states && [...states.values()].some((s) => s.state === 'failed')
          if (factory.clonedAt === undefined && failed) void cloneAll(factory)
        }
        void checkLocalFolders().catch(() => undefined)
      }, options.retryEveryMs ?? 60_000)
      timer.unref()
    },
    async close() {
      if (timer) clearInterval(timer)
      stopping.abort()
      await Promise.all([...running.values()])
    },
  }
}

export function bannerSubject(id: string): string | undefined {
  const parts = id.split(':')
  return parts.length > 2 ? parts.slice(2).join(':') : undefined
}

type Located = { repo: string; folder?: string } | { problem: RepoProblem; folder?: string }

async function locate(source: RepoSource): Promise<Located> {
  if ('folder' in source && typeof source.folder === 'string') {
    const folder = source.folder
    const chooseAgain = { fixes: [{ kind: 'choose-folder' as const }] }
    if (!path.isAbsolute(folder) || !(await stat(folder).catch(() => undefined))?.isDirectory()) {
      return {
        folder,
        problem: { kind: 'no-folder', text: `There’s no folder at ${folder}.`, ...chooseAgain },
      }
    }
    const noRemote = {
      folder,
      problem: {
        kind: 'no-remote' as const,
        text: 'This folder has no GitHub remote.',
        detail:
          'TED works from GitHub. Push the folder to a GitHub repo, or choose another folder.',
        ...chooseAgain,
      },
    }
    const found = await git.folderRemotes(folder).catch(() => undefined)
    if (!found) return noRemote
    const github = found.remotes.flatMap(({ name, url }) => {
      const repo = githubRepo(url)
      return repo === undefined ? [] : [{ name, repo }]
    })
    const chosen =
      github.find((r) => r.name === 'origin') ?? (github.length === 1 ? github[0] : undefined)
    if (!chosen) return { ...noRemote, folder: found.root }
    return { repo: chosen.repo, folder: found.root }
  }
  const text = 'remote' in source && typeof source.remote === 'string' ? source.remote.trim() : ''
  const repo = githubRepo(text)
  if (repo === undefined) {
    return {
      problem: {
        kind: 'invalid',
        text:
          /^[a-z]+:\/\/|@/i.test(text) && !/github\.com/i.test(text)
            ? 'TED works with repos on github.com.'
            : 'Give a GitHub URL or owner/repo.',
        fixes: [],
      },
    }
  }
  return { repo }
}

export function githubRepo(given: string): string | undefined {
  const text = given
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  const short = /^([^/:@\s]+)\/([^/:@\s]+)$/.exec(text)
  const https = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/i.exec(text)
  const ssh = /^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+)$/i.exec(text)
  const scp = /^(?:[^@/:]+@)?github\.com:([^/]+)\/([^/]+)$/i.exec(text)
  const match = short ?? https ?? ssh ?? scp
  if (!match) return undefined
  const [, owner, name] = match
  if (!owner || !name || ![owner, name].every(isSafeSegment)) return undefined
  return `${owner}/${name}`
}

async function cloneUrlFor(source: RepoSource | undefined, repo: string): Promise<string> {
  let remote: string | undefined
  if (source && 'folder' in source) {
    const found = await git.folderRemotes(source.folder).catch(() => undefined)
    const github = (found?.remotes ?? []).filter((r) => sameRepo(githubRepo(r.url) ?? '', repo))
    remote = (github.find((r) => r.name === 'origin') ?? github[0])?.url
  } else if (source && 'remote' in source) {
    remote = source.remote.trim()
  }
  const usesSsh = remote !== undefined && /^(?:ssh:\/\/|[^@/:]+@github\.com:)/i.test(remote)
  return usesSsh ? `git@${githubHost}:${repo}.git` : `https://${githubHost}/${repo}.git`
}

function isSafeSegment(value: string): boolean {
  return segment.test(value) && value !== '.' && value !== '..'
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function repoName(repo: string): string {
  const name = (repo.split('/').at(-1) ?? repo).toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return name.replace(/^-+|-+$/g, '') || 'repo'
}

function cloneReason(message: string): string {
  const host = /(?:resolve host|unable to access 'https?:\/\/)([^/':]+)/i.exec(message)?.[1]
  if (
    /Could not resolve host|Failed to connect|Connection (?:timed out|refused)|Network is unreachable/i.test(
      message,
    )
  ) {
    return `couldn’t reach ${host ?? githubHost}`
  }
  const line = message.replace(/^git clone failed:\s*/, '').replace(/^fatal:\s*/, '')
  return redactSecrets(line)
}

function suggestsSetupGit(cloneUrl: string, message: string, login: string | undefined): boolean {
  return (
    login !== undefined &&
    /^https:/i.test(cloneUrl) &&
    /Authentication failed|could not read Username|terminal prompts disabled|returned error: 403/i.test(
      message,
    )
  )
}

async function folderState(folder: string | undefined) {
  if (folder === undefined) return undefined
  const found = (await stat(folder).catch(() => undefined))?.isDirectory() ?? false
  return { path: folder, found }
}

async function checkFolder(folder: string): Promise<string> {
  if (!path.isAbsolute(folder))
    throw new RequestError(400, 'a local folder must be an absolute path')
  const found = await stat(folder).catch(() => undefined)
  if (!found?.isDirectory()) throw new RequestError(400, `there’s no folder at ${folder}`)
  return path.normalize(folder)
}

function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}
