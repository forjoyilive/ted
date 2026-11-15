import {
  gitHubIssueKey,
  parseAsanaTaskUrl,
  parseGitHubIssueUrl,
  parseLinearUrl,
  type Task,
} from '@ted/protocol'
import { stageTitle } from '../workflow/workflow.ts'

export function sourceKey(url: string): string {
  const linear = parseLinearUrl(url)
  if (linear) return `linear:${linear.workspace.toLowerCase()}/${linear.identifier.toUpperCase()}`
  const asana = parseAsanaTaskUrl(url)
  if (asana) return `asana:${asana.gid}`
  const github = parseGitHubIssueUrl(url)
  if (github) return gitHubIssueKey(github)
  if (!URL.canParse(url)) return url.trim()
  const parsed = new URL(url)
  const host = parsed.host.toLowerCase().replace(/^www\./, '')
  return `${host}${parsed.pathname.replace(/\/+$/, '')}`
}

export type SourceClash =
  | { kind: 'open'; task: Task }
  | { kind: 'done'; task: Task }
  | { kind: 'archived'; task: Task }

export function sourceClash(
  tasks: readonly Task[],
  factoryId: string,
  url: string,
): SourceClash | undefined {
  const key = sourceKey(url)
  const same = tasks.filter(
    (t) => t.factoryId === factoryId && t.source !== undefined && sourceKey(t.source.url) === key,
  )
  const open = same.find((t) => !t.archived && t.stage !== 'done')
  if (open) return { kind: 'open', task: open }
  const done = same.findLast((t) => t.stage === 'done')
  if (done) return { kind: 'done', task: done }
  const archived = same.find((t) => t.archived)
  return archived && { kind: 'archived', task: archived }
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

export function mergeFacts(task: Task): string {
  const merged = task.merged
  const commit = task.repos.find((r) => r.pullRequest?.state === 'merged' && r.pushed)?.pushed
    ?.commit
  return [
    ...(merged ? [`merged ${day(merged.at)}`] : []),
    ...(commit ? [`commit ${commit.slice(0, 7)}`] : []),
  ].join(', ')
}

export function clashMessage(clash: SourceClash): string {
  const { task } = clash
  if (clash.kind === 'open') {
    return `Already tracked as ${task.displayId} · ${stageTitle(task.stage)}`
  }
  if (clash.kind === 'archived') {
    return `Already tracked as ${task.displayId}, which the human archived without merging. Leave it.`
  }
  const facts = mergeFacts(task)
  return `${task.displayId} is Done${facts === '' ? '' : `: ${facts}`}. Use --follow-up ${task.displayId} if it isn’t fixed.`
}
