import { expect, test } from 'vitest'
import type { Json } from '../src/parse.ts'
import {
  encodeCommentsCursor,
  encodeTasksCursor,
  type PhoneTaskBody,
  type PhoneTaskCommentsBody,
  type PhoneTasksBody,
  parseCommentsCursor,
  parsePhoneTaskBody,
  parsePhoneTaskCommentsBody,
  parsePhoneTasksBody,
  parseTasksCursor,
  phoneCursorMax,
} from '../src/phone-tasks.ts'
import { parsePhoneRequest, toBase64Url } from '../src/phones.ts'

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const row = {
  id: 'task-1',
  ref: 'TED-786',
  title: 'Phone Task routes',
  factory: { id: 'f1', name: 'Ted', icon: { kind: 'symbol', symbol: 'code', color: 'blue' } },
  stage: { id: 'work', name: 'Work' },
  status: 'Queued · 3rd',
  tone: 'working',
  priority: 'high',
  section: 'working',
  updatedAt: '2026-11-20T09:00:00.000Z',
} as const

test('parsePhoneTasksBody reads every field, with and without a cursor and an icon', () => {
  const body: PhoneTasksBody = {
    rows: [
      row,
      {
        ...row,
        id: 'task-2',
        ref: 'TED-12',
        factory: { id: 'f2', name: 'Notebook', icon: { kind: 'letter', color: 'teal' } },
        tone: 'none',
        status: '',
        section: 'backlog',
        priority: 'none',
      },
      {
        ...row,
        id: 'task-3',
        factory: { id: 'f3', name: 'Site', icon: { kind: 'emoji', emoji: '🌱' } },
      },
      { ...row, id: 'task-4', factory: { id: 'f4', name: 'Plain' } },
    ],
    sections: [
      { key: 'working', label: 'Working', count: 3 },
      { key: 'backlog', label: 'Backlog', count: 1 },
    ],
    cursor: 'abc',
    at: '2026-11-20T09:01:00.000Z',
  }
  expect(parsePhoneTasksBody(roundTrip(body))).toEqual(body)
  const { cursor: _, ...last } = body
  expect(parsePhoneTasksBody(roundTrip(last))).toEqual(last)
  expect(() => parsePhoneTasksBody({ ...body, rows: [{ ...row, tone: 'loud' }] })).toThrow(/tone/)
  expect(() =>
    parsePhoneTasksBody({ ...body, sections: [{ key: 'x', label: 'X', count: -1 }] }),
  ).toThrow(/count/)
  expect(() =>
    parsePhoneTasksBody({
      ...body,
      rows: [{ ...row, factory: { ...row.factory, icon: { kind: 'image', dataUrl: 'x' } } }],
    }),
  ).toThrow(/kind/)
})

test('parsePhoneTaskBody reads the row fields, the description and cut', () => {
  const body: PhoneTaskBody = {
    task: { ...row, description: '# Goal\n\nBuild it.', cut: true },
  }
  expect(parsePhoneTaskBody(roundTrip(body))).toEqual(body)
  expect(() => parsePhoneTaskBody({ task: { ...row, cut: false } })).toThrow(/description/)
})

test('parsePhoneTaskCommentsBody reads notes and open and answered requests', () => {
  const body: PhoneTaskCommentsBody = {
    entries: [
      {
        id: 'c3',
        author: 'Task Lead',
        kind: 'request',
        createdAt: '2026-11-20T09:00:00.000Z',
        text: 'Which repo?',
        cut: false,
        images: 0,
        attachments: 0,
        formattedBlocks: 0,
        request: {
          kind: 'question',
          stage: { id: 'clarify', name: 'Clarify' },
          open: true,
          requestId: 'c3',
        },
      },
      {
        id: 'c2',
        author: 'Ted',
        kind: 'request',
        createdAt: '2026-11-20T08:00:00.000Z',
        text: 'Sign off?',
        cut: false,
        images: 0,
        attachments: 0,
        formattedBlocks: 0,
        request: { kind: 'signoff', open: false },
      },
      {
        id: 'c1',
        author: 'You',
        kind: 'note',
        createdAt: '2026-11-20T07:00:00.000Z',
        text: 'A long note',
        cut: true,
        images: 2,
        attachments: 1,
        formattedBlocks: 3,
      },
    ],
    cursor: 'older',
  }
  expect(parsePhoneTaskCommentsBody(roundTrip(body))).toEqual(body)
  const { cursor: _, ...last } = body
  expect(parsePhoneTaskCommentsBody(roundTrip(last))).toEqual(last)
  const [open, answered, note] = body.entries
  expect(() =>
    parsePhoneTaskCommentsBody({
      entries: [{ ...answered, request: { kind: 'signoff', open: false, requestId: 'c2' } }],
    }),
  ).toThrow(/requestId/)
  expect(() =>
    parsePhoneTaskCommentsBody({ entries: [{ ...note, request: open?.request }] }),
  ).toThrow(/request/)
  expect(() => parsePhoneTaskCommentsBody({ entries: [{ ...open, request: undefined }] })).toThrow(
    /request/,
  )
})

