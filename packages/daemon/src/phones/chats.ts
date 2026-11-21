import {
  type AutomationCard,
  automationCardHeadline,
  type ChatDiff,
  type ChatItem,
  type ChatRequest,
  type Coordinator,
  type CoordinatorChatSummary,
  type CoordinatorConfirmation,
  type CoordinatorReceipt,
  encodeChatItemsCursor,
  encodeChatsCursor,
  type PhoneChatDetailLine,
  type PhoneChatFactory,
  type PhoneChatItem,
  type PhoneChatItemsBody,
  type PhoneChatKind,
  type PhoneChatRow,
  type PhoneChatsBody,
  type PhoneChatsCursor,
  type PhoneTaskTone,
  type Plan,
  type PlanDetail,
  type PlanRequest,
  type PlanStatus,
  parseChatItemsCursor,
  parseChatsCursor,
  phoneChatLineMax,
  phoneChatTextMax,
  phoneChatTitleMax,
  phoneChatToolTitleMax,
  phoneCursorMax,
  phoneLabelMax,
  phoneReplyBodyMax,
  planRequestLabel,
  type RunChat,
} from '@ted/protocol'
import {
  chatArchivedLabel,
  chatRequestLabels,
  chatWaitingLabel,
  conversationRows,
  coordinatorStatusLabels,
  planStatusLabel,
  planWaiting,
} from '@ted/protocol/agent-chat-view'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { cutChars, type Fitted, fitText, jsonBytes } from './fit.ts'
import type { PhoneOutcome } from './requests.ts'
import { type PhoneTaskFactory, phoneIcon } from './tasks.ts'

export interface PhoneCoordinatorChatRead {
  coordinator: Coordinator
  chat: RunChat
}

export interface PhonePlanRead {
  detail: PlanDetail
  chat: RunChat | undefined
}

export interface PhoneChatSource {
  factories(): PhoneTaskFactory[]
  coordinatorChats(): Promise<CoordinatorChatSummary[]>
  plans(): Promise<Plan[]>
  coordinatorChat(chatId: string): Promise<PhoneCoordinatorChatRead | undefined>
  plan(planId: string): Promise<PhonePlanRead | undefined>
}

export interface PhoneChatServices {
  factories(): PhoneTaskFactory[]
  coordinatorChats(factoryId: string): Promise<CoordinatorChatSummary[]>
  coordinator(chatId: string): Promise<Coordinator>
  coordinatorConversation(chatId: string): Promise<RunChat>
  plans(): Promise<Plan[]>
  plan(planId: string): Promise<PlanDetail>
  runConversation(runId: string): Promise<RunChat>
}

async function unlessMissing<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return undefined
    throw error
  }
}

export function serviceChatSource(services: PhoneChatServices): PhoneChatSource {
  return {
    factories: () => services.factories(),
    async coordinatorChats() {
      const lists = await Promise.all(
        services
          .factories()
          .map(
            async (factory) =>
              (await unlessMissing(() => services.coordinatorChats(factory.id))) ?? [],
          ),
      )
      return lists.flat()
    },
    plans: () => services.plans(),
    async coordinatorChat(chatId) {
      const coordinator = await unlessMissing(() => services.coordinator(chatId))
      if (!coordinator) return undefined
      const chat = await unlessMissing(() => services.coordinatorConversation(chatId))
      return chat && { coordinator, chat }
    },
    async plan(planId) {
      const detail = await unlessMissing(() => services.plan(planId))
      if (!detail) return undefined
      const runId = detail.plan.runId
      const chat =
        runId === undefined ? undefined : await unlessMissing(() => services.runConversation(runId))
      return { detail, chat }
    },
  }
}

export interface PhoneChats {
  list(
    factoryId: string | undefined,
    archived: boolean,
    cursor: string | undefined,
  ): Promise<PhoneOutcome>
  read(kind: PhoneChatKind, chatId: string): Promise<PhoneOutcome>
  items(kind: PhoneChatKind, chatId: string, before: string | undefined): Promise<PhoneOutcome>
  item(kind: PhoneChatKind, chatId: string, itemId: string, offset: number): Promise<PhoneOutcome>
}

interface Entry {
  item: PhoneChatItem
  lines(): PhoneChatDetailLine[]
}

const cursorRoom = 'x'.repeat(phoneCursorMax)

const coordinatorTones: Readonly<Record<Coordinator['status'], PhoneTaskTone>> = {
  ready: 'none',
  queued: 'working',
  working: 'working',
  paused: 'waiting',
  failed: 'failed',
}

