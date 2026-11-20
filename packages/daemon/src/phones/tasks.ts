import {
  type BoardStage,
  type Comment,
  encodeCommentsCursor,
  encodeTasksCursor,
  type Factory,
  type FactoryIcon,
  type PhoneCommentEntry,
  type PhoneCommentsCursor,
  type PhoneFactoryIcon,
  type PhoneStatusSection,
  type PhoneTaskCommentsBody,
  type PhoneTaskDetail,
  type PhoneTaskGroup,
  type PhoneTaskRow,
  type PhoneTaskSection,
  type PhoneTasksBody,
  type PhoneTasksCursor,
  type PhoneTaskTone,
  parseCommentsCursor,
  parseTasksCursor,
  phoneCommentTextMax,
  phoneCursorMax,
  phoneDescriptionMax,
  phoneDoneDays,
  phoneLabelMax,
  phoneReplyBodyMax,
  phoneStatusSectionLabels,
  phoneStatusSections,
  phoneTaskTitleMax,
  type StageEntry,
  type Task,
} from '@ted/protocol'
import { stageDisplayName } from '@ted/protocol/stage'
import { defaultStageList, mergeStageLists, stageNameIn } from '@ted/protocol/stage-list'
import { priorities } from '@ted/protocol/task'
import { statusLabel } from '@ted/protocol/task-status'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import { cutChars, fitText, jsonBytes } from './fit.ts'
import { commentRequestKind, type PhoneOutcome } from './requests.ts'

export type PhoneTaskFactory = Pick<Factory, 'id' | 'name' | 'icon' | 'position' | 'createdAt'>

export interface PhoneTaskSource {
  tasks(): Task[]
  task(ref: string): Task | undefined
  factories(): PhoneTaskFactory[]
  comments(taskId: string): Comment[]
  stageEntries(taskId: string): StageEntry[]
  waitingIds(): ReadonlySet<string>
  stages(factoryId: string): Promise<readonly BoardStage[]>
}

export function storeTaskSource(
  store: TedStore,
  stages: PhoneTaskSource['stages'],
): PhoneTaskSource {
  return {
    tasks: () => store.listTasks(),
    task: (ref) => store.getTask(ref),
    factories: () => store.listFactories(),
    comments: (taskId) => store.listComments(taskId),
    stageEntries: (taskId) => store.listStageEntries(taskId),
    waitingIds: () => new Set(store.waiting().map((request) => request.id)),
    stages,
  }
}

export interface PhoneTasks {
  list(group: PhoneTaskGroup, cursor: string | undefined): Promise<PhoneOutcome>
  read(taskId: string): Promise<PhoneOutcome>
  comments(taskId: string, cursor: string | undefined): Promise<PhoneOutcome>
}

const dayMs = 24 * 60 * 60 * 1000
const stageCacheMs = 10_000
const cursorRoom = 'x'.repeat(phoneCursorMax)

function plain(text: string, max: number): string {
  return cutChars(redactSecrets(text), max)
}

function statusSection(task: Task): PhoneStatusSection {
  if (task.stage === 'done') return 'done'
  const status = task.status
  if (!status) return task.stage === 'backlog' ? 'backlog' : 'waiting'
  switch (status.kind) {
    case 'waiting-on-you':
      return status.snoozedUntil === undefined ? 'needs-you' : 'waiting'
    case 'failed':
    case 'partly-merged':
      return 'needs-you'
    case 'working':
    case 'queued':
      return 'working'
    default:
      return 'waiting'
  }
}

function tone(task: Task): PhoneTaskTone {
  if (task.stage === 'done') return 'done'
  switch (task.status?.kind) {
    case undefined:
      return 'none'
    case 'working':
    case 'queued':
      return 'working'
    case 'failed':
    case 'partly-merged':
      return 'failed'
    case 'stopped':
      return 'stopped'
    default:
      return 'waiting'
  }
}

