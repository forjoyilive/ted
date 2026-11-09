import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DiffHunk } from '@ted/protocol'
import { gitEnv, worktreeCommandEnv } from './command-env.ts'
import { redactSecrets } from './redact.ts'

const execFileAsync = promisify(execFile)

export class GitError extends Error {}

const env = () => gitEnv()

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: env(),
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new GitError(redactSecrets(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`))
  }
}

export async function clone(url: string, into: string): Promise<void> {
  await git(path.dirname(into), 'clone', '--', url, into)
}

export interface CloneProgress {
  percent: number
  detail: string
}

export function cloneWithProgress(
  url: string,
  into: string,
  onProgress: (progress: CloneProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--progress', '--', url, into], {
      cwd: path.dirname(into),
      env: env(),
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(signal !== undefined && { signal }),
    })
    let tail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4096)
      const last = chunk
        .split(/[\r\n]/)
        .filter((line) => line.trim() !== '')
        .at(-1)
      const progress = last === undefined ? undefined : parseProgress(last)
      if (progress) onProgress(progress)
    })
    child.on('error', (error) =>
      reject(new GitError(redactSecrets(`git clone failed: ${error.message}`))),
    )
    child.on('close', (code) => {
      if (code === 0) return resolve()
      const lines = tail
        .split(/[\r\n]/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && parseProgress(line) === undefined)
      const reason =
        lines.filter((line) => /^(fatal|error|remote):/i.test(line)).at(-1) ?? lines.at(-1)
      reject(new GitError(redactSecrets(`git clone failed${reason ? `: ${reason}` : ''}`)))
    })
  })
}

const phases: [RegExp, number, number][] = [
  [/^remote: (?:Counting|Compressing) objects:\s+(\d+)%/, 0, 5],
  [/^Receiving objects:\s+(\d+)%/, 5, 85],
  [/^Resolving deltas:\s+(\d+)%/, 90, 10],
  [/^Updating files:\s+(\d+)%/, 100, 0],
]

export function parseProgress(line: string): CloneProgress | undefined {
  for (const [pattern, start, span] of phases) {
    const match = pattern.exec(line)
    if (!match) continue
    const percent = Math.min(100, Math.round(start + (span * Number(match[1])) / 100))
    const name = line.replace(/^remote: /, '').split(':')[0] ?? ''
    const size = /,\s*([\d.]+ [KMG]i?B)/.exec(line)?.[1]
    const detail = size === undefined ? name : `${name} · ${size}`
    return { percent, detail }
  }
  return undefined
}

export async function folderRemotes(
  folder: string,
): Promise<{ root: string; remotes: { name: string; url: string }[] }> {
  const root = await git(folder, 'rev-parse', '--show-toplevel')
  const out = await git(folder, 'config', '--get-regexp', '^remote\\..*\\.url$').catch(() => '')
  const remotes = out
    .split('\n')
    .map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim()))
    .flatMap((m) => (m?.[1] && m[2] ? [{ name: m[1], url: m[2] }] : []))
  return { root, remotes }
}

export async function fetch(repo: string): Promise<void> {
  await git(repo, 'fetch', '--prune', 'origin')
}

export async function defaultBranch(repo: string): Promise<string> {
  const ref = await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  return ref.replace(/^origin\//, '')
}

export async function isValidBranchName(repo: string, name: string): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name)) return false
  return git(repo, 'check-ref-format', `refs/heads/${name}`).then(
    () => true,
    () => false,
  )
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const found = await git(repo, 'show-ref', '--verify', '--quiet', ref).then(
      () => true,
      () => false,
    )
    if (found) return true
  }
  return false
}

export async function addWorktree(
  repo: string,
  input: { path: string; branch: string; from: string },
): Promise<void> {
  await git(repo, 'worktree', 'add', '--no-track', '-b', input.branch, input.path, input.from)
}

export async function restoreWorktree(
  repo: string,
  input: { path: string; branch: string; from: string },
): Promise<void> {
  await git(repo, 'worktree', 'prune')
  const has = (ref: string) =>
    git(repo, 'show-ref', '--verify', '--quiet', ref).then(
      () => true,
      () => false,
    )
  if (await has(`refs/heads/${input.branch}`)) {
    await git(repo, 'worktree', 'add', input.path, input.branch)
    return
  }
  const from = (await has(`refs/remotes/origin/${input.branch}`))
    ? `origin/${input.branch}`
    : input.from
  await git(repo, 'worktree', 'add', '--no-track', '-b', input.branch, input.path, from)
}

export async function remoteUrl(repo: string): Promise<string> {
  return git(repo, 'remote', 'get-url', 'origin')
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
}

export async function listFiles(repo: string, commit: string, dir: string): Promise<string[]> {
  const out = await git(repo, 'ls-tree', '-r', '--name-only', '-z', commit, '--', dir)
  return out.split('\0').filter((p) => p !== '')
}

export async function showFile(repo: string, commit: string, file: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['cat-file', 'blob', `${commit}:${file}`], {
    cwd: repo,
    env: env(),
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, 'branch', '-D', branch)
}

export async function removeWorktree(repo: string, worktree: string): Promise<void> {
  await git(repo, 'worktree', 'remove', '--force', worktree)
}

const noHooks = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=']

export async function changedFiles(worktree: string, base: string): Promise<string[]> {
  return (await workingChanges(worktree, base)).files.map((f) => f.path)
}

export async function commitAt(worktree: string, at: string): Promise<string | undefined> {
  const out = await git(worktree, ...noHooks, 'rev-list', '-1', `--before=${at}`, 'HEAD', '--')
  return out === '' ? undefined : out
}

export async function commitsAhead(worktree: string, base: string): Promise<number> {
  const out = await git(worktree, ...noHooks, 'rev-list', '--count', `${base}..HEAD`, '--')
  return Number.parseInt(out, 10) || 0
}

export async function pushBranch(
  worktree: string,
  branch: string,
  options: { url: string; expected?: string; timeoutMs?: number },
): Promise<string> {
  const commit = await git(worktree, ...noHooks, 'rev-parse', '--verify', 'HEAD^{commit}')
  const common = await git(worktree, ...noHooks, 'rev-parse', '--git-common-dir')
  const objects = path.join(path.resolve(worktree, common), 'objects')
  const ref = `refs/heads/${branch}`
  const lease =
    options.expected === undefined ? [] : [`--force-with-lease=${ref}:${options.expected}`]
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-push-'))
  const gitDir = path.join(scratch, 'repo.git')
  const pushEnv = worktreeCommandEnv({}, { GIT_TERMINAL_PROMPT: '0', GIT_DIR: gitDir })
  const args = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'protocol.ext.allow=never',
    'push',
    '--no-verify',
    '--porcelain',
    ...lease,
    '--',
    options.url,
    `${commit}:${ref}`,
  ]
  try {
    await execFileAsync('git', ['init', '--bare', '--quiet', gitDir], {
      cwd: scratch,
      env: pushEnv,
    })
    await writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${objects}\n`)
    await execFileAsync('git', args, {
      cwd: scratch,
      env: pushEnv,
      timeout: options.timeoutMs ?? 5 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ''}\n${(error as { stderr?: string }).stderr ?? ''}`
    const reason = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(fatal|error|remote:|!)/i.test(line))
      .slice(-3)
      .join('\n')
    throw new GitError(redactSecrets(`git push failed${reason ? `: ${reason}` : ''}`))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return commit
}

export async function fetchBranch(
  worktree: string,
  options: { url: string; branch: string; haves?: string[]; timeoutMs?: number },
): Promise<string> {
  const common = await git(worktree, ...noHooks, 'rev-parse', '--git-common-dir')
  const objects = path.join(path.resolve(worktree, common), 'objects')
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-fetch-'))
  const gitDir = path.join(scratch, 'repo.git')
  const fetched = 'refs/ted/fetched'
  const run = (args: string[], env: NodeJS.ProcessEnv, timeout?: number) =>
    execFileAsync('git', args, {
      cwd: scratch,
      env,
      maxBuffer: 16 * 1024 * 1024,
      ...(timeout !== undefined && { timeout }),
    })
  try {
    await run(['init', '--bare', '--quiet', gitDir], worktreeCommandEnv({}, { GIT_DIR: gitDir }))
    const env = worktreeCommandEnv(
      {},
      { GIT_TERMINAL_PROMPT: '0', GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: objects },
    )
    for (const [i, have] of (options.haves ?? []).entries()) {
      await run(['update-ref', `refs/ted/have-${i}`, have], env).catch(() => undefined)
    }
    await run(
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'protocol.ext.allow=never',
        'fetch',
        '--no-tags',
        '--quiet',
        '--',
        options.url,
        `+refs/heads/${options.branch}:${fetched}`,
      ],
      env,
      options.timeoutMs ?? 5 * 60_000,
    )
    const { stdout } = await run(['rev-parse', '--verify', `${fetched}^{commit}`], env)
    return stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const reason = stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(fatal|error|remote:)/i.test(line))
      .slice(-3)
      .join('\n')
    throw new GitError(redactSecrets(`git fetch failed${reason ? `: ${reason}` : ''}`))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function isAncestor(repo: string, ancestor: string, commit: string): Promise<boolean> {
  return git(repo, ...noHooks, 'merge-base', '--is-ancestor', ancestor, commit).then(
    () => true,
    () => false,
  )
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  return git(repo, ...noHooks, 'merge-base', a, b)
}

export async function treeOf(repo: string, commit: string): Promise<string> {
  return git(repo, ...noHooks, 'rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`)
}