const planTones: Readonly<Record<PlanStatus, PhoneTaskTone>> = {
  waiting: 'waiting',
  working: 'working',
  idle: 'none',
  queued: 'working',
  paused: 'waiting',
  failed: 'failed',
  finished: 'done',
  stopped: 'stopped',
}

const endedPlanStatuses: readonly PlanStatus[] = ['finished', 'stopped', 'failed']

function plain(text: string, max: number): string {
  return cutChars(redactSecrets(text), max)
}

function shownText(text: string): Fitted {
  const whole = redactSecrets(text)
  const shown = cutChars(whole, phoneChatTextMax)
  return { text: shown, cut: shown !== whole }
}

function split(kind: PhoneChatDetailLine['kind'], text: string): PhoneChatDetailLine[] {
  const chars = [...text]
  if (chars.length <= phoneChatLineMax) return [{ kind, text }]
  const pieces: PhoneChatDetailLine[] = []
  for (let at = 0; at < chars.length; at += phoneChatLineMax) {
    pieces.push({ kind, text: chars.slice(at, at + phoneChatLineMax).join('') })
  }
  return pieces
}

function textLines(text: string): PhoneChatDetailLine[] {
  return redactSecrets(text)
    .split('\n')
    .flatMap((line) => split('text', line))
}

function heading(text: string): PhoneChatDetailLine[] {
  return split('heading', redactSecrets(text))
}

const diffMarks = { added: '+', removed: '-', context: ' ' } as const

