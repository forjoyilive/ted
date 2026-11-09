import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class GitError extends Error {}

// The daemon has no terminal, so a credential prompt would wait forever.
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new GitError(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`, { cause: error })
  }
}

export async function clone(url: string, into: string): Promise<void> {
  await git(path.dirname(into), 'clone', '--', url, into)
}

export async function fetch(repo: string): Promise<void> {
  await git(repo, 'fetch', '--prune', 'origin')
}

export async function defaultBranch(repo: string): Promise<string> {
  const ref = await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  return ref.replace(/^origin\//, '')
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(
    () => true,
    () => false,
  )
}

export async function addWorktree(
  repo: string,
  input: { path: string; branch: string; from: string },
): Promise<void> {
  await git(repo, 'worktree', 'add', '--no-track', '-b', input.branch, input.path, input.from)
}

export async function removeWorktree(repo: string, worktree: string): Promise<void> {
  await git(repo, 'worktree', 'remove', '--force', worktree)
}
