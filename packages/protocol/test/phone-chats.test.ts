import { expect, test } from 'vitest'
import {
  encodeChatItemsCursor,
  encodeChatsCursor,
  type PhoneChatAgentsBody,
  type PhoneChatBody,
  type PhoneChatCreatedBody,
  type PhoneChatItem,
  type PhoneChatItemBody,
  type PhoneChatItemsBody,
  type PhoneChatRow,
  type PhoneChatsBody,
  parseChatItemsCursor,
  parseChatsCursor,
  parsePhoneChatAgentsBody,
  parsePhoneChatBody,
  parsePhoneChatCreatedBody,
  parsePhoneChatItemBody,
  parsePhoneChatItemsBody,
  parsePhoneChatMessageBody,
  parsePhoneChatStoppedBody,
  parsePhoneChatsBody,
} from '../src/phone-chats.ts'
import { encodeCommentsCursor, encodeTasksCursor, phoneCursorMax } from '../src/phone-tasks.ts'
import { parsePhoneRequest, phoneRouteNames, toBase64Url } from '../src/phones.ts'

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const header = { protocol: 3, id: toBase64Url(new Uint8Array(16)), at: 1, type: 'request' }

const row = {
  kind: 'coordinator',
  id: 'chat-1',
  title: 'Clean up the stale Validate failures',
  agent: 'Coordinator',
  factory: { id: 'f1', name: 'Ted', icon: { kind: 'emoji', emoji: '🛠️' } },
  status: 'Working',
  tone: 'working',
  waiting: false,
  archived: false,
  lastAt: '2026-11-20T09:00:00.000Z',
  send: 'live',
  canStop: true,
} satisfies PhoneChatRow

test('the four Chats routes are phone routes', () => {
  expect(phoneRouteNames).toEqual(
    expect.arrayContaining(['chats', 'chat', 'chat-items', 'chat-item']),
  )
})

test('parsePhoneRequest reads every field of the Chats routes', () => {
  const list = {
    ...header,
    route: 'chats',
    factoryId: 'f1',
    archived: true,
    cursor: 'abc',
  }
  expect(parsePhoneRequest(list)).toEqual(list)
  expect(parsePhoneRequest({ ...header, route: 'chats' })).toEqual({
    ...header,
    route: 'chats',
    archived: false,
  })
  const chat = { ...header, route: 'chat', chatKind: 'plan', chatId: 'plan-1' }
  expect(parsePhoneRequest(chat)).toEqual(chat)
  const items = {
    ...header,
    route: 'chat-items',
    chatKind: 'coordinator',
    chatId: 'c',
    before: 'b',
  }
  expect(parsePhoneRequest(items)).toEqual(items)
  const { before: _, ...newest } = items
  expect(parsePhoneRequest(newest)).toEqual(newest)
  const item = {
    ...header,
    route: 'chat-item',
    chatKind: 'plan',
    chatId: 'plan-1',
    itemId: 'tool-1',
    offset: 120,
  }
  expect(parsePhoneRequest(item)).toEqual(item)
  const { offset: __, ...first } = item
  expect(parsePhoneRequest(first)).toEqual(first)
})