export async function replayedTree(
  worktree: string,
  input: { from: string; to: string; onto: string },
): Promise<string | undefined> {
  const common = await git(worktree, ...noHooks, 'rev-parse', '--git-common-dir')
  const objects = path.join(path.resolve(worktree, common), 'objects')
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-replay-'))
  const gitDir = path.join(scratch, 'repo.git')
  try {
    await execFileAsync('git', ['init', '--bare', '--quiet', gitDir], {
      cwd: scratch,
      env: worktreeCommandEnv({}, { GIT_DIR: gitDir }),
    })
    const { stdout } = await execFileAsync(
      'git',
      ['merge-tree', '--write-tree', '--merge-base', input.from, input.onto, input.to],
      {
        cwd: scratch,
        env: worktreeCommandEnv({}, { GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: objects }),
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    return stdout.split('\n')[0]?.trim() || undefined
  } catch {
    return undefined
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export interface FileChange {
  path: string
  added: number
  removed: number
}

export async function changesBetween(
  worktree: string,
  input: { from: string; to: string; baseTip?: string },
): Promise<FileChange[]> {
  if (input.from === input.to) return []
  const common = await git(worktree, ...noHooks, 'rev-parse', '--git-common-dir')
  const objects = path.join(path.resolve(worktree, common), 'objects')
  const base = input.baseTip
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-changes-'))
  const gitDir = path.join(scratch, 'repo.git')
  const bareEnv = worktreeCommandEnv({}, { GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: objects })
  const bare = async (args: string[], allowConflicts = false) => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: scratch,
        env: bareEnv,
        maxBuffer: 16 * 1024 * 1024,
      })
      return stdout
    } catch (error) {
      const { stdout, code } = error as { stdout?: string; code?: number }
      if (allowConflicts && code === 1 && stdout) return stdout
      throw new GitError(`git ${args[0]} failed`)
    }
  }
  try {
    await bare(['init', '--bare', '--quiet', gitDir])
    const ancestor = await bare(['merge-base', '--is-ancestor', input.from, input.to]).then(
      () => true,
      () => false,
    )
    let from = input.from
    if (!ancestor && base !== undefined) {
      const mergeBaseOf = (a: string, b: string) =>
        bare(['merge-base', a, b]).then(
          (out) => out.trim(),
          () => '',
        )
      const oldBase = await mergeBaseOf(input.from, base)
      const newBase = await mergeBaseOf(input.to, base)
      if (oldBase !== '' && newBase !== '') {
        const replayed = await bare(
          ['merge-tree', '--write-tree', '--merge-base', oldBase, newBase, input.from],
          true,
        )
        from = replayed.split('\n')[0]?.trim() || input.from
      }
    }
    const out = await bare([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--numstat',
      '-z',
      from,
      input.to,
      '--',
    ])
    return parseNumstat(out).map(({ path, added, removed }) => ({ path, added, removed }))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function parseNumstat(out: string): (FileChange & { binary: boolean })[] {
  return out
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [added = '', removed = '', ...rest] = entry.split('\t')
      return {
        path: rest.join('\t'),
        added: Number.parseInt(added, 10) || 0,
        removed: Number.parseInt(removed, 10) || 0,
        binary: added === '-' && removed === '-',
      }
    })
}

