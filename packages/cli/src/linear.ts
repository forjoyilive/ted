import { type LinearIntakeResult, maxLinearIntakeTasks } from '@ted/protocol'
import { printable } from './asana.ts'

export function linearIntakeText(result: LinearIntakeResult): string {
  const from = `the Linear ${result.scope.kind} ${result.scope.name}`
  const count = result.imported.length
  const lines = [
    printable(
      count === 0
        ? `Imported nothing new from ${from}.`
        : `Imported ${count} Linear ${count === 1 ? 'issue' : 'issues'} from ${from}:`,
    ),
    ...result.imported.map((item) =>
      printable(`  ${item.task.displayId} ${item.identifier} ${item.title}`),
    ),
  ]
  if (result.tracked > 0)
    lines.push(
      `${result.tracked} ${result.tracked === 1 ? 'issue is' : 'issues are'} already tracked in this Factory.`,
    )
  for (const item of result.skipped)
    lines.push(printable(`Skipped ${item.identifier} (${item.url}): ${item.reason}`))
  if (result.left > 0)
    lines.push(
      `${result.left} more ${result.left === 1 ? 'issue waits' : 'issues wait'} for the next run; TED creates at most ${maxLinearIntakeTasks} Tasks per run.`,
    )
  if (result.incomplete !== undefined) lines.push(printable(result.incomplete))
  if (result.stopped !== undefined) lines.push(printable(result.stopped))
  return lines.join('\n')
}
