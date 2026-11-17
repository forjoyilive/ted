import { type LinearUrl, parseLinearUrl, type Task } from '@ted/protocol'
import { mergesHere } from '@ted/protocol/stage'
import type { Clock } from '../clock.ts'
import {
  type Linear,
  type LinearIssueState,
  type LinearWorkflowState,
  linearIssueKey,
} from '../linear/linear.ts'
import { type LinearStep, linearSteps, type TedStore } from '../store/index.ts'
import type { TrackerConnector, TrackerItem, TrackerRecords } from './tracker-sync/connector.ts'
import {
  createTrackerSync,
  type TrackerSync,
  type TrackerTaskActions,
} from './tracker-sync/sync.ts'

export type LinearSyncApi = Pick<Linear, 'issueStates' | 'teamStates' | 'moveIssue' | 'linkUrl'>

export interface LinearSyncOptions {
  store: TedStore
  linear: LinearSyncApi
  actions: TrackerTaskActions
  clock?: Clock
  everyMs: number
  inBackground(what: string, work: () => Promise<void>): void
}

export function isClosedType(type: string): boolean {
  return type === 'completed' || type === 'canceled'
}

const isReviewName = (name: string) => /\breview\b/i.test(name)

function rankOf(state: Pick<LinearWorkflowState, 'name' | 'type'>): number {
  if (isClosedType(state.type)) return 3
  if (state.type === 'started') return isReviewName(state.name) ? 2 : 1
  return 0
}

const stepRank = (step: LinearStep | undefined) =>
  step === undefined ? 0 : linearSteps.indexOf(step) + 1

export function pickState(
  states: readonly LinearWorkflowState[],
  step: LinearStep,
): LinearWorkflowState | undefined {
  const byPosition = [...states].sort((a, b) => a.position - b.position)
  const prefer = (list: LinearWorkflowState[], name: RegExp) =>
    list.find((s) => name.test(s.name)) ?? list[0]
  if (step === 'done') {
    return prefer(
      byPosition.filter((s) => s.type === 'completed'),
      /^done$/i,
    )
  }
  const started = byPosition.filter((s) => s.type === 'started')
  if (step === 'review') {
    return prefer(
      started.filter((s) => isReviewName(s.name)),
      /^in review$/i,
    )
  }
  return prefer(
    started.filter((s) => !isReviewName(s.name)),
    /^in progress$/i,
  )
}

function targetStep(
  task: Pick<Task, 'archived' | 'stage'>,
  merged: boolean,
): LinearStep | undefined {
  if (merged) return 'done'
  if (task.archived || task.stage === 'done') return undefined
  if (mergesHere(task.stage)) return 'review'
  if (task.stage !== 'backlog') return 'started'
  return undefined
}

export function linearMove(
  task: Pick<Task, 'archived' | 'stage'>,
  merged: boolean,
  previous: LinearStep | undefined,
  state: Pick<LinearWorkflowState, 'name' | 'type'>,
): { step: LinearStep; move: boolean } | undefined {
  const open = !task.archived && task.stage !== 'done'
  const target = open && isClosedType(state.type) ? undefined : targetStep(task, merged)
  if (!target || stepRank(target) <= stepRank(previous)) return undefined
  return { step: target, move: rankOf(state) < stepRank(target) }
}