test('parsePhoneRequest refuses bad Chats fields', () => {
  const list = { ...header, route: 'chats' }
  expect(() => parsePhoneRequest({ ...list, factoryId: '' })).toThrow(/factoryId/)
  expect(() => parsePhoneRequest({ ...list, factoryId: 'x'.repeat(201) })).toThrow(/factoryId/)
  expect(() => parsePhoneRequest({ ...list, archived: 'yes' })).toThrow(/archived/)
  expect(() => parsePhoneRequest({ ...list, cursor: '' })).toThrow(/cursor/)
  const chat = { ...header, route: 'chat', chatKind: 'coordinator', chatId: 'c' }
  expect(() => parsePhoneRequest({ ...chat, chatKind: 'task' })).toThrow(/chatKind/)
  expect(() => parsePhoneRequest({ ...chat, chatKind: undefined })).toThrow(/chatKind/)
  expect(() => parsePhoneRequest({ ...chat, chatId: '' })).toThrow(/chatId/)
  expect(() => parsePhoneRequest({ ...chat, chatId: 'x'.repeat(201) })).toThrow(/chatId/)
  const items = { ...chat, route: 'chat-items' }
  expect(() => parsePhoneRequest({ ...items, before: '' })).toThrow(/before/)
  expect(() => parsePhoneRequest({ ...items, before: 'x'.repeat(phoneCursorMax + 1) })).toThrow(
    /before/,
  )
  const item = { ...chat, route: 'chat-item', itemId: 'i' }
  expect(() => parsePhoneRequest({ ...item, itemId: undefined })).toThrow(/itemId/)
  expect(() => parsePhoneRequest({ ...item, itemId: 'x'.repeat(201) })).toThrow(/itemId/)
  expect(() => parsePhoneRequest({ ...item, offset: -1 })).toThrow(/offset/)
  expect(() => parsePhoneRequest({ ...item, offset: 1.5 })).toThrow(/offset/)
  expect(() => parsePhoneRequest({ ...item, offset: '3' })).toThrow(/offset/)
})

test('chat cursors round-trip and refuse cursors made for other routes', () => {
  const place = { lastAt: '2026-11-20T09:00:00.000Z', kind: 'plan' as const, id: 'plan-1' }
  const list = encodeChatsCursor(place)
  expect(list).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(list.length).toBeLessThanOrEqual(phoneCursorMax)
  expect(parseChatsCursor(list)).toEqual(place)
  const items = encodeChatItemsCursor({ chatKind: 'coordinator', itemId: 'run:tool-1' })
  expect(parseChatItemsCursor(items)).toEqual({ chatKind: 'coordinator', itemId: 'run:tool-1' })
  expect(parseChatsCursor(items)).toBeUndefined()
  expect(parseChatItemsCursor(list)).toBeUndefined()
  const tasks = encodeTasksCursor({ section: 0, priority: 0, rank: 1, createdAt: 'a', taskId: 't' })
  const comments = encodeCommentsCursor({ createdAt: 'chat-items', id: 'x' })
  for (const other of [tasks, comments, 'not!base64', `${list}=`, '']) {
    expect(parseChatsCursor(other)).toBeUndefined()
    expect(parseChatItemsCursor(other)).toBeUndefined()
  }
})

test('parsePhoneChatsBody and parsePhoneChatBody read every field', () => {
  const body: PhoneChatsBody = {
    factories: [row.factory, { id: 'f2', name: 'Notebook' }],
    rows: [
      row,
      {
        ...row,
        kind: 'plan',
        id: 'plan-1',
        factory: { id: 'f2', name: 'Notebook' },
        status: 'Archived',
        tone: 'stopped',
        archived: true,
        send: 'off',
        offReason: 'This chat is archived.',
        canStop: false,
      },
    ],
    archivedCount: 3,
    cursor: 'abc',
  }
  expect(parsePhoneChatsBody(roundTrip(body))).toEqual(body)
  const { cursor: _, ...last } = body
  expect(parsePhoneChatsBody(roundTrip(last))).toEqual(last)
  expect(() => parsePhoneChatsBody({ ...body, archivedCount: -1 })).toThrow(/archivedCount/)
  expect(() => parsePhoneChatsBody({ ...body, rows: [{ ...row, kind: 'task' }] })).toThrow(/kind/)
  const one: PhoneChatBody = { chat: { ...row, waiting: true, tone: 'waiting' } }
  expect(parsePhoneChatBody(roundTrip(one))).toEqual(one)
  expect(() => parsePhoneChatBody({ chat: { ...row, waiting: 'no' } })).toThrow(/waiting/)
  expect(() => parsePhoneChatBody({ chat: { ...row, send: 'open' } })).toThrow(/send/)
  expect(() => parsePhoneChatBody({ chat: { ...row, canStop: undefined } })).toThrow(/canStop/)
})

const createId = toBase64Url(new Uint8Array(16).fill(7))

test('the four chat write routes are phone routes', () => {
  expect(phoneRouteNames).toEqual(
    expect.arrayContaining(['chat-message', 'chat-stop', 'chat-agents', 'chat-create']),
  )
})

