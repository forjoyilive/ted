import { type GitHubIssueUrl, gitHubIssueKey, parseGitHubIssueUrl, type Task } from '@ted/protocol'
import { stagePhase } from '@ted/protocol/stage'
import type { Clock } from '../clock.ts'
import {
  type GitHubIssueSyncApi,
  type IssueSyncState,
  issueKey,
  type PullRequestRef,
  parsePullRequestRef,
} from '../github/issue-sync.ts'
import type { TedStore } from '../store/index.ts'
import { type IssueRef, withIssueLine } from './pull-requests.ts'
import {
  type TrackerConnector,
  type TrackerItem,
  type TrackerRecords,
  TrackerWait,
} from './tracker-sync/connector.ts'
import { trackerRecords } from './tracker-sync/records.ts'
import {
  createTrackerSync,
  type TrackerSync,
  type TrackerTaskActions,
} from './tracker-sync/sync.ts'

export interface GitHubSyncOptions {
  store: TedStore
  github: GitHubIssueSyncApi
  actions: TrackerTaskActions
  clock?: Clock
  everyMs: number
  inBackground(what: string, work: () => Promise<void>): void
}

export const githubTracker = 'github'
export const githubSteps = ['started', 'fixed'] as const
export const startedText = 'Work on this has started.'

export function fixedText(urls: readonly string[]): string {
  const list =
    urls.length <= 1 ? (urls[0] ?? '') : `${urls.slice(0, -1).join(', ')} and ${urls.at(-1) ?? ''}`
  return `Fixed in ${list}.`
}

export function leftOpenNote(label: string, open: number): string {
  return `Ted left ${label} open on GitHub because ${open === 1 ? 'one of its sub-issues is' : `${open} of its sub-issues are`} still open.`
}

const pullRequestUrls = (task: Task): string[] =>
  task.repos.flatMap((repo) => (repo.pullRequest && !repo.removed ? [repo.pullRequest.url] : []))

const issueRef = (issue: GitHubIssueUrl) => `${issue.owner}/${issue.repo}#${issue.number}`

function stateName(state: IssueSyncState): string {
  if (state.open) return 'open'
  return state.closedAs === 'closed' || state.closedAs === undefined
    ? 'closed'
    : `closed as ${state.closedAs}`
}

type Handle = IssueSyncState & { issue: GitHubIssueUrl }

export interface GitHubConnector extends TrackerConnector<GitHubIssueUrl, Handle> {
  openSubIssues(task: Pick<Task, 'source'>): number | undefined
}