function diffLines(diff: ChatDiff): PhoneChatDetailLine[] {
  return [
    ...heading(`${diff.path} +${diff.additions} −${diff.deletions}`),
    ...diff.lines.flatMap((line) =>
      split(line.kind, `${diffMarks[line.kind]}${redactSecrets(line.text)}`),
    ),
    ...(diff.truncated ? textLines('Longer than shown') : []),
  ]
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

function textEntry(item: PhoneChatItem, ...parts: PhoneChatDetailLine[][]): Entry {
  return { item, lines: () => parts.flat() }
}

function chatItemEntry(item: ChatItem, agent: string, live: boolean): Entry | undefined {
  const at = item.at
  const base = { id: item.id, ...(at !== undefined && { at }) }
  switch (item.kind) {
    case 'instructions':
      return undefined
    case 'prompt':
      return {
        item: { ...base, kind: 'ted', title: 'Prompt', ...shownText(item.text) },
        lines: () => textLines(item.text),
      }
    case 'agent':
      return {
        item: {
          ...base,
          kind: 'agent',
          ...shownText(item.text),
          agent: plain(agent, phoneLabelMax),
        },
        lines: () => textLines(item.text),
      }
    case 'human': {
      const files = item.attachments ?? []
      const images = files.filter((file) => file.mediaType.startsWith('image/'))
      const unsent = item.unsent === true || (item.queued === true && !live)
      return {
        item: {
          ...base,
          kind: 'human',
          ...shownText(item.text),
          images: images.map((file) => plain(file.name, phoneLabelMax)),
          files: files.length - images.length,
          ...(unsent && { unsent: true as const }),
        },
        lines: () => textLines(item.text),
      }
    }
    case 'interrupted':
      return { item: { ...base, kind: 'interrupted' }, lines: () => [] }
    case 'ted':
      return {
        item: {
          ...base,
          kind: 'ted',
          title: plain(item.title, phoneChatToolTitleMax),
          ...shownText(item.text),
        },
        lines: () => [...heading(item.title), ...textLines(item.text)],
      }
    case 'tool': {
      const diffs = item.diffs ?? []
      const output = item.output ?? ''
      const detail = item.detail ?? ''
      const opens = detail !== '' || diffs.length > 0 || output !== ''
      return {
        item: {
          ...base,
          kind: 'tool',
          tool: plain(item.tool, phoneChatToolTitleMax),
          title: plain(item.title, phoneChatToolTitleMax),
          status: item.status,
          ...(diffs.length > 0 && {
            additions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
            deletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
          }),
          ...(output !== '' && { lines: lineCount(output) }),
          ...(opens && { detail: true as const }),
        },
        lines: () => [
          ...(detail === '' ? [] : [...heading('Detail'), ...textLines(detail)]),
          ...diffs.flatMap(diffLines),
          ...(output === '' ? [] : [...heading('Output'), ...textLines(output)]),
        ],
      }
    }
    case 'permission': {
      const ask = item.request.permission?.command ?? item.request.body
      const text = `Permission · ${ask.replace(/\s+/g, ' ').trim()}`
      return textEntry(
        {
          ...base,
          kind: 'card',
          text: plain(text, phoneChatTextMax),
          open: item.request.answer === undefined,
        },
        textLines(text),
      )
    }
    case 'command':
      return {
        item: {
          ...base,
          kind: 'command',
          name: plain(item.name, phoneChatToolTitleMax),
          status: item.status,
          ...(item.exitCode !== undefined && { exitCode: item.exitCode }),
          lines: lineCount(item.output),
          ...(item.output !== '' && { detail: true as const }),
        },
        lines: () => (item.output === '' ? [] : [...heading('Output'), ...textLines(item.output)]),
      }
  }
}

function requestEntry(
  id: string,
  at: string,
  requestKind: Extract<PhoneChatItem, { kind: 'request' }>['requestKind'],
  title: string,
  body: string,
  open: boolean,
): Entry {
  return {
    item: {
      id,
      at,
      kind: 'request',
      requestKind,
      title: plain(title, phoneChatTitleMax),
      ...shownText(body),
      open,
    },
    lines: () => [...heading(title), ...textLines(body)],
  }
}

function chatRequestTitle(request: ChatRequest): string {
  if (request.title !== undefined) return request.title
  if (request.kind === 'round') return `Round ${request.round?.number ?? ''}`.trim()
  if (request.kind === 'proposal') {
    const count = request.proposal?.rows.length ?? 0
    return `Proposal · ${count} ${count === 1 ? 'Task' : 'Tasks'}`
  }
  return chatRequestLabels[request.kind]
}

function chatRequestEntry(request: ChatRequest): Entry {
  return requestEntry(
    request.id,
    request.createdAt,
    chatRequestLabels[request.kind],
    chatRequestTitle(request),
    request.body,
    request.answer === undefined,
  )
}

function planRequestEntry(request: PlanRequest): Entry {
  if (request.kind === 'note') {
    return requestEntry(request.id, request.createdAt, 'Note', 'Note', request.body, false)
  }
  return requestEntry(
    request.id,
    request.createdAt,
    request.kind === 'round' ? 'Round' : 'Proposal',
    request.title ?? planRequestLabel(request),
    request.body,
    request.answer === undefined,
  )
}

function cardEntry(id: string, at: string, text: string, open: boolean): Entry {
  return textEntry(
    { id, at, kind: 'card', text: plain(text, phoneChatTextMax), open },
    textLines(text),
  )
}

function decided(answer: { decision: 'confirm' | 'cancel' } | undefined): string {
  if (!answer) return ''
  return answer.decision === 'cancel' ? ' · Canceled' : ' · Confirmed'
}

function confirmationEntry(confirmation: CoordinatorConfirmation): Entry {
  const first = confirmation.tasks[0]
  const headline =
    confirmation.kind === 'transfer'
      ? `Move ${first?.displayId ?? confirmation.transfer?.tasks[0]?.displayId ?? 'the Task'} to ${
          confirmation.transfer?.factoryName ?? 'another Factory'
        }?`
      : `${confirmation.kind === 'delete' ? 'Delete' : 'Archive'} ${
          confirmation.tasks.length === 1 ? first?.displayId : `${confirmation.tasks.length} Tasks`
        }?`
  return cardEntry(
    confirmation.id,
    confirmation.askedAt,
    `${headline}${decided(confirmation.answer)}`,
    confirmation.answer === undefined,
  )
}

function automationEntry(card: AutomationCard): Entry {
  const answer = card.answer
  const state =
    answer?.refused !== undefined && answer.decision === 'confirm'
      ? ` · Not done: ${answer.refused}`
      : decided(answer)
  return cardEntry(
    card.id,
    card.askedAt,
    `${automationCardHeadline(card)}${state}`,
    answer === undefined,
  )
}

function receiptEntry(receipt: CoordinatorReceipt, coordinator: Coordinator): Entry {
  const task = coordinator.tasks.find((each) => each.id === receipt.taskId)
  return textEntry(
    {
      id: receipt.id,
      at: receipt.at,
      kind: 'action',
      text: plain(receipt.text, phoneChatTextMax),
      ...(task !== undefined && { taskRef: plain(task.displayId, phoneLabelMax) }),
    },
    textLines(receipt.text),
  )
}

interface Extra {
  at: string
  entry: Entry
}

function merged(
  chat: RunChat | undefined,
  extras: readonly Extra[],
  startedAt: string,
  agent: string,
) {
  const live = chat !== undefined && chat.run.state !== 'finished'
  return conversationRows(chat?.items ?? [], extras, chat?.run.startedAt ?? startedAt).flatMap(
    (row) => {
      if ('extra' in row) return [row.extra.entry]
      const entry = chatItemEntry(row.item, agent, live)
      return entry ? [entry] : []
    },
  )
}

function coordinatorEntries({ coordinator, chat }: PhoneCoordinatorChatRead): Entry[] {
  const extras: Extra[] = [
    ...coordinator.confirmations.map((each) => ({
      at: each.askedAt,
      entry: confirmationEntry(each),
    })),
    ...coordinator.receipts.map((each) => ({
      at: each.at,
      entry: receiptEntry(each, coordinator),
    })),
    ...coordinator.automationCards.map((each) => ({
      at: each.askedAt,
      entry: automationEntry(each),
    })),
    ...coordinator.requests.map((each) => ({ at: each.createdAt, entry: chatRequestEntry(each) })),
  ]
  return merged(chat, extras, coordinator.startedAt, coordinator.chatAgent.name)
}

function planEntries({ detail, chat }: PhonePlanRead): Entry[] {
  const { plan } = detail
  const extras: Extra[] = detail.requests.map((each) => ({
    at: each.createdAt,
    entry: planRequestEntry(each),
  }))
  if (plan.finishedAt !== undefined && endedPlanStatuses.includes(plan.status)) {
    const line =
      plan.status === 'finished'
        ? 'Planning Run finished'
        : plan.status === 'failed'
          ? `Planning Run failed${plan.error !== undefined ? `: ${plan.error}` : ''}`
          : 'Planning Run stopped'
    extras.push({
      at: plan.finishedAt,
      entry: {
        item: {
          id: 'ended',
          at: plan.finishedAt,
          kind: 'ted',
          title: plain(line, phoneChatToolTitleMax),
          ...shownText(line),
        },
        lines: () => textLines(line),
      },
    })
  }
  return merged(chat, extras, plan.startedAt ?? plan.createdAt, plan.chatAgent.name)
}

function newestFirst(a: PhoneChatsCursor, b: PhoneChatsCursor): number {
  return (
    b.lastAt.localeCompare(a.lastAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
  )
}

function factoryOrder(a: PhoneTaskFactory, b: PhoneTaskFactory): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt)
}

