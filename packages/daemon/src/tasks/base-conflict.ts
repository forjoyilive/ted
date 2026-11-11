import type { StageId } from '@ted/protocol'
import { stageTitle } from '../workflow/workflow.ts'
import { clean } from './github-activity.ts'

export interface BaseConflict {
  name: string
  base: string
  tip: string
  files: string[]
}

export const baseCheckTimeoutMs = 60_000

const listed = 10

function fileList(files: readonly string[]): string {
  const names = files.slice(0, listed).map((file) => `\`${clean(file, 200)}\``)
  const more = files.length - names.length
  return more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', ')
}

function found(conflict: BaseConflict, multiRepo: boolean): string {
  const where = multiRepo ? ` in ${conflict.name}` : ''
  return `TED test-merged ${conflict.base} at ${conflict.tip} into the branch${where} and these files conflict: ${fileList(conflict.files)}.`
}

export function conflictRefusal(
  task: { displayId: string; stage: StageId },
  conflict: BaseConflict,
  multiRepo: boolean,
): string {
  const head = `${task.displayId}’s branch conflicts with ${conflict.base}, so TED kept it in ${stageTitle(task.stage)}. ${found(conflict, multiRepo)}`
  if (task.stage === 'work') {
    return `${head} Merge that commit into the branch here (\`git merge ${conflict.tip}\` in the worktree${multiRepo ? ` for ${conflict.name}` : ''}), resolve the conflicts, run the tests and Checks the conflict touches, commit, then report the outcome again.`
  }
  return `${head} Send the Task back to Work with \`ted outcome back --to work --cause base-conflict --findings <file>\`; the Findings only need to name the conflict. TED doesn’t count that send-back against the limit.`
}

export function conflictChecked(conflict: BaseConflict, multiRepo: boolean): string {
  return `${found(conflict, multiRepo)} Merge that commit into the branch (\`git merge ${conflict.tip}\`), resolve the conflicts and commit. TED checks the branch against ${conflict.base} again before the Task leaves Work.`
}

export const noConflictFound =
  'TED found no conflict with the base branch, so it recorded this as an ordinary send-back.'
