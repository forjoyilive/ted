import { execFile } from 'node:child_process'
import { lstat, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  branchNameProblem,
  type GitHubNameCheck,
  type GitHubNameRequest,
  type GitHubSetupPlan,
  type GitHubSetupStepRequest,
  type GitHubSetupStepResult,
  type LeaveOutCandidate,
  type OtherRemote,
} from '@ted/protocol'
import { gitEnv } from '../command-env.ts'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { type Gh, GhError } from './gh.ts'

export interface GitHubRepoSetup {
  plan(folder: string): Promise<GitHubSetupPlan>
  nameAvailable(request: GitHubNameRequest): Promise<GitHubNameCheck>
  step(request: GitHubSetupStepRequest): Promise<GitHubSetupStepResult>
}

const bigFolders = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo'])
const secretName =
  /^(?:\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?|.*\.pem|.*\.key|id_rsa|id_ed25519|id_ecdsa)$/
const maxSecrets = 20
const remoteNames = ['origin', 'github', 'github-repo']
const pushTimeoutMs = 10 * 60_000

interface FolderState {
  root: string
  git: boolean
  commits: boolean
  branch: string | undefined
  remotes: { name: string; url: string }[]
}

export function createRepoSetup({
  gh,
  githubRepo,
}: {
  gh: Gh
  githubRepo: (url: string) => string | undefined
}): GitHubRepoSetup {
  async function owners(): Promise<{ owners: string[]; signedIn: boolean }> {
    let login: string
    try {
      const user = (await gh.api('user')) as { login?: unknown } | undefined
      if (typeof user?.login !== 'string') return { owners: [], signedIn: false }
      login = user.login
    } catch (error) {
      if (error instanceof GhError && (error.kind === 'auth' || error.kind === 'missing')) {
        return { owners: [], signedIn: false }
      }
      throw failed('Couldn’t read your GitHub account', error)
    }
    const orgs = await gh.api('user/orgs?per_page=100').then(
      (list) =>
        Array.isArray(list)
          ? list.flatMap((o) =>
              typeof (o as { login?: unknown }).login === 'string'
                ? [(o as { login: string }).login]
                : [],
            )
          : [],
      () => [] as string[],
    )
    return { owners: [login, ...orgs.filter((o) => o !== login)], signedIn: true }
  }

  function remoteFor(state: FolderState, owner: string, name: string) {
    const target = `${owner}/${name}`.toLowerCase()
    return state.remotes.find((r) => githubRepo(r.url)?.toLowerCase() === target)
  }

  async function plan(folder: string): Promise<GitHubSetupPlan> {
    const state = await folderState(folder)
    if (state.remotes.some((r) => githubRepo(r.url) !== undefined)) {
      throw new RequestError(409, 'This folder already has a GitHub remote.')
    }
    const files = state.commits ? undefined : await listFiles(state)
    const hasIgnoreFile = await present(path.join(state.root, '.gitignore'))
    const other = state.remotes.find((r) => r.name === 'origin') ?? state.remotes[0]
    const otherRemote: OtherRemote | undefined = other && {
      name: other.name,
      url: redactSecrets(other.url),
    }
    return {
      folder: state.root,
      git: state.git,
      commits: state.commits,
      ...(state.branch !== undefined && { branch: state.branch }),
      uncommitted: state.commits ? await uncommitted(state.root) : 0,
      files: files?.length ?? 0,
      hasIgnoreFile,
      leaveOut: files && !hasIgnoreFile ? candidates(files) : [],
      ...(otherRemote && { otherRemote }),
      remoteName: freeRemoteName(state),
      ...(await owners()),
    }
  }

  async function nameAvailable({ owner, name }: GitHubNameRequest): Promise<GitHubNameCheck> {
    try {
      await gh.api(`repos/${owner}/${name}`)
      return { available: false }
    } catch (error) {
      if (error instanceof GhError && error.status === 404) return { available: true }
      throw failed('Couldn’t check the name on GitHub', error)
    }
  }

  async function createdEarlier(owner: string, name: string): Promise<boolean> {
    const info = (await gh.api(`repos/${owner}/${name}`).catch(() => undefined)) as
      | { private?: unknown; permissions?: { admin?: unknown } }
      | undefined
    if (info?.private !== true || info.permissions?.admin !== true) return false
    return gh.api(`repos/${owner}/${name}/commits?per_page=1`).then(
      () => false,
      (error: unknown) => error instanceof GhError && error.status === 409,
    )
  }

  async function step(request: GitHubSetupStepRequest): Promise<GitHubSetupStepResult> {
    const branchProblem = branchNameProblem(request.branch)
    if (branchProblem !== undefined) throw new RequestError(400, branchProblem)
    const state = await folderState(request.folder)
    if (state.root !== (await realpath(request.folder))) {
      throw new RequestError(409, 'The folder changed. Close the form and choose the folder again.')
    }
    const { root } = state
    switch (request.step) {
      case 'init': {
        if (state.git) return { done: false }
        await git(root, ['check-ref-format', '--branch', request.branch])
        await git(root, ['init', '--quiet', `--initial-branch=${request.branch}`])
        return { done: true }
      }
      case 'ignore': {
        if (!state.git || state.commits) return { done: false }
        const ignore = path.join(root, '.gitignore')
        if (await present(ignore)) return { done: false }
        const offered = new Set(candidates(await listFiles(state)).map((c) => c.path))
        const lines = request.leaveOut.filter((p) => offered.has(p))
        if (lines.length === 0) return { done: false }
        await writeFile(ignore, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o644 })
        return { done: true }
      }
      case 'commit': {
        if (!state.git) throw new RequestError(409, 'Start git in the folder first.')
        if (state.commits) return { done: false }
        if (state.branch !== request.branch) {
          await git(root, ['symbolic-ref', 'HEAD', `refs/heads/${request.branch}`])
        }
        await git(root, ['add', '--all'])
        const stagedNow = async () =>
          (await git(root, ['ls-files', '-z', '--cached'])).split('\0').filter((f) => f !== '')
        const unwanted = leftOut(await stagedNow(), request.leaveOut)
        if (unwanted.length > 0) {
          await git(
            root,
            [
              '--literal-pathspecs',
              'rm',
              '-r',
              '--cached',
              '--quiet',
              '--ignore-unmatch',
              '--pathspec-from-file=-',
              '--pathspec-file-nul',
            ],
            { input: unwanted.map((f) => `${f}\0`).join('') },
          )
        }
        const staged = await stagedNow()
        if (leftOut(staged, request.leaveOut).length > 0) {
          throw new RequestError(
            409,
            'Couldn’t leave out the files you chose. Nothing was committed.',
          )
        }
        if (staged.length === 0) throw new RequestError(409, 'The folder has no files to commit.')
        await git(root, ['commit', '--quiet', '--no-verify', '-m', 'Initial commit'])
        return { done: true }
      }
      case 'create': {
        if (remoteFor(state, request.owner, request.name)) return { done: false }
        const known = await owners()
        if (!known.signedIn) throw new RequestError(409, 'Sign in to GitHub first.')
        if (!known.owners.includes(request.owner)) {
          throw new RequestError(400, `${request.owner} isn’t one of your GitHub accounts.`)
        }
        if (await createdEarlier(request.owner, request.name)) return { done: false }
        const { available } = await nameAvailable(request)
        if (!available) {
          throw new RequestError(409, `${request.owner}/${request.name} already exists.`)
        }
        const personal = request.owner === known.owners[0]
        try {
          await gh.api(personal ? 'user/repos' : `orgs/${request.owner}/repos`, {
            method: 'POST',
            body: {
              name: request.name,
              private: true,
              ...(request.description !== '' && { description: request.description }),
            },
          })
        } catch (error) {
          throw createProblem(error, request.owner, request.name)
        }
        return { done: true }
      }
      case 'push': {
        if (!state.commits) throw new RequestError(409, 'Commit the folder first.')
        const existing = remoteFor(state, request.owner, request.name)?.name
        const remote = existing ?? freeRemoteName(state)
        if (existing === undefined) {
          const url = `https://github.com/${request.owner}/${request.name}.git`
          await git(root, ['remote', 'add', remote, url])
        }
        const tracked =
          state.branch !== undefined &&
          (await git(root, ['config', '--get', `branch.${state.branch}.remote`]).catch(
            () => '',
          )) !== ''
        const args =
          state.branch === request.branch && !tracked
            ? ['push', '--quiet', '--set-upstream', remote, request.branch]
            : ['push', '--quiet', remote, `HEAD:refs/heads/${request.branch}`]
        try {
          await git(root, args, { timeout: pushTimeoutMs })
        } catch (error) {
          if (existing === undefined) {
            await git(root, ['remote', 'remove', remote]).catch(() => undefined)
          }
          throw error
        }
        return { done: true }
      }
    }
  }

  return { plan, nameAvailable, step }
}