test('cursors round-trip and refuse anything that isn’t exactly what the Mac made', () => {
  const tasks = {
    section: 2,
    priority: 1,
    rank: -3.5,
    createdAt: '2026-11-20T09:00:00.000Z',
    taskId: 'task-1',
  }
  expect(parseTasksCursor(encodeTasksCursor(tasks))).toEqual(tasks)
  const comments = { createdAt: '2026-11-20T09:00:00.000Z', id: 'c1' }
  expect(parseCommentsCursor(encodeCommentsCursor(comments))).toEqual(comments)
  const encode = (value: Json) => Buffer.from(JSON.stringify(value)).toString('base64url')
  for (const bad of [
    '',
    'not base64!',
    `${encodeTasksCursor(tasks)}=`,
    encode({ section: 1 }),
    encode([1, 1, 1, '2026', 't', 'extra']),
    encode([-1, 1, 1, '2026', 't']),
    encode([1.5, 1, 1, '2026', 't']),
    encode([1, 9, 1, '2026', 't']),
    encode([1, 1, '1', '2026', 't']),
    encode([1, 1, 1, '', 't']),
    encode([1, 1, 1, '2026', 'x'.repeat(201)]),
    'A'.repeat(phoneCursorMax + 1),
  ]) {
    expect(parseTasksCursor(bad), bad).toBeUndefined()
  }
  expect(parseTasksCursor(encodeCommentsCursor(comments))).toBeUndefined()
  expect(parseCommentsCursor(encodeTasksCursor(tasks))).toBeUndefined()
  expect(parseCommentsCursor(encode(['2026', 7]))).toBeUndefined()
})

test('parsePhoneRequest reads taskId, group and cursor on the Task routes', () => {
  const header = { protocol: 3, id: toBase64Url(new Uint8Array(16)), at: 1 }
  const list = { ...header, type: 'request', route: 'tasks', group: 'factory', cursor: 'abc' }
  expect(parsePhoneRequest(list)).toEqual(list)
  expect(parsePhoneRequest({ ...header, type: 'request', route: 'tasks' })).toEqual({
    ...header,
    type: 'request',
    route: 'tasks',
    group: 'status',
  })
  expect(() => parsePhoneRequest({ ...list, group: 'priority' })).toThrow(/group/)
  expect(() => parsePhoneRequest({ ...list, cursor: '' })).toThrow(/cursor/)
  expect(() => parsePhoneRequest({ ...list, cursor: 'x'.repeat(phoneCursorMax + 1) })).toThrow(
    /cursor/,
  )
  const one = { ...header, type: 'request', route: 'task', taskId: 'TED-786' }
  expect(parsePhoneRequest(one)).toEqual(one)
  expect(() => parsePhoneRequest({ ...one, taskId: '' })).toThrow(/taskId/)
  expect(() => parsePhoneRequest({ ...one, taskId: 'x'.repeat(201) })).toThrow(/taskId/)
  expect(() => parsePhoneRequest({ ...one, taskId: undefined })).toThrow(/taskId/)
  const thread = { ...header, type: 'request', route: 'task-comments', taskId: 't1', cursor: 'c' }
  expect(parsePhoneRequest(thread)).toEqual(thread)
  const { cursor: _, ...first } = thread
  expect(parsePhoneRequest(first)).toEqual(first)
  expect(() => parsePhoneRequest({ ...thread, cursor: 4 })).toThrow(/cursor/)
})
