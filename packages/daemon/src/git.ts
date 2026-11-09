import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { worktreeCommandEnv } from './command-env.ts'
import { redactSecrets } from './redact.ts'

const execFileAsync = promisify(execFile)

export class GitError extends Error {}

// The daemon has no terminal, so a credential prompt would wait forever.
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })

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
  const mergeBase = await git(worktree, ...noHooks, 'merge-base', 'HEAD', base)
  const changed = await git(
    worktree,
    ...noHooks,
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--name-only',
    '-z',
    mergeBase,
    '--',
  )
  const untracked = await git(
    worktree,
    ...noHooks,
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  )
  return [...new Set([...changed.split('\0'), ...untracked.split('\0')])].filter((p) => p !== '')
}

export async function commitsAhead(worktree: string, base: string): Promise<number> {
  const out = await git(worktree, ...noHooks, 'rev-list', '--count', `${base}..HEAD`, '--')
  return Number.parseInt(out, 10) || 0
}

const commandKeys = [
  /^core\.(sshcommand|askpass|gitproxy|alternaterefscommand)$/,
  /^credential\./,
  /^url\./,
  /^protocol\./,
  /^gpg\./,
  /^push\.gpgsign$/,
  /^include\./,
  /^includeif\./,
]

export async function unsafePushConfig(worktree: string): Promise<string[]> {
  const out = await git(worktree, 'config', '--list', '--show-scope')
  return out.split('\n').flatMap((line) => {
    const key = /^(local|worktree)\t([^=]+)=/.exec(line)?.[2]?.toLowerCase()
    return key !== undefined && commandKeys.some((k) => k.test(key)) ? [key] : []
  })
}

export async function pushBranch(
  worktree: string,
  branch: string,
  options: { url: string; expected?: string; timeoutMs?: number },
): Promise<string> {
  const unsafe = await unsafePushConfig(worktree)
  if (unsafe.length > 0) {
    throw new GitError(
      `TED didn’t push: the Task’s repo sets ${[...new Set(unsafe)].join(', ')} in its own git config`,
    )
  }
  const commit = await revParse(worktree, 'HEAD')
  const ref = `refs/heads/${branch}`
  const lease =
    options.expected === undefined ? [] : [`--force-with-lease=${ref}:${options.expected}`]
  const args = [
    ...noHooks,
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
    await execFileAsync('git', args, {
      cwd: worktree,
      env: worktreeCommandEnv({}, { GIT_TERMINAL_PROMPT: '0' }),
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
  }
  return commit
}
