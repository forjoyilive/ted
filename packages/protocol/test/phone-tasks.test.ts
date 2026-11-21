import { expect, test } from 'vitest'
import type { Json } from '../src/parse.ts'
import {
  encodeCommentsCursor,
  encodeTasksCursor,
  type PhoneFactoriesBody,
  type PhoneTaskBody,
  type PhoneTaskCommentsBody,
  type PhoneTaskCreatedBody,
  type PhoneTaskRow,
  type PhoneTasksBody,
  parseCommentsCursor,
  parsePhoneFactoriesBody,
  parsePhoneTaskBody,
  parsePhoneTaskCommentsBody,
  parsePhoneTaskCreatedBody,
  parsePhoneTasksBody,
  parseTasksCursor,
  phoneCursorMax,
  phoneTaskTitleMax,
} from '../src/phone-tasks.ts'
import {
  parsePhoneRequest,
  phoneActionTextMax,
  phoneFactoryKeyMax,
  phoneRevisionMax,
  toBase64Url,
} from '../src/phones.ts'

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
  actions: ['stop', 'priority', 'comment', 'archive', 'delete'],
} satisfies PhoneTaskRow

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
        actions: [],
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
      rows: [{ ...row, factory: { ...row.factory, icon: { kind: 'sticker' } } }],
    }),
  ).toThrow(/kind/)
  expect(() =>
    parsePhoneTasksBody({
      ...body,
      rows: [{ ...row, factory: { ...row.factory, icon: { kind: 'image', dataUrl: 'x' } } }],
    }),
  ).toThrow(/version/)
  expect(() => parsePhoneTasksBody({ ...body, rows: [{ ...row, actions: ['edit'] }] })).toThrow(
    /actions/,
  )
  const { actions: __, ...withoutActions } = row
  expect(() => parsePhoneTasksBody({ ...body, rows: [withoutActions] })).toThrow(/actions/)
})