export interface WorkingFile {
  path: string
  added: number
  removed: number
  uncommitted: boolean
  binary?: true
}

export interface WorkingDiff extends WorkingFile {
  hunks: DiffHunk[]
  truncated?: true
}

export interface WorkingChanges {
  head: string
  mergeBase: string
  files: WorkingFile[]
  diffs: WorkingDiff[]
}

const maxDiffRows = 3_000
const maxDiffFiles = 200

const readOnly = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'diff.external=',
  '--literal-pathspecs',
]

const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color']

export async function workingChanges(
  worktree: string,
  base: string,
  options: { diffs?: readonly string[] | 'all' } = {},
): Promise<WorkingChanges> {
  const head = await headCommit(worktree)
  const baseTip = await revParse(worktree, base)
  const common = await git(worktree, ...noHooks, 'rev-parse', '--git-common-dir')
  const objects = path.join(path.resolve(worktree, common), 'objects')
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-working-'))
  const gitDir = path.join(scratch, 'repo.git')
  const env = worktreeCommandEnv(
    {},
    {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: path.join(scratch, 'index'),
    },
  )
  const run = async (args: string[], work?: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', [...readOnly, ...args], {
        cwd: work ?? scratch,
        env: work === undefined ? env : { ...env, GIT_WORK_TREE: work },
        maxBuffer: 64 * 1024 * 1024,
      })
      return stdout
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim()
      throw new GitError(redactSecrets(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`))
    }
  }
  try {
    await run(['init', '--bare', '--quiet', gitDir])
    await writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${objects}\n`)
    await run(['read-tree', head])
    await run(['-c', 'core.bare=false', 'add', '--all', '--', '.'], worktree)
    const tree = (await run(['write-tree'])).trim()
    const mergeBase = (await run(['merge-base', head, baseTip])).trim()
    const uncommitted = new Set(
      (await run(['diff', ...diffFlags, '--name-only', '-z', head, tree, '--']))
        .split('\0')
        .filter((p) => p !== ''),
    )
    const files: WorkingFile[] = parseNumstat(
      await run(['diff', ...diffFlags, '--numstat', '-z', mergeBase, tree, '--']),
    ).map((file) => ({
      path: file.path,
      added: file.added,
      removed: file.removed,
      uncommitted: uncommitted.has(file.path),
      ...(file.binary && { binary: true as const }),
    }))
    const diffs: WorkingDiff[] = []
    const wanted = options.diffs === 'all' ? files.map((f) => f.path) : (options.diffs ?? [])
    for (const [i, name] of wanted.entries()) {
      const file = files.find((f) => f.path === name)
      if (!file) continue
      if (file.binary || i >= maxDiffFiles) {
        diffs.push({ ...file, hunks: [], ...(!file.binary && { truncated: true as const }) })
        continue
      }
      const patch = await run([
        'diff',
        ...diffFlags,
        '-U3',
        mergeBase,
        tree,
        '--',
        file.path,
      ]).catch(() => undefined)
      diffs.push(
        patch === undefined
          ? { ...file, hunks: [], truncated: true }
          : { ...file, ...parsePatch(patch) },
      )
    }
    return { head, mergeBase, files, diffs }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function parsePatch(patch: string): { hunks: DiffHunk[]; truncated?: true } {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  let old = 0
  let next = 0
  let rows = 0
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      current = { header: line, rows: [] }
      hunks.push(current)
      old = Number(header[1])
      next = Number(header[2])
      continue
    }
    if (!current) continue
    const mark = line[0]
    if (mark !== ' ' && mark !== '-' && mark !== '+') continue
    if (rows >= maxDiffRows) return { hunks, truncated: true }
    const text = line.slice(1)
    if (mark === ' ') current.rows.push({ kind: 'context', text, old: old++, new: next++ })
    else if (mark === '-') current.rows.push({ kind: 'removed', text, old: old++ })
    else current.rows.push({ kind: 'added', text, new: next++ })
    rows++
  }
  return { hunks }
}

