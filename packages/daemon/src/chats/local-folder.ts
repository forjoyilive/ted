import path from 'node:path'
import type { LocalFolderCheck, LocalFolderUpdate } from '@ted/protocol/local-folder'
import * as git from '../git.ts'
import { redactSecrets } from '../redact.ts'

const fetchTimeoutMs = 60_000

const dependencyFiles = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Gemfile.lock',
  'Podfile.lock',
  'Package.resolved',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'requirements.txt',
  'composer.lock',
])

function firstLine(message: string): string {
  return redactSecrets(message.split('\n')[0] ?? message)
}

export async function checkFolder(input: {
  folder: string
  clone: string
  copy?: string
}): Promise<LocalFolderCheck> {
  let local: git.FolderHead
  try {
    local = await git.folderHead(input.folder)
  } catch {
    return { checked: false, problem: 'the folder isn’t a git repository with a commit' }
  }
  try {
    await git.fetch(input.clone, fetchTimeoutMs)
  } catch (error) {
    return {
      checked: false,
      problem: `Ted couldn’t fetch from GitHub (${firstLine(error instanceof Error ? error.message : String(error))})`,
    }
  }
  let main: string
  let objects: string
  try {
    main = await git.defaultBranch(input.clone)
    objects = await git.cloneObjects(input.clone)
  } catch (error) {
    return {
      checked: false,
      problem: firstLine(error instanceof Error ? error.message : String(error)),
    }
  }
  const { branch } = local
  const onGitHub = (name: string) =>
    git.revParse(input.clone, `refs/remotes/origin/${name}`).catch(() => undefined)
  const branchTip = branch !== undefined && branch !== main ? await onGitHub(branch) : undefined
  const mainTip = await onGitHub(main)
  if (mainTip === undefined) return { checked: false, problem: `${main} isn’t on GitHub` }
  const offGitHub = branch !== undefined && branch !== main && branchTip === undefined
  const against = branchTip !== undefined && branch !== undefined ? branch : main
  const target = branchTip ?? mainTip
  const dirs = [objects, local.objects]
  const gap = await git.commitGap(dirs, local.head, target)
  if (!gap) return { checked: false, problem: 'git couldn’t compare the commits' }
  const check: LocalFolderCheck = {
    checked: true,
    ...(branch !== undefined && { branch }),
    against,
    main,
    head: local.head,
    target,
    ...(local.uncommitted > 0 && { uncommitted: local.uncommitted }),
  }
  if (offGitHub) check.offGitHub = true
  else {
    if (gap.behind > 0) check.behind = gap.behind
    if (gap.ahead > 0) check.ahead = gap.ahead
  }
  if (against !== main || offGitHub) {
    const toMain = await git.commitGap(dirs, local.head, mainTip)
    if (toMain && toMain.behind > 0) check.behindMain = toMain.behind
  }
  if (input.copy !== undefined) {
    const copyHead = await git.headCommit(input.copy).catch(() => undefined)
    const copyGap = copyHead && (await git.commitGap([objects], copyHead, mainTip))
    if (copyGap && copyGap.behind > 0) check.copyBehind = copyGap.behind
  }
  return check
}

export async function updateFolder(
  folder: string,
  check: LocalFolderCheck,
  clone: string,
): Promise<LocalFolderUpdate> {
  const { head, target, against, behind } = check
  if (head === undefined || target === undefined || against === undefined)
    throw new Error('the check didn’t find what to update to')
  try {
    await git.fastForwardFolder(folder, against, target)
  } catch (error) {
    throw new Error(firstLine(error instanceof Error ? error.message : String(error)))
  }
  const changed = await git.changedFileNames([await git.cloneObjects(clone)], head, target)
  const dependencies = changed.filter((file) => dependencyFiles.has(path.basename(file)))
  return {
    from: head,
    to: target,
    commits: behind ?? 0,
    ...(dependencies.length > 0 && { dependencies }),
  }
}