export function linearConnector(
  linearApi?: LinearSyncApi,
): TrackerConnector<LinearUrl, LinearIssueState> {
  const linear = (): LinearSyncApi => {
    if (!linearApi) throw new Error('Linear sync has no Linear API')
    return linearApi
  }
  return {
    id: 'linear',
    name: 'Linear',
    groupNoun: 'team',
    enabled: (settings) => settings.linearSync,
    source: (url) => parseLinearUrl(url),
    key: (link) => linearIssueKey(link.workspace, link.identifier),
    label: (link) => link.identifier,
    async read(links) {
      const issues = await linear().issueStates(links)
      if (!issues) return undefined
      const items = new Map<string, TrackerItem<LinearIssueState>>()
      for (const [key, issue] of issues) {
        items.set(key, {
          closed: isClosedType(issue.state.type),
          state: issue.state.name,
          group: { key: issue.teamKey, name: issue.teamKey },
          handle: issue,
        })
      }
      return { items }
    },
    steps: linearSteps,
    async advance({ task, merged, step, item }) {
      const previous = linearSteps.find((s) => s === step)
      const decision = linearMove(task, merged, previous, item.handle.state)
      if (!decision) return undefined
      if (!decision.move) return { step: decision.step }
      const next = pickState(await linear().teamStates(item.handle.teamId), decision.step)
      if (!next) return { step: decision.step }
      await linear().moveIssue(item.handle.id, next.id)
      return { step: decision.step, moved: next.name }
    },
    async link(item, { url, title }) {
      await linear().linkUrl(item.handle.id, url, title)
    },
    texts: {
      closedTitle: (identifier, state) => `${identifier} was marked ${state} in Linear`,
      closedBody: (identifier, state, pastSignOff) =>
        pastSignOff
          ? `Someone marked ${identifier} ${state} in Linear after you signed off on this Task. Ted keeps going until you choose.`
          : `Someone marked ${identifier} ${state} in Linear while this Task is still being worked on. Ted keeps going until you choose.`,
      childArchived: (child, identifier, state) =>
        `Ted archived ${child}, a Task under this one, because ${identifier} was marked ${state} in Linear.`,
      groupTitle(team, factoryName) {
        const named = team.name === team.key ? team.key : `${team.name} (${team.key})`
        return `Sync ${named} issues with Linear for Automations in ${factoryName}?`
      },
      groupBody: ({ automation, task, label, group, factoryName }) =>
        [
          `${automation} made ${task} from ${label}. Ted doesn’t change Linear issues for Tasks an Automation makes until you allow it for the issue’s team.`,
          `If you allow ${group.key} for ${factoryName}, Ted moves each issue to In Progress when its Task starts, to review at the sign-off before Merge, and to Done when the Task merges, and attaches the Task’s pull requests. It does this for ${group.key} Tasks Automations already made in ${factoryName}, too.`,
          'Not now keeps them as they are, and Ted won’t ask about this team again. You can change either in Settings → Integrations.',
        ].join('\n\n'),
    },
  }
}

export function linearRecords(store: TedStore): TrackerRecords<LinearIssueState> {
  return {
    record(taskId) {
      const { seen, step, linked } = store.linearSync(taskId)
      return {
        ...(seen && {
          seen: { closed: isClosedType(seen.stateType), state: seen.state, group: seen.team },
        }),
        ...(step && { step }),
        linked,
      }
    },
    see(taskId, identifier, item) {
      const before = store.linearSync(taskId).seen
      const stateType = item.handle.state.type
      const state = item.state
      const team = item.handle.teamKey
      if (before?.stateType !== stateType || before.state !== state || before.team !== team) {
        store.linearIssueSeen(taskId, identifier, { stateType, state, team })
      }
    },
    moved(taskId, identifier, step, state) {
      const reached = linearSteps.find((s) => s === step)
      if (reached) store.linearIssueMoved(taskId, identifier, reached, state)
    },
    linked(taskId, identifier, urls) {
      store.linearPullRequestsLinked(taskId, identifier, urls)
    },
    syncState: (task) => task.linearSync,
    allowTask(task, identifier) {
      store.linearSyncAllowed(task.id, identifier)
    },
    groups: (settings, factoryId) => ({
      allowed: settings.linearSyncTeams[factoryId] ?? [],
      declined: settings.linearSyncDeclined[factoryId] ?? [],
    }),
    allowGroup: (factoryId, team, consents) =>
      store.allowLinearTeam(
        factoryId,
        team,
        consents.map(({ taskId, label }) => ({ taskId, identifier: label })),
      ),
    declineGroup(factoryId, team) {
      const declined = store.settings().linearSyncDeclined
      const listed = declined[factoryId] ?? []
      if (!listed.includes(team)) {
        store.updateSettings({
          linearSyncDeclined: { ...declined, [factoryId]: [...listed, team] },
        })
      }
    },
    forgetGroup(factoryId, team, list) {
      const name = list === 'allowed' ? 'linearSyncTeams' : 'linearSyncDeclined'
      const lists = store.settings()[name]
      const listed = lists[factoryId] ?? []
      if (!listed.includes(team)) return store.settings()
      return store.updateSettings({
        [name]: { ...lists, [factoryId]: listed.filter((t) => t !== team) },
      })
    },
    closedPurpose: { kind: 'linear-closed' },
    isClosedQuestion: (comment) => comment.purpose?.kind === 'linear-closed',
    groupAsk: (team) => ({ linearTeam: team }),
    isGroupAsk: (comment) => comment.purpose?.kind === 'linear-team',
    askedGroup: (comment) =>
      comment.purpose?.kind === 'linear-team' ? comment.linearTeam?.key : undefined,
    withdrawn: (why, at) => ({ kind: 'withdrawn', at, linear: why }),
  }
}

export function createLinearSync(options: LinearSyncOptions): TrackerSync {
  return createTrackerSync({
    store: options.store,
    connector: linearConnector(options.linear),
    records: linearRecords(options.store),
    actions: options.actions,
    everyMs: options.everyMs,
    inBackground: options.inBackground,
    ...(options.clock && { clock: options.clock }),
  })
}