export async function headCommit(worktree: string): Promise<string> {
  return git(worktree, ...noHooks, 'rev-parse', '--verify', 'HEAD^{commit}')
}

export async function moveBranchTo(worktree: string, commit: string): Promise<void> {
  const keys = await git(worktree, 'config', '--name-only', '--get-regexp', '^filter\\.').catch(
    () => '',
  )
  const filters = new Set(
    keys
      .split('\n')
      .map((key) => /^filter\.(.+)\.[^.]+$/.exec(key.trim())?.[1])
      .filter((name): name is string => name !== undefined),
  )
  const noFilters = [...filters].flatMap((name) => [
    ...['clean', 'smudge', 'process'].flatMap((part) => ['-c', `filter.${name}.${part}=`]),
    '-c',
    `filter.${name}.required=false`,
  ])
  await git(
    worktree,
    ...noHooks,
    ...noFilters,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'submodule.recurse=false',
    'reset',
    '--keep',
    commit,
  )
}

export async function addScratchWorktree(
  repo: string,
  worktree: string,
  from: string,
): Promise<void> {
  await git(repo, 'worktree', 'prune')
  await git(repo, 'worktree', 'add', '--detach', worktree, from)
}

export async function resetScratchWorktree(worktree: string, to: string): Promise<void> {
  await git(worktree, ...noHooks, 'reset', '--hard', '--quiet', to)
  await git(worktree, ...noHooks, 'clean', '-fdq')
}

