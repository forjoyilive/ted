import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Factory } from '@ted/protocol'
import { RequestError } from './errors.ts'
import * as git from './git.ts'
import { placeholderFactory, type StoredFactory, type TedStore } from './store/index.ts'

const keyPattern = /^[A-Z][A-Z0-9]{1,4}$/
const githubRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const safeSegment = /^[A-Za-z0-9_.-]+$/

export async function addFactory(
  { store, reposDir }: { store: TedStore; reposDir: string },
  input: { repo: string; key: string; localFolder?: string },
): Promise<Factory> {
  if (!keyPattern.test(input.key)) {
    throw new RequestError(
      400,
      'a Factory key is 2 to 5 uppercase letters or digits, starting with a letter',
    )
  }
  const { repo, cloneUrl } = parseRepo(input.repo)
  checkUnused(store, input.key, repo)
  const localFolder =
    input.localFolder === undefined ? undefined : await checkLocalFolder(input.localFolder)

  const clone = path.join(reposDir, ...repo.split('/'))
  if (await exists(clone)) await git.fetch(clone)
  else {
    await mkdir(path.dirname(clone), { recursive: true })
    await git.clone(cloneUrl, clone)
  }
  const defaultBranch = await git.defaultBranch(clone)
  checkUnused(store, input.key, repo)
  const factory = store.addFactory({
    key: input.key,
    name: repo.split('/')[1] ?? repo,
    repo,
    cloneUrl,
    defaultBranch,
  })
  if (localFolder !== undefined) store.setLocalFolder(repo, localFolder)
  return publicFactory(store, factory)
}

export function listFactories(store: TedStore): Promise<Factory[]> {
  return Promise.all(store.listFactories().map((f) => publicFactory(store, f)))
}

export async function setLocalFolder(
  store: TedStore,
  key: string,
  folder: string,
): Promise<Factory> {
  const factory = store.listFactories().find((f) => f.key === key)
  if (!factory) throw new RequestError(404, `no Factory with key ${key}`)
  store.setLocalFolder(factory.repo, await checkLocalFolder(folder))
  return publicFactory(store, factory)
}

async function checkLocalFolder(folder: string): Promise<string> {
  if (!path.isAbsolute(folder))
    throw new RequestError(400, 'a local folder must be an absolute path')
  const found = await stat(folder).catch(() => undefined)
  if (!found?.isDirectory()) throw new RequestError(400, `there’s no folder at ${folder}`)
  return path.normalize(folder)
}

function checkUnused(store: TedStore, key: string, repo: string): void {
  const factories = store.listFactories()
  if (key === placeholderFactory.key || factories.some((f) => f.key === key)) {
    throw new RequestError(409, `the Factory key ${key} is already in use`)
  }
  if (factories.some((f) => f.repo === repo)) {
    throw new RequestError(409, `${repo} is already the primary repo of a Factory`)
  }
}

export function clonePath(reposDir: string, factory: Factory): string {
  return path.join(reposDir, ...factory.repo.split('/'))
}

async function publicFactory(
  store: TedStore,
  { cloneUrl: _, ...factory }: StoredFactory,
): Promise<Factory> {
  const folder = store.localFolder(factory.repo)
  if (folder === undefined) return factory
  const found = (await stat(folder).catch(() => undefined))?.isDirectory() ?? false
  return { ...factory, localFolder: { path: folder, found } }
}

function parseRepo(given: string): { repo: string; cloneUrl: string } {
  if (githubRepo.test(given) && given.split('/').every(isSafeSegment)) {
    return { repo: given, cloneUrl: `https://github.com/${given}.git` }
  }
  const [owner, name] = given
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .slice(-2)
  if (!owner || !name || ![owner, name].every(isSafeSegment)) {
    throw new RequestError(400, 'give the repo as owner/repo or as a git URL ending in owner/repo')
  }
  return { repo: `${owner}/${name}`, cloneUrl: given }
}

function isSafeSegment(segment: string): boolean {
  return safeSegment.test(segment) && segment !== '.' && segment !== '..'
}

function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}
