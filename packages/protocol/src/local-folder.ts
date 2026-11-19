import { isArray, isInteger, isObject, isString, type Untyped } from './parse.ts'

export interface LocalFolderCheck {
  checked: boolean
  problem?: string
  branch?: string
  against?: string
  head?: string
  target?: string
  behind?: number
  ahead?: number
  uncommitted?: number
  offGitHub?: true
  main?: string
  behindMain?: number
  copyBehind?: number
}

export interface LocalFolderUpdate {
  from: string
  to: string
  commits: number
  dependencies?: string[]
}

export interface LocalFolderState {
  check: LocalFolderCheck
  update?: LocalFolderUpdate
  updateFailed?: string
}

export type LocalFolderAction =
  | { kind: 'run' }
  | { kind: 'update' }
  | { kind: 'hold'; reason: string; fix: string; detail?: string }

export const notRepositoryProblem = 'the folder isn’t a git repository with a commit'

export function isNotRepository(check: LocalFolderCheck): boolean {
  return !check.checked && check.problem === notRepositoryProblem
}

export function notedNotRepository(
  runs: readonly { id: string; folder: string; local?: LocalFolderState | undefined }[],
): Set<string> {
  const noted = new Set<string>()
  const repeated = new Set<string>()
  for (const run of runs) {
    if (!run.local || !isNotRepository(run.local.check)) continue
    if (noted.has(run.folder)) repeated.add(run.id)
    else noted.add(run.folder)
  }
  return repeated
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function localFolderAction(check: LocalFolderCheck, folder: string): LocalFolderAction {
  const behind = check.behind ?? 0
  if (!check.checked || behind === 0) return { kind: 'run' }
  const ahead = check.ahead ?? 0
  if (ahead > 0)
    return {
      kind: 'hold',
      reason: `it has ${count(ahead, 'commit')} that ${ahead === 1 ? 'isn’t' : 'aren’t'} on GitHub`,
      fix: `Push or rebase your commits in ${folder}, then ask the Agent to run it again.`,
    }
  const uncommitted = check.uncommitted ?? 0
  if (uncommitted > 0)
    return {
      kind: 'hold',
      reason: `${count(uncommitted, 'file')} ${uncommitted === 1 ? 'has' : 'have'} uncommitted changes`,
      fix: `Commit or stash your changes in ${folder}, then ask the Agent to run it again.`,
    }
  if (check.branch === undefined)
    return {
      kind: 'hold',
      reason: 'it isn’t on a branch',
      fix: `Check out ${check.against ?? 'a branch'} in ${folder}, then ask the Agent to run it again.`,
    }
  return { kind: 'update' }
}

function fileList(lines: readonly string[], from: number): string {
  const files: string[] = []
  for (const line of lines.slice(from + 1)) {
    if (!/^\s/.test(line) || line.trim() === '') break
    files.push(line.trim())
  }
  if (files.length === 0) return ''
  const shown =
    files.length > 3
      ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`
      : files.join(', ')
  return ` (${shown})`
}

export interface UpdateFailure {
  reason: string
  detail?: string
}

export function updateFailure(raw: string): UpdateFailure {
  const gitSaid = /^git [a-z-]+ failed(?:: ([\s\S]*))?$/.exec(raw)
  if (!gitSaid) return { reason: raw }
  const said = (gitSaid[1] ?? '').trim()
  const detail = said === '' ? undefined : said.replace(/\s+/g, ' ')
  const lines = said.split('\n')
  const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line))
  const untracked = at(/untracked working tree files would be (overwritten|removed)/i)
  const changed = at(/local changes to the following files would be overwritten/i)
  const reason =
    untracked >= 0
      ? `untracked files in the folder would be overwritten${fileList(lines, untracked)}`
      : changed >= 0
        ? `uncommitted changes in the folder would be overwritten${fileList(lines, changed)}`
        : /not possible to fast-forward|diverging branches/i.test(said)
          ? 'the folder’s branch has moved away from GitHub’s, so it can’t be fast-forwarded'
          : /index\.lock|another git process/i.test(said)
            ? 'another git process is using the folder'
            : raw.startsWith('git fetch failed')
              ? 'Ted couldn’t fetch from GitHub into the folder'
              : 'git couldn’t update the folder'
  return { reason, ...(detail !== undefined && { detail }) }
}

export function heldAfterFailedUpdate(problem: string, folder: string): LocalFolderAction {
  const { reason, detail } = updateFailure(problem)
  return {
    kind: 'hold',
    reason,
    fix: `Update ${folder} yourself, then ask the Agent to run it again.`,
    ...(detail !== undefined && { detail }),
  }
}

export function repoShortName(repo: string): string {
  return repo.split('/').at(-1) ?? repo
}

export function behindText(check: LocalFolderCheck): string {
  return `${count(check.behind ?? 0, 'commit')} behind ${check.against ?? 'GitHub'}`
}

function noteSentences(check: LocalFolderCheck, name: string, noted: boolean): string[] {
  if (noted && isNotRepository(check)) return []
  if (!check.checked)
    return [`Ted couldn’t check your local ${name} against GitHub: ${check.problem ?? 'unknown'}.`]
  const notes: string[] = []
  const branch = check.branch
  const offMain = branch !== undefined && check.main !== undefined && branch !== check.main
  const mainGap =
    offMain && (check.behindMain ?? 0) > 0
      ? `, ${count(check.behindMain ?? 0, 'commit')} behind ${check.main}`
      : ''
  if (check.offGitHub)
    notes.push(`Your local ${name} is on ${branch}, which isn’t on GitHub${mainGap}.`)
  else if ((check.behind ?? 0) > 0)
    notes.push(`Your local ${name} is ${behindText(check)}${offMain ? ` (on ${branch})` : ''}.`)
  else if ((check.ahead ?? 0) > 0)
    notes.push(
      `Your local ${name} is ${count(check.ahead ?? 0, 'commit')} ahead of ${check.against}.`,
    )
  else if (offMain)
    notes.push(`Your local ${name} is on ${branch}, up to date with GitHub${mainGap}.`)
  if ((check.uncommitted ?? 0) > 0)
    notes.push(
      `Your local ${name} has uncommitted changes in ${count(check.uncommitted ?? 0, 'file')}.`,
    )
  const copy = copyNote(check)
  if (copy) notes.push(copy)
  return notes
}

function copyNote(check: LocalFolderCheck): string | undefined {
  if ((check.copyBehind ?? 0) === 0) return undefined
  return `This chat’s copy is ${count(check.copyBehind ?? 0, 'commit')} behind ${check.main ?? 'main'}, so the Agent may have read older instructions.`
}

function dependencyText(update: LocalFolderUpdate): string {
  const files = update.dependencies ?? []
  if (files.length === 0) return ''
  const shown = files.length > 3 ? `${files.slice(0, 3).join(', ')} and others` : files.join(', ')
  return ` ${shown} changed, so dependencies may need installing.`
}

export function localFolderCardAction(state: LocalFolderState, folder: string): LocalFolderAction {
  return state.updateFailed !== undefined
    ? heldAfterFailedUpdate(state.updateFailed, folder)
    : localFolderAction(state.check, folder)
}

export function localFolderCardText(
  state: LocalFolderState,
  folder: string,
  name: string,
): { tone: 'ok' | 'warn' | 'plain'; text: string; fix?: string; detail?: string } | undefined {
  const { check } = state
  const action = localFolderCardAction(state, folder)
  if (action.kind === 'update')
    return {
      tone: 'ok',
      text: `${behindText(check)}. Ted will update it to ${shortCommit(check.target ?? '')} before running. Nothing of yours changes: it has no uncommitted changes or commits of its own.`,
    }
  if (action.kind === 'hold')
    return {
      tone: 'warn',
      text: `${behindText(check)}, and Ted can’t update it: ${action.reason}.`,
      fix: action.fix,
      ...(action.detail !== undefined && { detail: action.detail }),
    }
  const notes = noteSentences(check, name, false)
  return notes.length === 0 ? undefined : { tone: 'plain', text: notes.join(' ') }
}

export function localFolderLine(
  state: LocalFolderState,
  name: string,
  noted = false,
): { tone: 'ok' | 'warn' | 'plain'; text: string; detail?: string } | undefined {
  const { check, update } = state
  if (update) {
    const copy = copyNote(check)
    return {
      tone: 'ok',
      text: `Ted updated your local ${name} from ${shortCommit(update.from)} to ${shortCommit(update.to)} (${count(update.commits, 'commit')}) before running.${dependencyText(update)}${copy ? ` ${copy}` : ''}`,
    }
  }
  if (state.updateFailed !== undefined) {
    const { reason, detail } = updateFailure(state.updateFailed)
    return {
      tone: 'warn',
      text: `Your local ${name} is ${behindText(check)}, and Ted’s update failed: ${reason}.`,
      ...(detail !== undefined && { detail }),
    }
  }
  const notes = noteSentences(check, name, noted)
  if (notes.length === 0) return undefined
  return { tone: (check.behind ?? 0) > 0 ? 'warn' : 'plain', text: notes.join(' ') }
}

export function localFolderAgentNote(
  state: LocalFolderState,
  folder: string,
  noted = false,
): string | undefined {
  const { check, update } = state
  const lines: string[] = []
  if (update) {
    lines.push(
      `Ted updated the local folder from ${shortCommit(update.from)} to ${shortCommit(update.to)} (it was ${behindText(check)}) before running your command.${dependencyText(update)}`,
    )
  } else if (!check.checked) {
    if (!(noted && isNotRepository(check)))
      lines.push(
        `Ted couldn’t check the local folder against GitHub (${check.problem ?? 'unknown'}), so it may be out of date.`,
      )
  } else {
    const action =
      state.updateFailed !== undefined
        ? heldAfterFailedUpdate(state.updateFailed, folder)
        : localFolderAction(check, folder)
    if (action.kind === 'hold')
      lines.push(
        `The local folder is ${behindText(check)}, and Ted couldn’t update it because ${action.reason}${action.detail !== undefined ? ` (git said: ${action.detail})` : ''}. If the command failed, the older code there may be why, not your command. Don’t change the command; tell the user.`,
      )
    else if (check.offGitHub)
      lines.push(`The local folder is on the branch ${check.branch}, which isn’t on GitHub.`)
    else if ((check.ahead ?? 0) > 0)
      lines.push(
        `The local folder is ${count(check.ahead ?? 0, 'commit')} ahead of ${check.against}; ${(check.ahead ?? 0) === 1 ? 'that commit isn’t' : 'those commits aren’t'} on GitHub.`,
      )
    else if (check.branch !== undefined && check.main !== undefined && check.branch !== check.main)
      lines.push(
        `The local folder is on the branch ${check.branch}, which matches its copy on GitHub${(check.behindMain ?? 0) > 0 ? ` and is ${count(check.behindMain ?? 0, 'commit')} behind ${check.main}` : ''}.`,
      )
    if ((check.uncommitted ?? 0) > 0 && action.kind !== 'hold')
      lines.push(
        `The local folder has uncommitted changes in ${count(check.uncommitted ?? 0, 'file')}.`,
      )
  }
  if ((check.copyBehind ?? 0) > 0)
    lines.push(
      `This chat’s copy of the code is ${count(check.copyBehind ?? 0, 'commit')} behind ${check.main ?? 'main'}. What you read in your copy may be older than what ran.`,
    )
  return lines.length === 0 ? undefined : lines.join(' ')
}

function count0(value: Untyped): number | undefined {
  return isInteger(value) && value >= 0 ? value : undefined
}

function text(value: Untyped): string | undefined {
  return isString(value) ? value : undefined
}

export function parseLocalFolderState(value: Untyped): LocalFolderState | undefined {
  if (!isObject(value) || !isObject(value.check)) return undefined
  const c = value.check
  if (c.checked !== true && c.checked !== false) return undefined
  const check: LocalFolderCheck = { checked: c.checked }
  for (const key of ['problem', 'branch', 'against', 'head', 'target', 'main'] as const) {
    const found = text(c[key])
    if (found !== undefined) check[key] = found
  }
  for (const key of ['behind', 'ahead', 'uncommitted', 'behindMain', 'copyBehind'] as const) {
    const found = count0(c[key])
    if (found !== undefined) check[key] = found
  }
  if (c.offGitHub === true) check.offGitHub = true
  const u = value.update
  const update: LocalFolderUpdate | undefined =
    isObject(u) && isString(u.from) && isString(u.to) && count0(u.commits) !== undefined
      ? {
          from: u.from,
          to: u.to,
          commits: count0(u.commits) ?? 0,
          ...(isArray(u.dependencies) && {
            dependencies: u.dependencies.filter(isString),
          }),
        }
      : undefined
  const failed = text(value.updateFailed)
  return {
    check,
    ...(update && { update }),
    ...(failed !== undefined && { updateFailed: failed }),
  }
}
