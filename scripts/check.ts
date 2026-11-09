import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function checkedFile(): string {
  return path.resolve(root, git('rev-parse', '--git-common-dir'), 'ted-checked')
}

export function checkedCommits(text: string): Set<string> {
  return new Set(text.split('\n').filter((line) => /^[0-9a-f]{40}$/.test(line)))
}

export function hasPassed(commit: string): boolean {
  const file = checkedFile()
  return existsSync(file) && checkedCommits(readFileSync(file, 'utf8')).has(commit)
}

export function runChecks(): boolean {
  const steps: [string, string[]][] = [
    ['Install', ['install', '--frozen-lockfile']],
    ['Typecheck', ['typecheck']],
    ['Lint', ['lint']],
    ['Test', ['test']],
  ]
  for (const [title, args] of steps) {
    console.log(`\n== ${title}`)
    if (spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' }).status !== 0) {
      console.error(`check: ${title} failed`)
      return false
    }
  }
  return true
}

export function checkAndRecord(): boolean {
  const clean = git('status', '--porcelain') === ''
  const commit = git('rev-parse', 'HEAD')
  if (!runChecks()) return false
  if (clean && git('status', '--porcelain') === '' && git('rev-parse', 'HEAD') === commit) {
    appendFileSync(checkedFile(), `${commit}\n`)
    console.log(
      `\nAll checks passed on ${commit.slice(0, 7)}. A release of this commit can skip them.`,
    )
  } else {
    console.log(
      '\nAll checks passed, but the working tree had changes or HEAD moved, so nothing was recorded.',
    )
  }
  return true
}

if (import.meta.main) process.exit(checkAndRecord() ? 0 : 1)