export function githubConnector(store: TedStore, github: GitHubIssueSyncApi): GitHubConnector {
  const switchOn = () => store.settings().githubIssueSync
  const subIssues = new Map<string, number>()
  const partOfConfirmed = new Set<string>()

  const writable = (taskId: string): boolean => {
    const task = store.getTask(taskId)
    return switchOn() && task !== undefined && (!task.archived || store.isMerged(taskId))
  }

  async function setLine(pr: PullRequestRef, taskId: string, ref: IssueRef): Promise<void> {
    const body = await github.pullRequestBody(pr)
    const next = withIssueLine(body, ref)
    if (next === body) return
    if (!writable(taskId)) throw new TrackerWait(0)
    await github.setPullRequestBody(pr, next)
  }

  function ownPullRequest(issue: GitHubIssueUrl, url: string | undefined): boolean {
    if (url === undefined) return false
    const key = gitHubIssueKey(issue)
    return store.taskSourceUrls().some(({ taskId, url: source }) => {
      const link = parseGitHubIssueUrl(source)
      if (!link || gitHubIssueKey(link) !== key) return false
      const task = store.getTask(taskId)
      return task !== undefined && pullRequestUrls(task).includes(url)
    })
  }

  async function postOnce(issue: GitHubIssueUrl, text: string, still: () => boolean) {
    const { viewer, comments, complete } = await github.comments(issue)
    const posted = comments.some(
      (c) => c.author.toLowerCase() === viewer.toLowerCase() && c.body.trim() === text,
    )
    if (posted) return true
    if (!complete) return false
    if (!switchOn() || !still()) return false
    await github.comment(issue, text)
    return true
  }

  return {
    id: githubTracker,
    name: 'GitHub',
    groupNoun: 'repo',
    enabled: (settings) => settings.githubIssueSync,
    source: (url) => parseGitHubIssueUrl(url),
    key: (issue) => issueKey(issue),
    label: (issue) => issueRef(issue),
    async read(issues) {
      const states = await github.states(issues)
      if (!states) return undefined
      const items = new Map<string, TrackerItem<IssueSyncState & { issue: GitHubIssueUrl }>>()
      for (const issue of issues) {
        const state = states.get(issueKey(issue))
        if (!state) continue
        subIssues.set(issueKey(issue), state.openSubIssues)
        items.set(issueKey(issue), {
          closed: !state.open && !ownPullRequest(issue, state.closedBy),
          state: stateName(state),
          handle: { ...state, issue },
        })
      }
      return { items }
    },
    steps: githubSteps,
    async advance({ task, merged, step, item }) {
      const issue = item.handle.issue
      const current = () => store.getTask(task.id)
      if (merged) {
        if (step === 'fixed') return undefined
        const urls = pullRequestUrls(task)
        const stillMerged = () => {
          const now = current()
          return now?.stage === 'done' && store.isMerged(task.id)
        }
        if (!(await postOnce(issue, fixedText(urls), stillMerged))) return undefined
        if (item.handle.open) {
          if (item.handle.openSubIssues > 0) {
            store.postComment({
              taskId: task.id,
              kind: 'note',
              author: { kind: 'ted' },
              body: leftOpenNote(issueRef(issue), item.handle.openSubIssues),
            })
            return { step: 'fixed' }
          }
          if (!switchOn() || !stillMerged()) return undefined
          await github.close(issue)
          return { step: 'fixed', moved: 'closed' }
        }
        return { step: 'fixed' }
      }
      if (item.handle.openSubIssues > 0 && !task.archived) {
        const ref = { ref: issueRef(issue), several: true }
        const linked = store.trackerSync(task.id, githubTracker).linked
        for (const url of pullRequestUrls(task)) {
          const pr = parsePullRequestRef(url)
          if (!pr || !linked.has(url) || partOfConfirmed.has(url)) continue
          await setLine(pr, task.id, ref)
          partOfConfirmed.add(url)
        }
      }
      const order = store.recordedStages(task.id)?.map((planned) => planned.stage)
      if (step !== undefined || task.archived || stagePhase(task.stage, order) === 'before')
        return undefined
      if (task.stage === 'done' || item.closed || !item.handle.open) return undefined
      const stillOpen = () => {
        const now = current()
        return now !== undefined && !now.archived && now.stage !== 'done'
      }
      if (!(await postOnce(issue, startedText, stillOpen))) return undefined
      return { step: 'started' }
    },
    async link(item, { url }, task) {
      const pr = parsePullRequestRef(url)
      const source = task.source && parseGitHubIssueUrl(task.source.url)
      if (!pr || !source) return
      const several =
        task.repos.filter((repo) => !repo.removed).length > 1 || item.handle.openSubIssues > 0
      await setLine(pr, task.id, { ref: issueRef(source), several })
    },
    openSubIssues(task) {
      const source = task.source && parseGitHubIssueUrl(task.source.url)
      return source && subIssues.get(issueKey(source))
    },
    texts: {
      closedTitle: (label, state) => `${label} was ${state} on GitHub`,
      closedBody: (label, state, pastSignOff) =>
        `${label} was ${state} on GitHub ${pastSignOff ? 'after you signed off on this Task' : 'while this Task is still being worked on'}. Ted keeps going until you choose.`,
      childArchived: (child, label, state) =>
        `Ted archived ${child}, a Task under this one, because ${label} was ${state} on GitHub.`,
      groupTitle: (group) => `Sync ${group.name} issues with GitHub?`,
      groupBody: ({ label }) => `Ted doesn’t ask before syncing ${label}.`,
    },
  }
}

export function githubRecords(
  store: TedStore,
): TrackerRecords<IssueSyncState & { issue: GitHubIssueUrl }> {
  const shared = trackerRecords<IssueSyncState & { issue: GitHubIssueUrl }>(store, githubTracker)
  return {
    ...shared,
    see(taskId, label, item) {
      const first = shared.record(taskId).seen === undefined
      shared.see(taskId, label, item)
      const task = store.getTask(taskId)
      if (!first || !task || (!task.archived && task.stage !== 'done')) return
      shared.moved(taskId, label, 'fixed', undefined)
      const urls = pullRequestUrls(task)
      if (urls.length > 0) shared.linked(taskId, label, urls)
    },
    syncState: (task: Task) => (task.source?.github ? 'on' : undefined),
  }
}

export interface GitHubSync extends TrackerSync {
  openSubIssues(task: Pick<Task, 'source'>): number | undefined
}

export function createGitHubSync(options: GitHubSyncOptions): GitHubSync {
  const connector = githubConnector(options.store, options.github)
  const sync = createTrackerSync({
    store: options.store,
    connector,
    records: githubRecords(options.store),
    actions: options.actions,
    everyMs: options.everyMs,
    inBackground: options.inBackground,
    ...(options.clock && { clock: options.clock }),
  })
  return { close: () => sync.close(), openSubIssues: (task) => connector.openSubIssues(task) }
}