function fitted(item: PhoneChatItem, room: number): PhoneChatItem {
  if (!('cut' in item)) return item
  const shown = fitText(item.text, Math.max(0, room - jsonBytes({ ...item, text: '' })))
  return { ...item, text: shown.text, cut: item.cut || shown.cut }
}

export function createPhoneChats(source: PhoneChatSource): PhoneChats {
  function factoryView(
    factories: readonly PhoneTaskFactory[],
    factoryId: string,
  ): PhoneChatFactory {
    const factory = factories.find((each) => each.id === factoryId)
    const icon = phoneIcon(factory?.icon)
    return {
      id: factoryId,
      name: plain(factory?.name ?? '', phoneLabelMax),
      ...(icon !== undefined && { icon }),
    }
  }

  function coordinatorRow(
    chat: CoordinatorChatSummary,
    factories: readonly PhoneTaskFactory[],
  ): PhoneChatRow {
    const archived = chat.endedAt !== undefined
    const waiting = !archived && chat.waiting
    const agent = chat.chatAgent.name
    return {
      kind: 'coordinator',
      id: chat.id,
      title: plain(chat.title || `${agent} chat`, phoneChatTitleMax),
      agent: plain(agent, phoneLabelMax),
      factory: factoryView(factories, chat.factoryId),
      status: plain(
        archived
          ? chatArchivedLabel
          : waiting
            ? chatWaitingLabel
            : coordinatorStatusLabels[chat.status],
        phoneLabelMax,
      ),
      tone: archived ? 'stopped' : waiting ? 'waiting' : coordinatorTones[chat.status],
      waiting,
      archived,
      lastAt: chat.lastAt,
    }
  }

  function planRow(plan: Plan, factories: readonly PhoneTaskFactory[]): PhoneChatRow {
    const archived = plan.archivedAt !== undefined
    const agent = plan.chatAgent.name
    return {
      kind: 'plan',
      id: plan.id,
      title: plain(plan.title || `${agent} chat`, phoneChatTitleMax),
      agent: plain(agent, phoneLabelMax),
      factory: factoryView(factories, plan.factoryId),
      status: plain(archived ? chatArchivedLabel : planStatusLabel(plan), phoneLabelMax),
      tone: archived ? 'stopped' : planTones[plan.status],
      waiting: planWaiting(plan),
      archived,
      lastAt: plan.lastAt,
    }
  }

  async function rows(): Promise<{ rows: PhoneChatRow[]; factories: PhoneTaskFactory[] }> {
    const factories = source.factories().toSorted(factoryOrder)
    const [chats, plans] = await Promise.all([source.coordinatorChats(), source.plans()])
    return {
      factories,
      rows: [
        ...chats.map((chat) => coordinatorRow(chat, factories)),
        ...plans.map((plan) => planRow(plan, factories)),
      ],
    }
  }

  async function list(
    factoryId: string | undefined,
    archived: boolean,
    cursor: string | undefined,
  ): Promise<PhoneOutcome> {
    const after = cursor === undefined ? undefined : parseChatsCursor(cursor)
    if (cursor !== undefined && after === undefined) return { code: 'bad-request' }
    const all = await rows()
    const withChats = new Set(all.rows.map((row) => row.factory.id))
    const factories = all.factories
      .filter((factory) => withChats.has(factory.id))
      .map((factory) => factoryView(all.factories, factory.id))
    const scoped = all.rows.filter((row) => factoryId === undefined || row.factory.id === factoryId)
    const archivedCount = scoped.filter((row) => row.archived).length
    const shown = scoped.filter((row) => row.archived === archived).toSorted(newestFirst)
    const remaining = after ? shown.filter((row) => newestFirst(row, after) > 0) : shown
    const page: PhoneChatRow[] = []
    let size = jsonBytes({ factories, rows: [], archivedCount, cursor: cursorRoom })
    for (const row of remaining) {
      const next = jsonBytes(row) + (page.length > 0 ? 1 : 0)
      if (size + next > phoneReplyBodyMax) break
      page.push(row)
      size += next
    }
    const last = page.at(-1)
    const body: PhoneChatsBody = {
      factories,
      rows: page,
      archivedCount,
      ...(last !== undefined &&
        page.length < remaining.length && {
          cursor: encodeChatsCursor({ lastAt: last.lastAt, kind: last.kind, id: last.id }),
        }),
    }
    return { body }
  }

  async function read(kind: PhoneChatKind, chatId: string): Promise<PhoneOutcome> {
    const chat = (await rows()).rows.find((row) => row.kind === kind && row.id === chatId)
    return chat ? { body: { chat } } : { code: 'gone' }
  }

  async function entries(kind: PhoneChatKind, chatId: string): Promise<Entry[] | undefined> {
    if (kind === 'coordinator') {
      const chat = await source.coordinatorChat(chatId)
      return chat && coordinatorEntries(chat)
    }
    const plan = await source.plan(chatId)
    return plan && planEntries(plan)
  }

  async function items(
    kind: PhoneChatKind,
    chatId: string,
    before: string | undefined,
  ): Promise<PhoneOutcome> {
    const at = before === undefined ? undefined : parseChatItemsCursor(before)
    if (before !== undefined && at?.chatKind !== kind) return { code: 'bad-request' }
    const all = await entries(kind, chatId)
    if (!all) return { code: 'gone' }
    const end =
      at === undefined ? all.length : all.findIndex((entry) => entry.item.id === at.itemId)
    if (end === -1) return { code: 'gone' }
    const page: PhoneChatItem[] = []
    let size = jsonBytes({ items: [], cursor: cursorRoom })
    let start = end
    while (start > 0) {
      const whole = all[start - 1]?.item
      if (whole === undefined) break
      const comma = page.length > 0 ? 1 : 0
      let shown = whole
      if (size + jsonBytes(whole) + comma > phoneReplyBodyMax) {
        if (page.length > 0) break
        shown = fitted(whole, phoneReplyBodyMax - size)
      }
      page.unshift(shown)
      size += jsonBytes(shown) + comma
      start--
    }
    const oldest = page[0]
    const body: PhoneChatItemsBody = {
      items: page,
      ...(oldest !== undefined &&
        start > 0 && { cursor: encodeChatItemsCursor({ chatKind: kind, itemId: oldest.id }) }),
    }
    return { body }
  }

  async function item(
    kind: PhoneChatKind,
    chatId: string,
    itemId: string,
    offset: number,
  ): Promise<PhoneOutcome> {
    const all = await entries(kind, chatId)
    if (!all) return { code: 'gone' }
    const entry = all.find((each) => each.item.id === itemId)
    if (!entry) return { code: 'gone' }
    const lines = entry.lines()
    const shown: PhoneChatDetailLine[] = []
    let size = jsonBytes({ lines: [], next: Number.MAX_SAFE_INTEGER })
    for (const line of lines.slice(offset)) {
      const next = jsonBytes(line) + (shown.length > 0 ? 1 : 0)
      if (size + next > phoneReplyBodyMax) break
      shown.push(line)
      size += next
    }
    const end = offset + shown.length
    return { body: { lines: shown, ...(end < lines.length && { next: end }) } }
  }

  return { list, read, items, item }
}