test('parsePhoneRequest reads every field of the chat write routes', () => {
  const message = {
    ...header,
    route: 'chat-message',
    chatKind: 'plan',
    chatId: 'plan-1',
    text: 'Keep the list short',
    createId,
  }
  expect(parsePhoneRequest(message)).toEqual(message)
  const stop = { ...header, route: 'chat-stop', chatKind: 'coordinator', chatId: 'c' }
  expect(parsePhoneRequest(stop)).toEqual(stop)
  const agents = { ...header, route: 'chat-agents', factory: 'TED' }
  expect(parsePhoneRequest(agents)).toEqual(agents)
  const create = {
    ...header,
    route: 'chat-create',
    factory: 'TED',
    agentId: 'planner',
    text: 'Plan the phone chat field',
    createId,
  }
  expect(parsePhoneRequest(create)).toEqual(create)
})

test('parsePhoneRequest refuses bad chat write fields', () => {
  const message = {
    ...header,
    route: 'chat-message',
    chatKind: 'coordinator',
    chatId: 'c',
    text: 'Hi',
    createId,
  }
  expect(() => parsePhoneRequest({ ...message, text: '   ' })).toThrow(/text/)
  expect(() => parsePhoneRequest({ ...message, text: 'x'.repeat(10_001) })).toThrow(/text/)
  expect(() => parsePhoneRequest({ ...message, text: undefined })).toThrow(/text/)
  expect(() => parsePhoneRequest({ ...message, createId: 'short' })).toThrow(/createId/)
  expect(() => parsePhoneRequest({ ...message, createId: undefined })).toThrow(/createId/)
  expect(() => parsePhoneRequest({ ...message, chatKind: 'task' })).toThrow(/chatKind/)
  expect(() => parsePhoneRequest({ ...message, chatId: '' })).toThrow(/chatId/)
  const stop = { ...header, route: 'chat-stop', chatKind: 'plan', chatId: 'p' }
  expect(() => parsePhoneRequest({ ...stop, chatId: undefined })).toThrow(/chatId/)
  expect(() => parsePhoneRequest({ ...header, route: 'chat-agents' })).toThrow(/factory/)
  expect(() =>
    parsePhoneRequest({ ...header, route: 'chat-agents', factory: 'x'.repeat(201) }),
  ).toThrow(/factory/)
  const create = {
    ...header,
    route: 'chat-create',
    factory: 'TED',
    agentId: 'coordinator',
    text: 'Hi',
    createId,
  }
  expect(() => parsePhoneRequest({ ...create, agentId: '' })).toThrow(/agentId/)
  expect(() => parsePhoneRequest({ ...create, factory: '' })).toThrow(/factory/)
  expect(() => parsePhoneRequest({ ...create, text: '' })).toThrow(/text/)
  expect(() => parsePhoneRequest({ ...create, createId: 'x' })).toThrow(/createId/)
})

test('the chat write reply bodies read every field', () => {
  expect(parsePhoneChatMessageBody({ queued: true })).toEqual({ queued: true })
  expect(parsePhoneChatMessageBody({ queued: false })).toEqual({ queued: false })
  expect(() => parsePhoneChatMessageBody({})).toThrow(/queued/)
  expect(parsePhoneChatStoppedBody({ stopped: true })).toEqual({ stopped: true })
  expect(() => parsePhoneChatStoppedBody({ stopped: false })).toThrow(/stopped/)
  const agents: PhoneChatAgentsBody = {
    agents: [
      { id: 'coordinator', name: 'Coordinator', description: 'Acts on Tasks.', planner: false },
      { id: 'planner', name: 'Planner', description: 'Plans.', planner: true },
    ],
  }
  expect(parsePhoneChatAgentsBody(roundTrip(agents))).toEqual(agents)
  expect(() =>
    parsePhoneChatAgentsBody({ agents: [{ id: 'a', name: 'A', description: '' }] }),
  ).toThrow(/planner/)
  const created: PhoneChatCreatedBody = { chat: { kind: 'plan', id: 'plan-1' } }
  expect(parsePhoneChatCreatedBody(roundTrip(created))).toEqual(created)
  expect(() => parsePhoneChatCreatedBody({ chat: { kind: 'task', id: 'x' } })).toThrow(/kind/)
})

