import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Comment, Factory, InboxItem, Run, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-design-review-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const brief = `## Goal

Onboarding design: two steps instead of four

## Decisions so far

- Local-first, no account wall.

## Current state

Prototype and screens are ready.

## Open questions

None.

## Next step

Build step 1.
`

const files: Record<string, string> = {
  'welcome.png': 'png bytes one',
  'first-note.png': 'png bytes two',
  'walkthrough.mp4': 'mp4 bytes',
  'onboarding.html': '<p>Welcome to Notebook</p>',
  'notes.txt': 'plain text',
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

async function start(workflow = 'version: 1\norder: [intake, design, work, merge]\n') {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(briefFile, brief)
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(scratch, name), text)
  return { ...client, ok, briefFile }
}

type Client = Awaited<ReturnType<typeof start>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const at = (name: string) => path.join(scratch, name)

async function designFile(name: string, review: unknown): Promise<string> {
  const file = at(name)
  await writeFile(file, JSON.stringify(review))
  return file
}

const fullReview = () => ({
  title: 'Onboarding design: two steps instead of four',
  summary:
    'Merged the welcome and sync screens into one, and moved the notification ask to the first time a note is shared.',
  screenshots: [
    { path: at('welcome.png'), caption: 'Step 1 · Welcome' },
    { path: at('first-note.png'), caption: 'Step 2 · First note' },
  ],
  video: { path: at('walkthrough.mp4'), caption: 'Walkthrough · 0:42' },
  prototype: at('onboarding.html'),
  figma: {
    url: 'https://www.figma.com/design/abc123/Onboarding?node-id=1-2',
    label: 'Onboarding v2 · 3 frames',
  },
  worthYourEye: [
    'Skipping sign-in entirely on step 1.',
    'The notification ask waits until the first share.',
  ],
})

async function startTask(client: Client, ...list: unknown[]): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', { title: steps(...list), factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const leadRun = async (client: Client, task: Task): Promise<Run> => {
  const { leadRunId } = await getTask(client, task.id)
  if (!leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return (await client.getRun(leadRunId)).run
}

const commandResults = async (client: Client, task: Task) =>
  assistantTexts((await client.getRun((await leadRun(client, task)).id)).conversation).map(
    (text) => JSON.parse(text) as { code: number; stdout: string; stderr: string },
  )

const inbox = (client: Client) => client.ok<InboxItem[]>('GET', '/inbox')

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const waitForRequest = (client: Client) =>
  waitUntil(async () => (await inbox(client)).at(0), 'a request in the Inbox')

const waitForStage = (client: Client, task: Task, stage: string) =>
  waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.stage === stage ? t : undefined
  }, `${task.displayId} to reach ${stage}`)

const atDesign = (client: Client, ...list: unknown[]) => [
  { everyMessage: [{ run: ['ted', 'brief', 'write', '--file', client.briefFile] }, ...list] },
  { run: ['ted', 'outcome', 'advance'] },
  { endTurn: true },
]

