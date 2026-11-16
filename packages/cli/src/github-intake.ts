import { type GitHubIntakeResult, maxGitHubIntakeTasks } from '@ted/protocol'
import { printable } from './asana.ts'

export function githubIntakeText(result: GitHubIntakeResult): string {
  const label = JSON.stringify(result.label)
  const count = result.imported.length
  const lines = [
    printable(
      count === 0
        ? `Imported no new GitHub issues labelled ${label}.`
        : `Imported ${count} GitHub ${count === 1 ? 'issue' : 'issues'} labelled ${label}:`,
    ),
    ...result.imported.map((item) =>
      printable(
        `  ${item.root.displayId} ${item.issue}${item.created.length > 1 ? ` (with ${item.created.length - 1} sub-${item.created.length === 2 ? 'issue' : 'issues'})` : ''}`,
      ),
    ),
  ]
  if (result.tracked > 0)
    lines.push(
      `${result.tracked} ${result.tracked === 1 ? 'issue is' : 'issues are'} already tracked or under a tracked issue.`,
    )
  for (const item of result.skipped) lines.push(printable(`Skipped ${item.issue}: ${item.reason}`))
  for (const repo of result.unlisted)
    lines.push(printable(`Couldn’t list ${repo.repo}: ${repo.reason}.`))
  if (result.left > 0)
    lines.push(
      `${result.left} more ${result.left === 1 ? 'issue waits' : 'issues wait'} for the next run; TED creates at most ${maxGitHubIntakeTasks} Tasks per run.`,
    )
  if (result.incomplete !== undefined) lines.push(printable(result.incomplete))
  if (result.stopped !== undefined) lines.push(printable(result.stopped))
  return lines.join('\n')
}
