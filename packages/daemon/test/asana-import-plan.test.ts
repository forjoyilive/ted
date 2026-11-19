import type { Task, TaskArchive } from '@ted/protocol'
import {
  findAsanaUrl,
  ownershipLine,
  parseAsanaImportRequest,
  parseAsanaTaskUrl,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { asanaImportedText, asanaTreeText } from '../../cli/src/asana.ts'
import { AsanaReadError } from '../src/asana/asana.ts'
import { downloadTarget } from '../src/asana/files.ts'
import { type AsanaNode, type AsanaTree, readAsanaTree } from '../src/asana/tree.ts'
import { asanaSource, planAsanaImport } from '../src/tasks/asana-import.ts'
import { sourceKey } from '../src/tasks/sources.ts'

test('every Asana task URL form gives the task ID, and sources match by it', () => {
  const forms = [
    'https://app.asana.com/0/1188/1209337',
    'https://app.asana.com/0/1188/1209337/f',
    'https://app.asana.com/0/0/1209337/f',
    'https://app.asana.com/0/555/1209337/f?focus=true',
    'https://app.asana.com/1/1201/project/1188/task/1209337',
    'https://app.asana.com/1/1201/task/1209337?focus=true',
    'https://app.asana.com/1/1201/inbox/88/item/1209337/story/42',
  ]
  for (const url of forms) {
    expect(parseAsanaTaskUrl(url)?.gid).toBe('1209337')
    expect(sourceKey(url)).toBe('asana:1209337')
  }
  for (const url of [
    'https://app.asana.com/0/1188/list',
    'https://app.asana.com/0/inbox/1',
    'http://app.asana.com/0/1188/1209337',
    'https://evil.example/0/1188/1209337',
    'https://user:pw@app.asana.com/0/1188/1209337',
    'https://app.asana.com/1/1201/project/1188',
  ])
    expect(parseAsanaTaskUrl(url)).toBeUndefined()
  expect(findAsanaUrl('See https://app.asana.com/0/1188/1209337/f.')).toEqual({
    url: 'https://app.asana.com/0/1188/1209337/f',
    gid: '1209337',
  })
  expect(
    findAsanaUrl(`https://app.asana.com/0/1188/1209337${'.'.repeat(100_000)}x`),
  ).toBeUndefined()
  expect(findAsanaUrl(`https://app.asana.com/0/1188/1209337${'!?'.repeat(50_000)}`)).toEqual({
    url: 'https://app.asana.com/0/1188/1209337',
    gid: '1209337',
  })
})

test('the import request parser copies every field and rejects bad input', () => {
  expect(
    parseAsanaImportRequest({
      url: ' https://app.asana.com/0/0/7/f ',
      title: ' Ship the launch page ',
      factory: 'NB',
      priority: 'high',
      start: true,
      addToTree: true,
      taskSync: false,
      dryRun: false,
      draftRevision: 'rev-1',
      ignored: 1,
    }),
  ).toEqual({
    url: 'https://app.asana.com/0/0/7/f',
    title: 'Ship the launch page',
    factory: 'NB',
    priority: 'high',
    start: true,
    addToTree: true,
    taskSync: false,
    dryRun: false,
    draftRevision: 'rev-1',
  })
  expect(parseAsanaImportRequest({ url: 'https://app.asana.com/0/0/7' })).toEqual({
    url: 'https://app.asana.com/0/0/7',
  })
  expect(parseAsanaImportRequest({ url: 'https://app.asana.com/0/0/7', title: '  ' })).toEqual({
    url: 'https://app.asana.com/0/0/7',
  })
  for (const body of [
    null,
    {},
    { url: 'https://linear.app/a/issue/A-1' },
    { url: 'https://app.asana.com/0/0/7', factory: '' },
    { url: 'https://app.asana.com/0/0/7', title: 7 },
    { url: 'https://app.asana.com/0/0/7', priority: 'p1' },
    { url: 'https://app.asana.com/0/0/7', start: 'yes' },
    { url: 'https://app.asana.com/0/0/7', addToTree: 1 },
    { url: 'https://app.asana.com/0/0/7', taskSync: 'no' },
    { url: 'https://app.asana.com/0/0/7', draftRevision: '../x' },
  ])
    expect(() => parseAsanaImportRequest(body)).toThrow()
})

function node(gid: string, depth: number, parentGid?: string, more: Partial<AsanaNode> = {}) {
  return {
    gid,
    name: `Item ${gid}`,
    url: `https://app.asana.com/0/0/${gid}/f`,
    completed: false,
    depth,
    ...(parentGid !== undefined && { parentGid }),
    children: [],
    ...more,
  } satisfies AsanaNode
}

function treeOf(nodes: AsanaNode[]): AsanaTree {
  const map = new Map(nodes.map((n) => [n.gid, n]))
  for (const n of nodes) if (n.parentGid) map.get(n.parentGid)?.children.push(n.gid)
  return { rootGid: nodes[0]?.gid ?? '', nodes: map }
}

function task(id: string, gid: string, more: Partial<Task> = {}): Task {
  return {
    id,
    displayId: `NB-${id}`,
    factoryId: 'f',
    stage: 'backlog',
    source: { url: `https://app.asana.com/0/9/${gid}` },
    repos: [],
    ...more,
  } as Task
}

const plan = (
  tree: AsanaTree,
  tasks: Task[] = [],
  app = true,
  refusal?: string,
  blockers: Record<string, string[]> = {},
) =>
  planAsanaImport({
    tree,
    tasks,
    factoryId: 'f',
    userGid: 'me',
    app,
    parentRefusal: () => refusal,
    blockersOf: (id) => blockers[id] ?? [],
  })

test('the planner creates unfinished items, keeps completed ones as context and reuses tracked Tasks', () => {
  const tree = treeOf([
    node('1', 0, undefined, { assignee: { gid: 'me', name: 'Me' } }),
    node('2', 1, '1', { assignee: { gid: 'x', name: 'Sam' } }),
    node('3', 2, '2'),
    node('4', 1, '1', { completed: true }),
    node('5', 2, '4'),
    node('6', 1, '1'),
    node('7', 1, '1'),
    node('8', 1, '1'),
    node('9', 1, '1'),
    node('10', 1, '1', {
      unreadable: 'Asana didn’t let Ted read it (no access)',
      childrenUnreadable: 'Asana didn’t let Ted read it (no access)',
    }),
    node('11', 2, '10'),
  ])
  const result = plan(tree, [
    task('a', '6'),
    task('b', '7', { stage: 'done' }),
    task('c', '8', { archived: { at: '2026-11-01T00:00:00.000Z' } as TaskArchive }),
    task('d', '9', { parentId: 'z' }),
    task('z', '999'),
  ])
  const actions = Object.fromEntries(result.preview.rows.map((r) => [r.gid, r.action.kind]))
  expect(actions).toEqual({
    '1': 'new',
    '2': 'new',
    '3': 'new',
    '4': 'complete',
    '5': 'new',
    '6': 'linked',
    '7': 'done',
    '8': 'archived',
    '9': 'conflict',
    '10': 'unreadable',
    '11': 'new',
  })
  expect(result.creates.map((c) => [c.node.gid, c.parent])).toEqual([
    ['1', undefined],
    ['2', { gid: '1' }],
    ['3', { gid: '2' }],
    ['5', { gid: '1' }],
    ['11', { gid: '1' }],
  ])
  expect(result.links).toEqual([{ taskId: 'a', parent: { gid: '1' } }])
  expect(result.preview).toMatchObject({
    create: 5,
    ownership: { you: 1, others: 1, unassigned: 3 },
    missing: 2,
  })
  expect(result.holds).toHaveLength(1)
  expect(result.holds[0]?.parent).toEqual({ gid: '1' })
  expect(result.holds[0]?.items.map((i) => i.reason)).toEqual([
    'it’s already NB-d, under NB-z; Ted left it there',
    'Asana didn’t let Ted read it (no access)',
  ])
  expect(ownershipLine(result.preview)).toBe(
    '5 Tasks: 1 assigned to you, 1 to others, 3 unassigned',
  )
  const text = asanaTreeText(result.preview)
  expect(text).toContain('Item 9')
  expect(text).toContain('NB-d · under NB-z, left there')
  const [first] = result.preview.rows
  if (first === undefined) throw new Error('no rows')
  const deep = { ...result.preview, rows: [{ ...first, depth: 1_000_000 }] }
  expect(asanaTreeText(deep).indexOf(first.name)).toBe(40)
  expect(
    asanaImportedText({
      preview: result.preview,
      root: { taskId: 'r', displayId: 'NB-5' },
      created: [{ taskId: 'r', displayId: 'NB-5' }],
      linked: [{ taskId: 'a', displayId: 'NB-a' }],
    }),
  ).toContain('Created 1 Task (NB-5); NB-a moved under its new parent.')
})

test('a tracked root adds only new children for the app and is refused for the CLI', () => {
  const tree = treeOf([node('1', 0), node('2', 1, '1'), node('3', 1, '1')])
  const tracked = [task('r', '1', { stage: 'work' }), task('k', '2', { parentId: 'r' })]
  const app = plan(tree, tracked)
  expect(app.preview.tracked).toMatchObject({ displayId: 'NB-r' })
  expect(app.preview.refusal).toBeUndefined()
  expect(app.creates.map((c) => [c.node.gid, c.parent])).toEqual([['3', { taskId: 'r' }]])
  expect(app.preview.rows.map((r) => r.action.kind)).toEqual(['kept', 'kept', 'new'])
  expect(plan(tree, tracked, false).preview.refusal).toContain('Already tracked as NB-r')
  expect(plan(tree, tracked, true, 'Stop NB-r first').preview.refusal).toBe('Stop NB-r first')
  expect(plan(tree, [task('r', '1', { stage: 'done' })], false).preview.refusal).toContain(
    'NB-r is Done',
  )
  const again = plan(tree, [task('r', '1', { stage: 'done' })], true)
  expect(again.creates.map((c) => c.node.gid)).toEqual(['1', '2', '3'])
})

test('linking a Task that would close a loop through new Tasks is a conflict', () => {
  const tree = treeOf([node('1', 0), node('2', 1, '1'), node('3', 2, '2')])
  const tasks = [task('r', '1'), task('d', '3')]
  const looped = plan(tree, tasks, true, undefined, { d: ['r'] })
  expect(looped.preview.rows.map((r) => r.action.kind)).toEqual(['kept', 'new', 'conflict'])
  expect(looped.links).toEqual([])
  expect(looped.holds[0]).toMatchObject({ parent: { gid: '2' }, items: [{ gid: '3' }] })
  const fine = plan(tree, tasks)
  expect(fine.links).toEqual([{ taskId: 'd', parent: { gid: '2' } }])
})

test('a completed root is still imported, and limits refuse the whole import', () => {
  const done = plan(treeOf([node('1', 0, undefined, { completed: true })]))
  expect(done.preview.rows[0]).toMatchObject({ completed: true, action: { kind: 'new' } })
  expect(done.creates).toHaveLength(1)
  const big = treeOf([
    node('0', 0),
    ...Array.from({ length: 101 }, (_, i) => node(String(i + 1), 1, '0')),
  ])
  expect(plan(big).preview.refusal).toBe(
    'This import would create 102 Tasks. Ted imports at most 100 at a time.',
  )
  const tooBig = { ...treeOf([node('1', 0)]), tooBig: 'Too deep.' }
  expect(plan(tooBig).preview.refusal).toBe('Too deep.')
})

test('the Task source keeps the Asana description, comments and subtasks for the Task Lead', () => {
  const tree = treeOf([
    node('1', 0, undefined, {
      notes: 'Build the checkout',
      assignee: { gid: 'me', name: 'Me' },
      comments: [{ author: 'Sam', at: '2026-11-01T10:00:00.000Z', text: 'Use the new API' }],
    }),
    node('2', 1, '1'),
    node('3', 1, '1', { completed: true }),
  ])
  const root = tree.nodes.get('1')
  if (!root) throw new Error('no root')
  const source = asanaSource(root, tree, 'me', '2026-11-12T00:00:00.000Z')
  expect(source).toMatchObject({
    gid: '1',
    assignee: { name: 'Me', you: true },
    completed: false,
    children: [
      { gid: '2', completed: false },
      { gid: '3', completed: true },
    ],
  })
  expect(source.context).toContain('Build the checkout')
  expect(source.context).toContain('Sam, 2026-11-01T10:00:00.000Z:\nUse the new API')
  expect(source.context).toContain('- Item 3 (complete): https://app.asana.com/0/0/3/f')
})

test('the tree reader follows every page, skips system activity and marks unreadable items', async () => {
  const subtasks = Array.from({ length: 5 }, (_, i) => ({
    gid: String(10 + i),
    name: `Child ${i}`,
    completed: i === 4,
  }))
  const calls: string[] = []
  const read = async (path: string, query: Record<string, string> = {}) => {
    calls.push(`${path}?${query.offset ?? ''}`)
    const offset = Number(query.offset ?? '0')
    const pageOf = (items: unknown[]) => ({
      data: items.slice(offset, offset + 2),
      next_page: offset + 2 < items.length ? { offset: String(offset + 2) } : null,
    })
    if (path === '/tasks/12') throw new AsanaReadError('no', 403)
    if (path === '/attachments' && query.parent === '11') throw new AsanaReadError('no', 403)
    if (path === '/tasks/11/subtasks') return { data: [], next_page: { offset: 'same' } }
    if (path === '/tasks/1/subtasks') return pageOf(subtasks)
    if (path.endsWith('/subtasks')) return pageOf([])
    if (path.endsWith('/stories'))
      return pageOf([
        { resource_subtype: 'due_date_changed', text: 'changed the due date' },
        { resource_subtype: 'comment_added', text: 'Hi', created_by: { name: 'Sam' } },
      ])
    if (path === '/attachments') return pageOf([{ name: 'doc', host: 'gdrive' }])
    const gid = path.split('/')[2] ?? ''
    return { data: { gid, name: `Task ${gid}`, completed: false } }
  }
  const tree = await readAsanaTree({ read, rootGid: '1', tracked: new Set(['13']) })
  expect(tree.tooBig).toBeUndefined()
  expect(tree.nodes.get('1')?.children).toEqual(['10', '11', '12', '13', '14'])
  expect(tree.nodes.get('12')?.unreadable).toBe('Asana didn’t let Ted read it (no access)')
  expect(tree.nodes.get('10')?.comments).toEqual([{ author: 'Sam', at: '', text: 'Hi' }])
  expect(tree.nodes.get('10')?.unfetched).toEqual([
    expect.objectContaining({ name: 'doc', reason: 'it’s stored outside Asana' }),
  ])
  expect(tree.nodes.get('11')).toMatchObject({
    partial: ['Ted couldn’t copy its files: Asana didn’t let Ted read it (no access)'],
    childrenUnreadable: 'Asana didn’t finish listing its subtasks',
  })
  expect(tree.nodes.get('11')?.unreadable).toBeUndefined()
  expect(calls).toContain('/tasks/1/subtasks?4')
  expect(calls.some((c) => c.startsWith('/tasks/13?'))).toBe(false)
  expect(calls.some((c) => c.startsWith('/tasks/14?'))).toBe(false)
})

test('downloads go only to plain HTTPS hosts, or loopback when a test allows it', () => {
  expect(downloadTarget('https://asana-files.s3.amazonaws.com/a?sig=1', false).host).toBe(
    'asana-files.s3.amazonaws.com',
  )
  expect(downloadTarget('http://127.0.0.1:9/files/1/0', true).port).toBe('9')
  for (const url of [
    'http://127.0.0.1:9/files/1/0',
    'http://files.example.com/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://localhost/a',
    'https://user:pw@files.example.com/a',
    'https://intranet/a',
    'file:///etc/passwd',
    'not a url',
  ])
    expect(() => downloadTarget(url, false)).toThrow()
})