test('parsePhoneTaskBody reads the row fields, the description, cut and the Archive and Delete facts', () => {
  const task = {
    ...row,
    description: '# Goal\n\nBuild it.',
    cut: true,
    childTasks: 2,
    openPullRequests: 1,
    hierarchyRevision: 'abc123',
  }
  const body: PhoneTaskBody = { task }
  expect(parsePhoneTaskBody(roundTrip(body))).toEqual(body)
  expect(() => parsePhoneTaskBody({ task: { ...task, description: undefined } })).toThrow(
    /description/,
  )
  expect(() => parsePhoneTaskBody({ task: { ...task, childTasks: -1 } })).toThrow(/childTasks/)
  expect(() => parsePhoneTaskBody({ task: { ...task, openPullRequests: 'one' } })).toThrow(
    /openPullRequests/,
  )
  expect(() => parsePhoneTaskBody({ task: { ...task, hierarchyRevision: 3 } })).toThrow(
    /hierarchyRevision/,
  )
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

test('parsePhoneRequest reads every field of the Task action routes and refuses bad ones', () => {
  const header = { protocol: 3, id: toBase64Url(new Uint8Array(16)), at: 1, type: 'request' }
  for (const route of ['task-start', 'task-stop'] as const) {
    const plain = { ...header, route, taskId: 'TED-788' }
    expect(parsePhoneRequest(plain)).toEqual(plain)
    expect(() => parsePhoneRequest({ ...plain, taskId: '' })).toThrow(/taskId/)
  }

  const resume = { ...header, route: 'task-resume', taskId: 'TED-788', text: 'Carry on' }
  expect(parsePhoneRequest(resume)).toEqual(resume)
  const { text: _, ...bareResume } = resume
  expect(parsePhoneRequest(bareResume)).toEqual(bareResume)
  expect(parsePhoneRequest({ ...resume, text: '' })).toEqual({ ...resume, text: '' })
  expect(() => parsePhoneRequest({ ...resume, text: 'x'.repeat(phoneActionTextMax + 1) })).toThrow(
    /text/,
  )

  const priority = { ...header, route: 'task-priority', taskId: 'TED-788', priority: 'urgent' }
  expect(parsePhoneRequest(priority)).toEqual(priority)
  expect(() => parsePhoneRequest({ ...priority, priority: 'soon' })).toThrow(/priority/)
  expect(() => parsePhoneRequest({ ...priority, priority: undefined })).toThrow(/priority/)

  const comment = { ...header, route: 'task-comment', taskId: 'TED-788', text: 'Looks good' }
  expect(parsePhoneRequest(comment)).toEqual(comment)
  expect(() => parsePhoneRequest({ ...comment, text: '  ' })).toThrow(/text/)
  expect(() => parsePhoneRequest({ ...comment, text: undefined })).toThrow(/text/)
  expect(() => parsePhoneRequest({ ...comment, text: 'x'.repeat(phoneActionTextMax + 1) })).toThrow(
    /text/,
  )

  const archive = {
    ...header,
    route: 'task-archive',
    taskId: 'TED-788',
    hierarchyRevision: 'rev',
    closePullRequests: true,
    children: 'detach',
  }
  expect(parsePhoneRequest(archive)).toEqual(archive)
  const { children: __, ...bareArchive } = archive
  expect(parsePhoneRequest(bareArchive)).toEqual(bareArchive)
  expect(() => parsePhoneRequest({ ...archive, children: 'unparent' })).toThrow(/children/)
  expect(() => parsePhoneRequest({ ...archive, closePullRequests: undefined })).toThrow(
    /closePullRequests/,
  )
  expect(() => parsePhoneRequest({ ...archive, hierarchyRevision: '' })).toThrow(
    /hierarchyRevision/,
  )
  expect(() =>
    parsePhoneRequest({ ...archive, hierarchyRevision: 'r'.repeat(phoneRevisionMax + 1) }),
  ).toThrow(/hierarchyRevision/)

  const remove = {
    ...header,
    route: 'task-delete',
    taskId: 'TED-788',
    hierarchyRevision: 'rev',
    children: 'unparent',
  }
  expect(parsePhoneRequest(remove)).toEqual(remove)
  const { children: ___, ...bareRemove } = remove
  expect(parsePhoneRequest(bareRemove)).toEqual(bareRemove)
  expect(() => parsePhoneRequest({ ...remove, children: 'detach' })).toThrow(/children/)
  expect(() => parsePhoneRequest({ ...remove, hierarchyRevision: undefined })).toThrow(
    /hierarchyRevision/,
  )
})

test('parsePhoneFactoriesBody reads ID, key, name, icon and default priority', () => {
  const body: PhoneFactoriesBody = {
    factories: [
      {
        id: 'f-ted',
        key: 'TED',
        name: 'Ted',
        icon: { kind: 'symbol', symbol: 'code', color: 'blue' },
        defaultPriority: 'none',
      },
      {
        id: 'f-nb',
        key: 'NB',
        name: 'Notebook',
        icon: { kind: 'image', version: 'abc123' },
        defaultPriority: 'none',
      },
      { id: 'f-old', key: 'OLD', name: 'Older', defaultPriority: 'none' },
    ],
  }
  expect(parsePhoneFactoriesBody(roundTrip(body))).toEqual(body)
  expect(() =>
    parsePhoneFactoriesBody({ factories: [{ id: 'f-nb', key: 'NB', name: 'Notebook' }] }),
  ).toThrow(/defaultPriority/)
  expect(() =>
    parsePhoneFactoriesBody({
      factories: [{ id: 'f-nb', name: 'Notebook', defaultPriority: 'none' }],
    }),
  ).toThrow(/key/)
  expect(() =>
    parsePhoneFactoriesBody({
      factories: [{ key: 'NB', name: 'Notebook', defaultPriority: 'none' }],
    }),
  ).toThrow(/id/)
  expect(() =>
    parsePhoneFactoriesBody({
      factories: [
        { id: 'f-nb', key: 'NB', name: 'N', icon: { kind: 'image' }, defaultPriority: 'none' },
      ],
    }),
  ).toThrow(/version/)
})

test('parsePhoneTaskCreatedBody reads the Task and an optional start refusal', () => {
  const task = {
    ...row,
    description: '',
    cut: false,
    childTasks: 0,
    openPullRequests: 0,
    hierarchyRevision: 'abc123',
  }
  const plain: PhoneTaskCreatedBody = { task }
  expect(parsePhoneTaskCreatedBody(roundTrip(plain))).toEqual(plain)
  const refused: PhoneTaskCreatedBody = { task, startRefused: 'NB has no free slot' }
  expect(parsePhoneTaskCreatedBody(roundTrip(refused))).toEqual(refused)
  expect(() => parsePhoneTaskCreatedBody({ task, startRefused: 3 })).toThrow(/startRefused/)
})

test('parsePhoneRequest reads every field of task-create and refuses bad ones', () => {
  const header = { protocol: 3, id: toBase64Url(new Uint8Array(16)), at: 1, type: 'request' }
  const create = {
    ...header,
    route: 'task-create',
    createId: toBase64Url(new Uint8Array(16).fill(7)),
    factory: 'NB',
    title: 'Fix the login page',
    description: 'It loops.',
    priority: 'high',
    start: true,
  }
  expect(parsePhoneRequest(create)).toEqual(create)
  const { title: _, description: __, priority: ___, ...bare } = create
  expect(parsePhoneRequest(bare)).toEqual({ ...bare, priority: 'none' })
  expect(parsePhoneRequest({ ...create, title: '' })).toEqual({ ...create, title: '' })
  expect(() => parsePhoneRequest({ ...create, createId: 'short' })).toThrow(/createId/)
  expect(() => parsePhoneRequest({ ...create, createId: undefined })).toThrow(/createId/)
  expect(() => parsePhoneRequest({ ...create, factory: '' })).toThrow(/factory/)
  expect(() =>
    parsePhoneRequest({ ...create, factory: 'F'.repeat(phoneFactoryKeyMax + 1) }),
  ).toThrow(/factory/)
  expect(() => parsePhoneRequest({ ...create, title: 't'.repeat(phoneTaskTitleMax + 1) })).toThrow(
    /title/,
  )
  expect(() => parsePhoneRequest({ ...create, title: 3 })).toThrow(/title/)
  expect(() =>
    parsePhoneRequest({ ...create, description: 'd'.repeat(phoneActionTextMax + 1) }),
  ).toThrow(/description/)
  expect(() => parsePhoneRequest({ ...create, priority: 'soon' })).toThrow(/priority/)
  expect(() => parsePhoneRequest({ ...create, start: undefined })).toThrow(/start/)
  expect(() => parsePhoneRequest({ ...create, start: 'yes' })).toThrow(/start/)

  const factories = { ...header, route: 'factories' }
  expect(parsePhoneRequest(factories)).toEqual(factories)
})