test('parsePhoneChatItemsBody reads every item kind and field', () => {
  const at = '2026-11-20T09:00:00.000Z'
  const items: PhoneChatItem[] = [
    {
      id: 'h',
      at,
      kind: 'human',
      text: 'Hi',
      cut: false,
      images: ['shot.png'],
      files: 1,
      unsent: true,
    },
    { id: 'q', at, kind: 'human', text: 'Next', cut: false, images: [], files: 0, queued: true },
    { id: 'a', at, kind: 'agent', text: 'Hello', cut: true, agent: 'Coordinator' },
    { id: 't', kind: 'ted', title: 'New Run', text: 'The earlier Run ended', cut: false },
    { id: 'i', at, kind: 'interrupted' },
    {
      id: 'tool',
      at,
      kind: 'tool',
      tool: 'Edit',
      title: 'src/a.ts',
      status: 'done',
      additions: 3,
      deletions: 1,
      lines: 12,
      detail: true,
    },
    { id: 'tool2', kind: 'tool', tool: 'Bash', title: 'ls', status: 'running' },
    {
      id: 'cmd',
      at,
      kind: 'command',
      name: 'test',
      status: 'failed',
      exitCode: 1,
      lines: 4,
      detail: true,
    },
    { id: 'cmd2', at, kind: 'command', name: 'lint', status: 'running', lines: 0 },
    { id: 'act', at, kind: 'action', text: 'Started TED-788', taskRef: 'TED-788' },
    { id: 'act2', at, kind: 'action', text: 'Moved it' },
    {
      id: 'req',
      at,
      kind: 'request',
      requestKind: 'Agent draft',
      title: 'Reviewer',
      text: 'Make a reviewer',
      cut: false,
      open: true,
    },
    { id: 'card', at, kind: 'card', text: 'Archive TED-1?', open: false },
  ]
  const body: PhoneChatItemsBody = { items, cursor: 'c' }
  expect(parsePhoneChatItemsBody(roundTrip(body))).toEqual(body)
  expect(parsePhoneChatItemsBody({ items: [] })).toEqual({ items: [] })
  expect(() => parsePhoneChatItemsBody({ items: [{ id: 'x', kind: 'prompt' }] })).toThrow(/kind/)
  expect(() => parsePhoneChatItemsBody({ items: [{ ...items[0], unsent: false }] })).toThrow(
    /unsent/,
  )
  expect(() => parsePhoneChatItemsBody({ items: [{ ...items[1], queued: false }] })).toThrow(
    /queued/,
  )
  expect(() => parsePhoneChatItemsBody({ items: [{ ...items[5], status: 'passed' }] })).toThrow(
    /status/,
  )
  expect(() =>
    parsePhoneChatItemsBody({ items: [{ ...items[11], requestKind: 'question' }] }),
  ).toThrow(/requestKind/)
  expect(() => parsePhoneChatItemsBody({ items: [{ ...items[7], lines: -1 }] })).toThrow(/lines/)
})

test('parsePhoneChatItemBody reads detail lines and next', () => {
  const body: PhoneChatItemBody = {
    lines: [
      { kind: 'heading', text: 'src/a.ts +1 −1' },
      { kind: 'added', text: '+     timeout: 600' },
      { kind: 'removed', text: '-     timeout: 60' },
      { kind: 'context', text: '  retries: 3' },
      { kind: 'text', text: 'done' },
    ],
    next: 240,
  }
  expect(parsePhoneChatItemBody(roundTrip(body))).toEqual(body)
  expect(parsePhoneChatItemBody({ lines: [] })).toEqual({ lines: [] })
  expect(() => parsePhoneChatItemBody({ lines: [{ kind: 'diff', text: '' }] })).toThrow(/kind/)
  expect(() => parsePhoneChatItemBody({ lines: [], next: -1 })).toThrow(/next/)
})