function freeRemoteName(state: FolderState): string {
  const taken = new Set(state.remotes.map((r) => r.name))
  return remoteNames.find((n) => !taken.has(n)) ?? `github-${Date.now()}`
}

function createProblem(error: unknown, owner: string, name: string): Error {
  if (error instanceof GhError) {
    if (error.kind === 'auth' || error.kind === 'missing') {
      return new RequestError(409, 'Sign in to GitHub first.')
    }
    if (error.status === 422) return new RequestError(409, `${owner}/${name} already exists.`)
    if (error.status === 403 || error.status === 404) {
      return new RequestError(
        403,
        `GitHub refused to create the repo: you don’t have permission to create repos in ${owner}.`,
      )
    }
  }
  return failed('GitHub didn’t create the repo', error)
}

function failed(what: string, error: unknown): RequestError {
  const reason = error instanceof Error ? error.message : String(error)
  return new RequestError(502, redactSecrets(`${what}: ${reason}`))
}

async function present(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  )
}

async function folderState(folder: string): Promise<FolderState> {
  if (!path.isAbsolute(folder) || !(await stat(folder).catch(() => undefined))?.isDirectory()) {
    throw new RequestError(400, `There’s no folder at ${folder}.`)
  }
  const top = await git(folder, ['rev-parse', '--show-toplevel'])
    .then((found) => realpath(found))
    .catch(() => undefined)
  if (top === undefined) {
    const root = await realpath(folder)
    return { root, git: false, commits: false, branch: undefined, remotes: [] }
  }
  const commits = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    () => true,
    () => false,
  )
  const branch = await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(
    () => undefined,
  )
  const listed = await git(top, ['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => '')
  const remotes = listed
    .split('\n')
    .map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim()))
    .flatMap((m) => (m?.[1] && m[2] ? [{ name: m[1], url: m[2] }] : []))
  return { root: top, git: true, commits, branch: branch || undefined, remotes }
}