describe('the design review', () => {
  test('ted outcome advance --design posts screenshots, a video, a prototype, a Figma link and Worth your eye', async () => {
    const client = await start()
    const file = await designFile('design.json', fullReview())
    const task = await startTask(
      client,
      ...atDesign(
        client,
        { run: ['ted', 'outcome', 'advance', '--design', file] },
        { endTurn: true },
      ),
    )

    const { request } = await waitForRequest(client)
    expect(request).toMatchObject({
      kind: 'review',
      stage: 'design',
      title: 'Onboarding design: two steps instead of four',
      gate: { approveLabel: 'Approve' },
      design: {
        summary:
          'Merged the welcome and sync screens into one, and moved the notification ask to the first time a note is shared.',
        screenshots: [
          {
            hash: sha(files['welcome.png'] ?? ''),
            name: 'welcome.png',
            caption: 'Step 1 · Welcome',
          },
          {
            hash: sha(files['first-note.png'] ?? ''),
            name: 'first-note.png',
            caption: 'Step 2 · First note',
          },
        ],
        video: {
          hash: sha(files['walkthrough.mp4'] ?? ''),
          name: 'walkthrough.mp4',
          caption: 'Walkthrough · 0:42',
        },
        prototype: { hash: sha(files['onboarding.html'] ?? ''), name: 'onboarding.html' },
        figma: {
          url: 'https://www.figma.com/design/abc123/Onboarding?node-id=1-2',
          label: 'Onboarding v2 · 3 frames',
        },
        worthYourEye: [
          'Skipping sign-in entirely on step 1.',
          'The notification ask waits until the first share.',
        ],
      },
    })
    expect(request.attachments?.map((a) => [a.name, a.mediaType])).toEqual([
      ['welcome.png', 'image/png'],
      ['first-note.png', 'image/png'],
      ['walkthrough.mp4', 'video/mp4'],
      ['onboarding.html', 'text/html'],
    ])
    expect((await getTask(client, task.id)).stage).toBe('design')
  })

  test('TED refuses a design review with the wrong kind of file, a link that isn’t Figma, or outside Design', async () => {
    const client = await start()
    const notHtml = await designFile('a.json', { prototype: at('welcome.png') })
    const textShot = await designFile('b.json', { screenshots: [at('notes.txt')] })
    const notFigma = await designFile('c.json', { figma: { url: 'http://example.com/x' } })
    const good = await designFile('d.json', { summary: 'Fine.' })
    const task = await startTask(
      client,
      {
        everyMessage: [
          { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
          { run: ['ted', 'outcome', 'advance', '--design', notHtml] },
          { run: ['ted', 'outcome', 'advance', '--design', textShot] },
          { run: ['ted', 'outcome', 'advance', '--design', notFigma] },
          { endTurn: true },
        ],
      },
      { run: ['ted', 'outcome', 'advance', '--design', good] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    )
    await waitUntil(async () => (await commandResults(client, task)).length === 6, 'six commands')

    const failures = (await commandResults(client, task))
      .filter((r) => r.code !== 0)
      .map((r) => r.stderr)
    expect(failures).toEqual([
      'ted: only Design posts a design review\n',
      'ted: welcome.png can’t be the prototype; the prototype is an HTML file\n',
      'ted: notes.txt can’t be the screenshot; a screenshot is a PNG, JPEG, GIF, WebP or SVG image\n',
      'ted: the Figma link must be an https://www.figma.com/ URL\n',
    ])
    expect(await inbox(client)).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('design')
  })

  test('Request changes keeps the Task in Design; the next design review replaces it and Approve moves on to Work', async () => {
    const client = await start()
    const first = await designFile('first.json', { summary: 'Four steps.' })
    const task = await startTask(
      client,
      {
        everyMessage: [
          { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
          { run: ['ted', 'outcome', 'advance', '--design', first] },
          { endTurn: true },
        ],
      },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    )
    const { request } = await waitForRequest(client)
    expect(request.design).toEqual({ summary: 'Four steps.' })
    await client.ok('POST', `/comments/${request.id}/answer`, {
      action: 'request-changes',
      text: 'Make it two steps.',
    })
    const again = await waitUntil(async () => {
      const posted = (await comments(client, task)).filter((c) => c.kind === 'review')
      return posted.length === 2 ? posted[1] : undefined
    }, 'a second design review')
    expect((await getTask(client, task.id)).stage).toBe('design')
    expect(again?.answer).toBeUndefined()
    await client.ok('POST', `/comments/${again?.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'work')
  })

  test('with the Design Gate off, the design review becomes a note in the thread and the Task moves on', async () => {
    const client = await start(
      'version: 1\norder: [intake, design, work, merge]\nstages:\n  design: { gate: false }\n',
    )
    const file = await designFile('design.json', fullReview())
    const task = await startTask(
      client,
      ...atDesign(
        client,
        { run: ['ted', 'outcome', 'advance', '--design', file] },
        { endTurn: true },
      ),
    )
    await waitForStage(client, task, 'work')

    const [note] = (await comments(client, task)).filter((c) => c.author.kind === 'run')
    expect(note).toMatchObject({ kind: 'note', stage: 'design' })
    expect(note?.body).toBe(
      [
        'Onboarding design: two steps instead of four',
        'Merged the welcome and sync screens into one, and moved the notification ask to the first time a note is shared.',
        'Worth your eye:\n- Skipping sign-in entirely on step 1.\n- The notification ask waits until the first share.',
        'Figma: https://www.figma.com/design/abc123/Onboarding?node-id=1-2',
      ].join('\n\n'),
    )
    expect(note?.attachments?.map((a) => a.name)).toEqual([
      'welcome.png',
      'first-note.png',
      'walkthrough.mp4',
      'onboarding.html',
    ])
    expect(await inbox(client)).toEqual([])
  })
})