export async function commitDate(repo: string, ref: string): Promise<string> {
  return git(repo, 'log', '-1', '--format=%cI', '--end-of-options', ref)
}

export async function commitAndPush(
  clone: string,
  options: {
    base: string
    files: Record<string, string | null>
    message: string
    branch: string
    url: string
    timeoutMs?: number
  },
): Promise<string> {
  const objects = path.join(clone, '.git', 'objects')
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-commit-'))
  const gitDir = path.join(scratch, 'repo.git')
  const env = worktreeCommandEnv(
    {},
    { GIT_TERMINAL_PROMPT: '0', GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(scratch, 'index') },
  )
  const run = async (
    args: string[],
    input?: string,
    extra: NodeJS.ProcessEnv = {},
    timeout?: number,
  ): Promise<string> => {
    const running = execFileAsync('git', args, {
      cwd: scratch,
      env: { ...env, ...extra },
      maxBuffer: 16 * 1024 * 1024,
      ...(timeout !== undefined && { timeout }),
    })
    running.child.stdin?.end(input ?? '')
    return (await running).stdout.trim()
  }
  try {
    await run(['init', '--bare', '--quiet', gitDir])
    await writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${objects}\n`)
    await run(['read-tree', `${options.base}^{tree}`])
    for (const [file, text] of Object.entries(options.files)) {
      if (text === null) {
        await run(['update-index', '--index-info'], `0 ${'0'.repeat(40)}\t${file}\n`)
        continue
      }
      const blob = await run(['hash-object', '-w', '--no-filters', '--stdin'], text)
      await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`])
    }
    const tree = await run(['write-tree'])
    const identity = await run(['var', 'GIT_COMMITTER_IDENT']).then(
      () => ({}),
      () => ({
        GIT_AUTHOR_NAME: 'TED',
        GIT_AUTHOR_EMAIL: 'ted@localhost',
        GIT_COMMITTER_NAME: 'TED',
        GIT_COMMITTER_EMAIL: 'ted@localhost',
      }),
    )
    const commit = await run(
      ['commit-tree', tree, '-p', options.base, '-F', '-'],
      `${options.message}\n`,
      identity,
    )
    await run(
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'protocol.ext.allow=never',
        'push',
        '--no-verify',
        '--porcelain',
        '--',
        options.url,
        `${commit}:refs/heads/${options.branch}`,
      ],
      undefined,
      {},
      options.timeoutMs ?? 5 * 60_000,
    )
    return commit
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ''}\n${(error as { stderr?: string }).stderr ?? ''}`
    const reason = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(fatal|error|remote:|!)/i.test(line))
      .slice(-3)
      .join('\n')
    throw new GitError(redactSecrets(`saving TED settings failed${reason ? `: ${reason}` : ''}`))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