function phoneIcon(icon: FactoryIcon | undefined): PhoneFactoryIcon | undefined {
  switch (icon?.kind) {
    case 'letter':
      return { kind: 'letter', color: icon.color }
    case 'symbol':
      return { kind: 'symbol', symbol: icon.name, color: icon.color }
    case 'emoji':
      return { kind: 'emoji', emoji: icon.emoji }
    default:
      return undefined
  }
}

function factoryOrder(a: PhoneTaskFactory, b: PhoneTaskFactory): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt)
}

function compareKeys(a: PhoneTasksCursor, b: PhoneTasksCursor): number {
  return (
    a.section - b.section ||
    a.priority - b.priority ||
    a.rank - b.rank ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.taskId.localeCompare(b.taskId)
  )
}

function newerFirst(a: PhoneCommentsCursor, b: PhoneCommentsCursor): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})/
const delimiterPattern = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

export function formattedBlocks(markdown: string): number {
  const lines = markdown.split('\n')
  let count = 0
  let fence: string | undefined
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? ''
    if (fence !== undefined) {
      const close = fencePattern.exec(line)?.[1]
      if (
        close !== undefined &&
        close[0] === fence[0] &&
        close.length >= fence.length &&
        line.trim() === close
      ) {
        fence = undefined
      }
      continue
    }
    const open = fencePattern.exec(line)?.[1]
    if (open !== undefined) {
      fence = open
      count++
      continue
    }
    const next = lines[at + 1] ?? ''
    if (line.includes('|') && next.includes('|') && delimiterPattern.test(next)) {
      count++
      at++
      while (at + 1 < lines.length && (lines[at + 1] ?? '').includes('|')) at++
    }
  }
  return count
}

function authorOf(comment: Comment): string {
  if (comment.peer) return comment.peer.sender ? `Peer · ${comment.peer.sender}` : 'Peer message'
  switch (comment.author.kind) {
    case 'human':
      return 'You'
    case 'ted':
      return 'Ted'
    case 'run':
      return 'Task Lead'
  }
}

interface Placed {
  key: PhoneTasksCursor
  row: PhoneTaskRow
}

