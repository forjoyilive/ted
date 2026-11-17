import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RequestPurpose } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { eventlogFile } from '../src/store/files.ts'
import { type NewComment, openStore, type TedStore } from '../src/store/index.ts'

let directory: string
let store: TedStore
let taskId: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'ted-request-purpose-'))
  store = await openStore({ directory })
  taskId = (await store.createTask({ title: 'Request purposes' })).id
})
afterEach(async () => {
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

const post = (input: Partial<NewComment> = {}) =>
  store.postComment({
    taskId,
    body: 'A question',
    kind: 'question',
    author: { kind: 'ted' },
    ...input,
  })

async function reopen(legacy = false) {
  await store.close()
  const file = (await eventlogFile(directory)) as string
  if (legacy) {
    const log = new DatabaseSync(file)
    try {
      log
        .prepare(
          "UPDATE eventlog SET name = 'v1.CommentMarkedTutorial', argsJson = json_object('commentId', json_extract(argsJson, '$.commentId')) WHERE name = 'v1.CommentPurposeRecorded'",
        )
        .run()
    } finally {
      log.close()
    }
  }
  const folder = path.dirname(file)
  for (const name of await readdir(folder)) {
    if (name.startsWith('state')) await rm(path.join(folder, name))
  }
  store = await openStore({ directory })
}

test('explicit purposes survive replay independently of the request’s wording and choices', async () => {
  const purposes: RequestPurpose[] = [
    { kind: 'model', runId: 'original-run' },
    { kind: 'ci-stuck' },
    { kind: 'linear-closed' },
    { kind: 'idle-run' },
    { kind: 'send-back' },
    { kind: 'failure' },
  ]
  const comments = purposes.map((purpose) =>
    post({ purpose, title: 'New wording', choices: ['A new label'] }),
  )
  await reopen()
  expect(comments.map((c) => store.getComment(c.id)?.purpose)).toEqual(purposes)
  expect(store.listOpenRequests().map((c) => c.purpose)).toEqual(purposes)
})

test('legacy wording is normalized only for Ted’s questions, and explicit ordinary purpose wins', async () => {
  store.startRun({ id: 'old-run', taskId, agent: 'claude', prompt: 'Old', cwd: directory })
  const cases: { input: Partial<NewComment>; purpose: RequestPurpose }[] = [
    {
      input: {
        title: 'unavailable isn’t in your plan',
        choices: ['Use the default model', 'Change setting'],
      },
      purpose: { kind: 'model', runId: 'old-run' },
    },
    {
      input: { title: 'KRI-1 was marked Done in Linear', choices: ['Archive', 'Keep going'] },
      purpose: { kind: 'linear-closed' },
    },
    { input: { title: 'The Task Lead stopped without saying why' }, purpose: { kind: 'idle-run' } },
    { input: { gate: { approveLabel: 'Approve' }, kind: 'review' }, purpose: { kind: 'gate' } },
    {
      input: {
        author: { kind: 'run', runId: 'old-run' },
        title: 'The Task Lead stopped without saying why',
      },
      purpose: { kind: 'question' },
    },
    { input: {}, purpose: { kind: 'question' } },
  ]
  const comments = cases.map(({ input }) => post(input))
  await reopen(true)
  expect(comments.map((c) => store.getComment(c.id)?.purpose)).toEqual(cases.map((c) => c.purpose))
  const ordinary = post({
    title: 'The Task Lead stopped without saying why',
    purpose: { kind: 'question' },
  })
  expect(ordinary.purpose).toEqual({ kind: 'question' })
})

test('legacy CI stuck questions normalize from the Merge Stage and stored choices', async () => {
  store.changeStage(taskId, 'merge', {
    stageFile: { layer: 'ted', path: 'merge.md' },
    layers: [],
    order: [],
  })
  const question = post({ choices: ['Keep waiting', 'Merge anyway'] })
  await reopen(true)
  expect(store.getComment(question.id)?.purpose).toEqual({ kind: 'ci-stuck' })
})

test('metadata is posted in the same commit as the request', async () => {
  let observed: RequestPurpose | undefined
  store.subscribe((event) => {
    if (event.type === 'comment-posted') observed = store.getComment(event.comment.id)?.purpose
  })
  post({ purpose: { kind: 'ci-stuck' } })
  expect(observed).toEqual({ kind: 'ci-stuck' })
})

test('the current Run problem’s time survives replay without becoming a public Run field', async () => {
  store.startRun({ id: 'waiting-run', taskId, agent: 'claude', prompt: 'Work', cwd: directory })
  store.recordRunOutput('waiting-run', { toOffset: 0, problem: 'model-unavailable' })
  const problemAt = store.runProblemAt('waiting-run')
  expect(problemAt).toBeDefined()
  await reopen()
  expect(store.runProblemAt('waiting-run')).toBe(problemAt)
  expect(store.getRun('waiting-run')).not.toHaveProperty('problemAt')
})
