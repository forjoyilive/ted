import { createHash } from 'node:crypto'
import {
  type BoardStage,
  type Comment,
  encodeCommentsCursor,
  encodeTasksCursor,
  type Factory,
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
  type RunChat,
  type StageEntry,
  type Task,
} from '@ted/protocol'
import { stageDisplayName } from '@ted/protocol/stage'
import { defaultStageList, mergeStageLists, stageNameIn } from '@ted/protocol/stage-list'
import { priorities } from '@ted/protocol/task'
import { openPullRequests } from '@ted/protocol/task-actions'
import { statusLabel } from '@ted/protocol/task-status'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import { chatItemDetail, chatItemEntry, fitted as fitChatItem } from './chats.ts'
import { cutChars, fitImagePrefix, fitText, jsonBytes } from './fit.ts'
import { phoneFactoryIcons } from './icons.ts'
import { isImage, phoneImageList } from './images.ts'
import { commentRequestKind, type PhoneOutcome } from './requests.ts'
import { phoneTaskActions } from './task-actions.ts'

export type PhoneTaskFactory = Pick<Factory, 'id' | 'name' | 'icon' | 'position' | 'createdAt'>

export interface PhoneTaskSource {
  tasks(): Task[]
  task(ref: string): Task | undefined
  factories(): PhoneTaskFactory[]
  comments(taskId: string): Comment[]
  stageEntries(taskId: string): StageEntry[]
  waitingIds(): ReadonlySet<string>
  stages(factoryId: string): Promise<readonly BoardStage[]>
  descendants(taskId: string): string[]
  leadChats(taskId: string): Promise<RunChat[]>
}

export function storeTaskSource(
  store: TedStore,
  stages: PhoneTaskSource['stages'],
  descendants: PhoneTaskSource['descendants'],
  leadChats: PhoneTaskSource['leadChats'],
): PhoneTaskSource {
  return {
    tasks: () => store.listTasks(),
    task: (ref) => store.getTask(ref),
    factories: () => store.listFactories(),
    comments: (taskId) => store.listComments(taskId),
    stageEntries: (taskId) => store.listStageEntries(taskId),
    waitingIds: () => new Set(store.waiting().map((request) => request.id)),
    stages,
    descendants,
    leadChats,
  }
}