export function createPhoneTasks(source: PhoneTaskSource, now: () => number): PhoneTasks {
  const stageCache = new Map<string, { at: number; stages: readonly BoardStage[] }>()

  async function stagesOf(factoryId: string): Promise<readonly BoardStage[]> {
    const at = now()
    const cached = stageCache.get(factoryId)
    if (cached && at - cached.at >= 0 && at - cached.at < stageCacheMs) return cached.stages
    let stages: readonly BoardStage[]
    try {
      stages = await source.stages(factoryId)
    } catch {
      stages = defaultStageList
    }
    stageCache.set(factoryId, { at, stages })
    return stages
  }

  async function stageLists(
    factories: readonly PhoneTaskFactory[],
  ): Promise<Map<string, readonly BoardStage[]>> {
    const lists = await Promise.all(
      factories.map(async (factory) => [factory.id, await stagesOf(factory.id)] as const),
    )
    return new Map(lists)
  }

  function doneAt(task: Task): string {
    const entered = source.stageEntries(task.id).findLast((entry) => entry.stage === 'done')
    return entered?.at ?? task.merged?.at ?? task.updatedAt
  }

  function listed(task: Task, cutoff: number): boolean {
    if (task.archived) return false
    return task.stage !== 'done' || Date.parse(doneAt(task)) >= cutoff
  }

  function row(
    task: Task,
    section: string,
    factory: PhoneTaskFactory | undefined,
    stages: readonly BoardStage[],
  ): PhoneTaskRow {
    const icon = phoneIcon(factory?.icon)
    return {
      id: task.id,
      ref: task.displayId,
      title: plain(task.title, phoneTaskTitleMax),
      factory: {
        id: task.factoryId,
        name: plain(factory?.name ?? '', phoneLabelMax),
        ...(icon !== undefined && { icon }),
      },
      stage: { id: task.stage, name: plain(stageNameIn(stages, task.stage), phoneLabelMax) },
      status: task.status ? plain(statusLabel(task.status), phoneLabelMax) : '',
      tone: tone(task),
      priority: task.priority,
      section,
      updatedAt: task.updatedAt,
    }
  }

  function sectionOrder(
    group: PhoneTaskGroup,
    tasks: readonly Task[],
    factories: readonly PhoneTaskFactory[],
    lists: ReadonlyMap<string, readonly BoardStage[]>,
  ): { key: string; label: string }[] {
    if (group === 'status') {
      return phoneStatusSections.map((key) => ({ key, label: phoneStatusSectionLabels[key] }))
    }
    if (group === 'factory') {
      const known = factories.map((factory) => ({
        key: factory.id,
        label: plain(factory.name, phoneLabelMax),
      }))
      const missing = [...new Set(tasks.map((task) => task.factoryId))].flatMap((key) =>
        factories.some((factory) => factory.id === key) ? [] : [{ key, label: 'No Factory' }],
      )
      return [...known, ...missing]
    }
    const all = [...lists.values()]
    const merged = all.length === 0 ? defaultStageList : mergeStageLists(all)
    const known = merged.map((stage) => ({
      key: stage.id,
      label: plain(stage.name ?? stageDisplayName(stage.id), phoneLabelMax),
    }))
    const missing = [...new Set(tasks.map((task) => task.stage))].flatMap((key) =>
      merged.some((stage) => stage.id === key)
        ? []
        : [{ key, label: plain(stageDisplayName(key), phoneLabelMax) }],
    )
    return [...known, ...missing]
  }

  function sectionKey(group: PhoneTaskGroup, task: Task): string {
    if (group === 'factory') return task.factoryId
    if (group === 'stage') return task.stage
    return statusSection(task)
  }

  async function list(group: PhoneTaskGroup, cursor: string | undefined): Promise<PhoneOutcome> {
    const after = cursor === undefined ? undefined : parseTasksCursor(cursor)
    if (cursor !== undefined && after === undefined) return { code: 'bad-request' }
    const at = now()
    const cutoff = at - phoneDoneDays * dayMs
    const tasks = source.tasks().filter((task) => listed(task, cutoff))
    const factories = source.factories().toSorted(factoryOrder)
    const lists = await stageLists(factories)
    const order = sectionOrder(group, tasks, factories, lists)
    const placed: Placed[] = tasks
      .map((task) => {
        const key = sectionKey(group, task)
        const factory = factories.find((each) => each.id === task.factoryId)
        return {
          key: {
            section: order.findIndex((section) => section.key === key),
            priority: priorities.indexOf(task.priority),
            rank: task.rank,
            createdAt: task.createdAt,
            taskId: task.id,
          },
          row: row(task, key, factory, lists.get(task.factoryId) ?? defaultStageList),
        }
      })
      .toSorted((a, b) => compareKeys(a.key, b.key))
    const sections: PhoneTaskSection[] = order.flatMap(({ key, label }) => {
      const count = placed.filter((entry) => entry.row.section === key).length
      return count === 0 ? [] : [{ key, label, count }]
    })
    const remaining = after ? placed.filter((entry) => compareKeys(entry.key, after) > 0) : placed
    const stamp = new Date(at).toISOString()
    const rows: PhoneTaskRow[] = []
    let size = jsonBytes({ rows: [], sections, cursor: cursorRoom, at: stamp })
    let last: PhoneTasksCursor | undefined
    for (const entry of remaining) {
      const next = jsonBytes(entry.row) + (rows.length > 0 ? 1 : 0)
      if (size + next > phoneReplyBodyMax) break
      rows.push(entry.row)
      size += next
      last = entry.key
    }
    const more = rows.length < remaining.length ? last : undefined
    const body: PhoneTasksBody = {
      rows,
      sections,
      ...(more !== undefined && { cursor: encodeTasksCursor(more) }),
      at: stamp,
    }
    return { body }
  }

  function visible(taskId: string): Task | undefined {
    const task = source.task(taskId)
    return task && !task.archived ? task : undefined
  }

  async function read(taskId: string): Promise<PhoneOutcome> {
    const task = visible(taskId)
    if (!task) return { code: 'gone' }
    const factory = source.factories().find((each) => each.id === task.factoryId)
    const lists = await stageLists(factory ? [factory] : [])
    const shown = row(
      task,
      statusSection(task),
      factory,
      lists.get(task.factoryId) ?? defaultStageList,
    )
    const redacted = redactSecrets(task.description)
    const short = cutChars(redacted, phoneDescriptionMax)
    const bare: PhoneTaskDetail = { ...shown, description: '', cut: false }
    const fitted = fitText(short, Math.max(0, phoneReplyBodyMax - jsonBytes({ task: bare })))
    return {
      body: {
        task: { ...shown, description: fitted.text, cut: short !== redacted || fitted.cut },
      },
    }
  }

  function entry(
    comment: Comment,
    stages: readonly BoardStage[],
    waiting: ReadonlySet<string>,
  ): PhoneCommentEntry {
    const redacted = redactSecrets(comment.peer?.text ?? comment.body)
    const text = cutChars(redacted, phoneCommentTextMax)
    const files = comment.attachments ?? []
    const images = files.filter((file) => file.mediaType.startsWith('image/')).length
    const common = {
      id: comment.id,
      author: plain(authorOf(comment), phoneLabelMax),
      createdAt: comment.createdAt,
      text,
      cut: text !== redacted,
      images,
      attachments: files.length - images,
      formattedBlocks: formattedBlocks(redacted),
    }
    if (comment.kind === 'note') return { ...common, kind: 'note' }
    const open = comment.answer === undefined
    return {
      ...common,
      kind: 'request',
      request: {
        kind: commentRequestKind(comment),
        ...(comment.stage !== undefined && {
          stage: {
            id: comment.stage,
            name: plain(stageNameIn(stages, comment.stage), phoneLabelMax),
          },
        }),
        open,
        ...(open && waiting.has(comment.id) && { requestId: comment.id }),
      },
    }
  }

  async function comments(taskId: string, cursor: string | undefined): Promise<PhoneOutcome> {
    const after = cursor === undefined ? undefined : parseCommentsCursor(cursor)
    if (cursor !== undefined && after === undefined) return { code: 'bad-request' }
    const task = visible(taskId)
    if (!task) return { code: 'gone' }
    const factory = source.factories().find((each) => each.id === task.factoryId)
    const lists = await stageLists(factory ? [factory] : [])
    const stages = lists.get(task.factoryId) ?? defaultStageList
    const waiting = source.waitingIds()
    const ordered = source
      .comments(task.id)
      .filter((comment) => !comment.held && (!after || newerFirst(comment, after) > 0))
      .toSorted(newerFirst)
    const entries: PhoneCommentEntry[] = []
    let size = jsonBytes({ entries: [], cursor: cursorRoom })
    for (const comment of ordered) {
      const whole = entry(comment, stages, waiting)
      const comma = entries.length > 0 ? 1 : 0
      let shown = whole
      if (size + jsonBytes(whole) + comma > phoneReplyBodyMax) {
        if (entries.length > 0) break
        const room = phoneReplyBodyMax - size - jsonBytes({ ...whole, text: '' })
        const fitted = fitText(whole.text, Math.max(0, room))
        shown = { ...whole, text: fitted.text, cut: whole.cut || fitted.cut }
      }
      entries.push(shown)
      size += jsonBytes(shown) + comma
    }
    const last = entries.at(-1)
    const body: PhoneTaskCommentsBody = {
      entries,
      ...(last !== undefined &&
        entries.length < ordered.length && {
          cursor: encodeCommentsCursor({ createdAt: last.createdAt, id: last.id }),
        }),
    }
    return { body }
  }

  return { list, read, comments }
}