async function uncommitted(root: string): Promise<number> {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  const records = out.split('\0').filter((r) => r !== '')
  let count = 0
  for (let i = 0; i < records.length; i++) {
    count++
    if (/^[RC]/.test(records[i] ?? '')) i++
  }
  return count
}

async function listFiles(state: FolderState): Promise<string[]> {
  if (state.git) {
    const out = await git(state.root, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ])
    return out.split('\0').filter((f) => f !== '')
  }
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-github-setup-'))
  try {
    const gitDir = path.join(scratch, 'repo.git')
    await git(scratch, ['init', '--quiet', '--bare', gitDir])
    const out = await git(state.root, [
      `--git-dir=${gitDir}`,
      `--work-tree=${state.root}`,
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
    ])
    return out.split('\0').filter((f) => f !== '')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export function ignoreLine(file: string): string {
  return `/${file.replace(/[\\[\]*?]/g, '\\$&').replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length))}`
}

function candidateFor(file: string): { path: string; secret: boolean } | undefined {
  const parts = file.split('/')
  const big = parts.slice(0, -1).find((p) => bigFolders.has(p))
  if (big !== undefined) return { path: `${big}/`, secret: false }
  if (secretName.test(parts.at(-1) ?? '')) return { path: ignoreLine(file), secret: true }
  return undefined
}

export function candidates(files: readonly string[]): LeaveOutCandidate[] {
  const folders = new Map<string, number>()
  const secrets: LeaveOutCandidate[] = []
  for (const file of files) {
    const found = candidateFor(file)
    if (found === undefined) continue
    if (!found.secret) folders.set(found.path, (folders.get(found.path) ?? 0) + 1)
    else if (secrets.length < maxSecrets) secrets.push({ path: found.path, files: 1, secret: true })
  }
  return [
    ...[...folders].map(([folder, count]) => ({ path: folder, files: count, secret: false })),
    ...secrets,
  ]
}

export function leftOut(files: readonly string[], leaveOut: readonly string[]): string[] {
  const chosen = new Set(leaveOut)
  return files.filter((file) => {
    const found = candidateFor(file)
    return found !== undefined && chosen.has(found.path)
  })
}

function git(
  cwd: string,
  args: string[],
  { timeout = 60_000, input }: { timeout?: number; input?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { cwd, env: gitEnv(), timeout, maxBuffer: 128 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim())
        const detail = String(stderr ?? '').trim()
        if (/Please tell me who you are|empty ident name/.test(detail)) {
          reject(
            new RequestError(
              409,
              'git doesn’t know your name and email yet. Set them with git config --global user.name and user.email, then try again.',
            ),
          )
          return
        }
        const message = `git ${args.find((a) => !a.startsWith('-')) ?? ''} failed${detail ? `: ${detail}` : ''}`
        reject(new RequestError(502, redactSecrets(message)))
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}