export interface PhoneTasks {
  list(group: PhoneTaskGroup, cursor: string | undefined): Promise<PhoneOutcome>
  read(taskId: string, waitingForBlockers?: boolean): Promise<PhoneOutcome>
  comments(taskId: string, cursor: string | undefined): Promise<PhoneOutcome>
  conversation(taskId: string, cursor: string | undefined): Promise<PhoneOutcome>
  conversationItem(taskId: string, itemId: string, offset: number): Promise<PhoneOutcome>
  revision(taskId: string): string | undefined
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

const sectionLabelSteps = [100, 50, 20, 0]

export function fitSections(sections: readonly PhoneTaskSection[]): PhoneTaskSection[] {
  const room = phoneReplyBodyMax / 2
  if (jsonBytes(sections) <= room) return [...sections]
  for (const max of sectionLabelSteps) {
    const cut = sections.map((section) => ({ ...section, label: cutChars(section.label, max) }))
    if (jsonBytes(cut) <= room) return cut
  }
  const kept: PhoneTaskSection[] = []
  let size = jsonBytes([])
  for (const section of sections) {
    const bare = { ...section, label: '' }
    const next = jsonBytes(bare) + (kept.length > 0 ? 1 : 0)
    if (size + next > room) break
    kept.push(bare)
    size += next
  }
  return kept
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
    icon: PhoneFactoryIcon | undefined,
    stages: readonly BoardStage[],
  ): PhoneTaskRow {
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
      actions: phoneTaskActions(task),
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
    const icons = phoneFactoryIcons(factories)
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
          row: row(
            task,
            key,
            factory,
            icons.get(task.factoryId),
            lists.get(task.factoryId) ?? defaultStageList,
          ),
        }
      })
      .toSorted((a, b) => compareKeys(a.key, b.key))
    const sections = fitSections(
      order.flatMap(({ key, label }) => {
        const count = placed.filter((entry) => entry.row.section === key).length
        return count === 0 ? [] : [{ key, label, count }]
      }),
    )
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

  async function read(taskId: string, waitingForBlockers = false): Promise<PhoneOutcome> {
    const task = visible(taskId)
    if (!task) return { code: 'gone' }
    const factory = source.factories().find((each) => each.id === task.factoryId)
    const lists = await stageLists(factory ? [factory] : [])
    const shown = row(
      task,
      statusSection(task),
      factory,
      phoneFactoryIcons(source.factories()).get(task.factoryId),
      lists.get(task.factoryId) ?? defaultStageList,
    )
    const descendants = source.descendants(task.id)
    const redacted = redactSecrets(task.description)
    const short = cutChars(redacted, phoneDescriptionMax)
    const bare: PhoneTaskDetail = {
      ...shown,
      description: '',
      cut: false,
      childTasks: descendants.length,
      openPullRequests: openPullRequests(task).length,
      hierarchyRevision: familyRevision(task, descendants),
    }
    const body = { task: bare, ...(waitingForBlockers && { waitingForBlockers }) }
    const fitted = fitText(short, Math.max(0, phoneReplyBodyMax - jsonBytes(body)))
    return {
      body: {
        ...body,
        task: { ...bare, description: fitted.text, cut: short !== redacted || fitted.cut },
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
    const images = files.filter(isImage).length
    const imageList = phoneImageList(comment.id, files).images
    const common = {
      id: comment.id,
      author: plain(authorOf(comment), phoneLabelMax),
      createdAt: comment.createdAt,
      text,
      cut: text !== redacted,
      images,
      ...(imageList.length > 0 && { imageList }),
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

  async function leadEntries(taskId: string, comments: readonly Comment[]) {
    const chats = await source.leadChats(taskId)
    const commentIds = new Set(comments.map((comment) => comment.id))
    return chats.flatMap(({ run, items }) =>
      items.flatMap((item) => {
        if (item.kind === 'permission' && commentIds.has(item.request.id)) return []
        const projected = chatItemEntry(item, run.name, run.state !== 'finished')
        if (!projected) return []
        const id = `run:${createHash('sha256')
          .update(JSON.stringify([run.id, item.id]))
          .digest('base64url')}`
        return [
          {
            detail: projected,
            row: {
              id,
              createdAt: item.at ?? run.startedAt,
              author: '',
              kind: 'note' as const,
              text: '',
              cut: false,
              images: 0,
              attachments: 0,
              formattedBlocks: 0,
              chatItem: projected.item,
            },
          },
        ]
      }),
    )
  }

  async function conversationItem(
    taskId: string,
    itemId: string,
    offset: number,
  ): Promise<PhoneOutcome> {
    const task = visible(taskId)
    if (!task) return { code: 'gone' }
    const comments = source.comments(task.id)
    const found = (await leadEntries(task.id, comments)).find(
      ({ row }) => row.id === itemId,
    )?.detail
    return found ? chatItemDetail(found, offset) : { code: 'gone' }
  }

  async function comments(
    taskId: string,
    cursor: string | undefined,
    includeConversation = false,
  ): Promise<PhoneOutcome> {
    const after = cursor === undefined ? undefined : parseCommentsCursor(cursor)
    if (cursor !== undefined && after === undefined) return { code: 'bad-request' }
    const task = visible(taskId)
    if (!task) return { code: 'gone' }
    const factory = source.factories().find((each) => each.id === task.factoryId)
    const lists = await stageLists(factory ? [factory] : [])
    const stages = lists.get(task.factoryId) ?? defaultStageList
    const waiting = source.waitingIds()
    const comments = source.comments(task.id)
    const conversation = includeConversation ? await leadEntries(task.id, comments) : []
    const ordered = [
      ...comments.filter((comment) => !comment.held),
      ...conversation.map(({ row }) => row),
    ]
      .filter((row) => !after || newerFirst(row, after) > 0)
      .toSorted(newerFirst)
    const entries: PhoneCommentEntry[] = []
    const emptyPageSize = jsonBytes({ entries: [] })
    let size = emptyPageSize
    for (const comment of ordered) {
      const whole: PhoneCommentEntry =
        'chatItem' in comment ? comment : entry(comment, stages, waiting)
      const comma = entries.length > 0 ? 1 : 0
      const cursorBytes =
        entries.length + 1 < ordered.length
          ? jsonBytes({ entries: [], cursor: encodeCommentsCursor(comment) }) - emptyPageSize
          : 0
      const room = phoneReplyBodyMax - size - comma - cursorBytes
      let shown = whole
      if (jsonBytes(whole) > room) {
        if (entries.length > 0) break
        if (whole.chatItem) {
          const { chatItem, ...row } = whole
          shown = {
            ...row,
            chatItem: fitChatItem(chatItem, room - jsonBytes({ ...row, chatItem: null }) + 4),
          }
          entries.push(shown)
          break
        }
        const { imageList = [], ...withoutImages } = whole
        const bare = {
          ...withoutImages,
          text: '',
          ...(whole.images > 0 && { moreImages: whole.images }),
        }
        const fitted = fitText(whole.text, Math.max(0, room - jsonBytes(bare)))
        const text = { ...withoutImages, text: fitted.text, cut: whole.cut || fitted.cut }
        shown = fitImagePrefix(imageList.length, room, (count) => ({
          ...text,
          ...(count > 0 && { imageList: imageList.slice(0, count) }),
          ...(count < whole.images && { moreImages: whole.images - count }),
        }))
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

  function familyRevision(task: Task, descendants: readonly string[]): string {
    const facts = (member: Task | undefined, id: string) =>
      member
        ? [
            member.id,
            member.parentId,
            member.childIds,
            member.stage,
            member.archived,
            member.blockedBy,
            member.status,
            member.runs,
            member.updatedAt,
            member.merged,
            openPullRequests(member).map(({ repo, pr }) => [repo.name, pr.number]),
          ]
        : [id]
    const family = [task.id, ...descendants].map((id, n) =>
      facts(n === 0 ? task : source.task(id), id),
    )
    return createHash('sha256').update(JSON.stringify(family)).digest('hex')
  }

  function revision(taskId: string): string | undefined {
    const task = visible(taskId)
    return task ? familyRevision(task, source.descendants(task.id)) : undefined
  }

  return {
    list,
    read,
    comments,
    conversation: (taskId, cursor) => comments(taskId, cursor, true),
    conversationItem,
    revision,
  }
}
