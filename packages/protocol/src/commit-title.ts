export const commitTypes = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const

export const maxCommitTitle = 72
export const maxCommitBody = 4000

const conventional = new RegExp(`^(${commitTypes.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`)
const taskIdWord = /^\(?[A-Z][A-Z0-9]*-\d+\)?$/

export function commitTitle(title: string, displayId: string): string {
  return `${title} (${displayId})`
}

export function commitTitleProblem(title: string, displayId: string): string | undefined {
  const full = commitTitle(title, displayId)
  if (full.length > maxCommitTitle) {
    return `the title with “(${displayId})” added is ${full.length} characters; keep it to ${maxCommitTitle}`
  }
  if (!conventional.test(title)) {
    return `start the title with a Conventional Commits type, an optional scope and a colon, such as “fix(app): keep the sidebar open”. Types: ${commitTypes.join(', ')}`
  }
  if (taskIdWord.test(title.trimEnd().split(' ').at(-1) ?? ''))
    return `leave the Task ID out of the title; TED adds “(${displayId})”`
  return undefined
}
