import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AnswerRequest,
  type Attachment,
  type Automation,
  type AutomationDetail,
  type Banner,
  type Comment,
  type DaemonClient,
  encodePairingLink,
  type Factory,
  type MacReply,
  type PhoneAnswer,
  type PhoneProblemsBody,
  type PhoneRequestDetail,
  type PhoneRequestSummary,
  type Plan,
  type PlanDetail,
  parsePhoneImageBody,
  parsePhoneProblemsBody,
  parsePhoneRequestBody,
  parsePhoneRequestsBody,
  phoneImagePartBytes,
  phoneProblemFactoryMax,
  phoneProblemsMax,
  phoneProblemTextMax,
  phoneReplyBodyMax,
  readDaemonInfo,
  type Task,
  tedPaths,
} from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { phoneImageId } from '../src/phones/images.ts'
import { phoneProblems } from '../src/phones/problems.ts'
import type { PushMessage } from '../src/phones/push.ts'
import type { NewComment, TedStore } from '../src/store/index.ts'
import {
  api,
  appClient,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import { memoryKeyrings, type RelayStub, startRelayStub, TestPhone } from './support/phone-relay.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let relay: RelayStub
let daemon: RunningDaemon
let store: TedStore
let client: DaemonClient
let http: ReturnType<typeof api>
let factory: Factory
let phone: TestPhone
const phones: TestPhone[] = []
const pushed: PushMessage[] = []
const shrunk: string[] = []

const ok = async <T>(method: string, route: string, body?: JsonObject): Promise<T> => {
  const res = await http.call(method, route, body)
  if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
  return res.body as T
}

beforeAll(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-phones-inbox-'))
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\n' })
  relay = await startRelayStub()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: memoryKeyrings().keyrings,
      relayUrl: relay.url,
      macName: async () => 'Inbox Mac',
      relayDelaysMs: [50],
      push: {
        async send(message) {
          pushed.push(message)
          return { kind: 'sent' }
        },
      },
      async shrinkImage(input, output) {
        shrunk.push(input)
        const bytes = await readFile(input)
        if (bytes.subarray(0, 6).toString() === 'broken') throw new Error('sips: not an image')
        await writeFile(output, bytes)
      },
    },
    wrap: {
      store: (opened) => {
        store = opened
        return opened
      },
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon.json')
  client = appClient(info, daemon.appToken)
  http = api(daemon.port, { appKey: daemon.appToken })
  factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  phone = await pairedPhone('Inbox Phone')
}, 60_000)

afterAll(async () => {
  for (const each of phones) each.close()
  await daemon?.stop()
  await relay?.close()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function pairedPhone(name: string): Promise<TestPhone> {
  const offer = await client.createPhonePairing()
  const paired = new TestPhone(offer.link)
  phones.push(paired)
  await paired.online
  await paired.pair(name)
  await client.approvePhonePairing({ pairing: paired.link.pairing })
  await paired.approved()
  return paired
}

function failure(reply: MacReply): string | undefined {
  return reply.ok ? undefined : reply.error.code
}

async function listed(): Promise<{ requests: PhoneRequestSummary[]; more: number }> {
  const reply = await phone.requests()
  if (!reply.ok) throw new Error(`requests failed: ${reply.error.code}`)
  return parsePhoneRequestsBody(reply.body)
}

async function opened(id: string): Promise<PhoneRequestDetail> {
  const reply = await phone.request(id)
  if (!reply.ok) throw new Error(`request failed: ${reply.error.code}`)
  return parsePhoneRequestBody(reply.body).request
}

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const newTask = (title: string) => ok<Task>('POST', '/tasks', { title, factory: 'NB' })

function ask(taskId: string, request: Omit<NewComment, 'taskId' | 'author'>): Comment {
  return store.postComment({ taskId, author: { kind: 'ted' }, ...request })
}

function answerOf(id: string) {
  const answer = store.getComment(id)?.answer
  if (!answer) return undefined
  const { at: _, ...rest } = answer
  return rest
}

async function twins(request: Omit<NewComment, 'taskId' | 'author'>, title: string) {
  const desk = await newTask(`${title} on the Mac`)
  const pocket = await newTask(`${title} on the phone`)
  return {
    desk: ask(desk.id, request),
    pocket: ask(pocket.id, request),
    deskTask: desk,
    pocketTask: pocket,
  }
}

async function sameAnswer(
  request: Omit<NewComment, 'taskId' | 'author'>,
  title: string,
  desktop: AnswerRequest,
  fromPhone: PhoneAnswer,
) {
  const pair = await twins(request, title)
  expect((await opened(pair.pocket.id)).onPhone, title).toBe(true)
  await client.answerRequest(pair.desk.id, desktop)
  expect(await phone.answer(pair.pocket.id, fromPhone), title).toMatchObject({
    ok: true,
    body: { answered: true },
  })
  const desk = answerOf(pair.desk.id)
  expect(desk, title).toBeDefined()
  expect(answerOf(pair.pocket.id), title).toEqual(desk)
  expect(store.getComment(pair.pocket.id)?.autopilotAnswered, title).toBe(
    store.getComment(pair.desk.id)?.autopilotAnswered,
  )
  expect(store.getComment(pair.pocket.id)?.autopilotAnswered, title).not.toBe(true)
  return pair
}

test('the phone lists what the desktop Inbox waits on, newest first, without snoozed requests', async () => {
  const task = await newTask('Pick a parser')
  const first = ask(task.id, { kind: 'question', body: 'Which repo?', choices: ['web', 'api'] })
  const snoozed = ask(task.id, { kind: 'question', body: 'Later, please' })
  const review = ask(task.id, {
    kind: 'review',
    title: 'Design review',
    body: 'Look at the screenshots.',
    gate: { approveLabel: 'Approve' },
  })
  await client.snoozeRequest(snoozed.id, new Date(Date.now() + 3_600_000).toISOString())

  const waiting = (await client.listWaiting()).toSorted(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  )
  const { requests, more } = await listed()
  expect(requests.map((r) => r.id)).toEqual(waiting.map((w) => w.id))
  expect(more).toBe(0)
  expect(requests.map((r) => r.id)).not.toContain(snoozed.id)
  expect(requests.find((r) => r.id === first.id)).toEqual({
    id: first.id,
    source: 'task',
    kind: 'question',
    factory: factory.name,
    factoryId: factory.id,
    factoryIcon: { kind: 'letter', color: 'blue' },
    title: 'Pick a parser',
    ref: task.displayId,
    headline: 'Which repo?',
    createdAt: first.createdAt,
    onPhone: true,
    task: {
      id: task.id,
      priority: task.priority,
      actions: expect.arrayContaining(['priority', 'comment', 'archive', 'delete']),
    },
  })
  expect(requests.find((r) => r.id === review.id)).toMatchObject({ kind: 'review', onPhone: true })
  expect(await opened(first.id)).toMatchObject({
    body: 'Which repo?',
    cut: false,
    attachments: 0,
    form: { type: 'choices', choices: ['web', 'api'], multiple: false, text: true },
  })
  expect(failure(await phone.request(snoozed.id))).toBe('gone')
})

test('each answerable Task request answered from the phone ends as the desktop answer does, as the human', async () => {
  await sameAnswer(
    { kind: 'question', body: 'Ship it on Friday?', choices: ['Yes', 'No'] },
    'A question',
    { action: 'answer', choice: 'Yes', text: 'After lunch' },
    { action: 'answer', choice: 'Yes', text: 'After lunch' },
  )
  await sameAnswer(
    {
      kind: 'question',
      body: 'Which pages?',
      choices: ['Home', 'Settings', 'Help'],
      multiple: true,
    },
    'Several choices',
    { action: 'answer', choices: ['Home', 'Help'] },
    { action: 'answer', choices: ['Home', 'Help'] },
  )
  await sameAnswer(
    { kind: 'question', body: 'Anything else?' },
    'Free text',
    { action: 'answer', text: 'Keep the old icon' },
    { action: 'answer', text: 'Keep the old icon' },
  )
  const round = {
    number: 1,
    questions: [
      {
        question: 'Who can share a notebook?',
        choices: ['The owner only', 'Anyone'],
        recommended: 'The owner only',
      },
      { question: 'Where are people told?', recommended: 'In the app only' },
    ],
  }
  const rounds = await sameAnswer(
    { kind: 'round', title: 'Who can share', body: 'Two questions.', round },
    'A round',
    { action: 'answer-round', answers: [{ answer: 'Anyone' }, { answer: 'By email' }] },
    { action: 'answer-round', answers: [{ answer: 'Anyone' }, { answer: 'By email' }] },
  )
  expect(store.getComment(rounds.pocket.id)?.answer).toMatchObject({
    kind: 'answered',
    answers: [expect.objectContaining({ answer: 'Anyone' }), expect.objectContaining({})],
  })
  await sameAnswer(
    {
      kind: 'question',
      title: 'The Task Lead stopped without saying why',
      body: 'The Task Lead ended its turn without a question or outcome.',
      purpose: { kind: 'idle-run' },
      choices: ['Nudge again', 'Restart from the brief'],
    },
    'Ted’s idle ask',
    { action: 'answer', choice: 'Nudge again' },
    { action: 'answer', choice: 'Nudge again' },
  )

  const proposal = {
    rows: [
      {
        title: 'Notebook owners',
        scope: 'Give every notebook an owner.',
        priority: 'high' as const,
        blockedBy: [],
      },
      {
        title: 'Share dialog',
        scope: 'Let the owner share.',
        priority: 'none' as const,
        blockedBy: [1],
      },
    ],
  }
  const split = await twins(
    { kind: 'proposal', title: 'Sharing, in two Tasks', body: 'Owners first.', proposal },
    'A split',
  )
  expect(await opened(split.pocket.id)).toMatchObject({
    form: {
      type: 'proposal',
      title: 'Sharing, in two Tasks',
      summary: 'Owners first.',
      rows: [
        {
          title: 'Notebook owners',
          scope: 'Give every notebook an owner.',
          priority: 'high',
          blockedBy: [],
        },
        { title: 'Share dialog', scope: 'Let the owner share.', priority: 'none', blockedBy: [1] },
      ],
    },
  })
  await client.answerRequest(split.desk.id, {
    action: 'approve',
    proposal: { skip: [], startUnblocked: false },
  })
  expect(await phone.answer(split.pocket.id, { action: 'approve' })).toMatchObject({ ok: true })
  const created = (id: string) => {
    const answer = store.getComment(id)?.answer
    return answer?.kind === 'approved'
      ? {
          rows: answer.created?.tasks.map((t) => t.row),
          skipped: answer.created?.skipped,
          startUnblocked: answer.created?.startUnblocked,
        }
      : undefined
  }
  expect(created(split.pocket.id)).toEqual({ rows: [1, 2], skipped: [], startUnblocked: false })
  expect(created(split.pocket.id)).toEqual(created(split.desk.id))

  const archive = await twins(
    {
      kind: 'question',
      body: 'This Task is done elsewhere.',
      archive: { reason: 'Done elsewhere' },
      choices: ['Archive', 'Keep it'],
    },
    'An archive ask',
  )
  expect((await opened(archive.pocket.id)).onPhone).toBe(true)
  await client.answerRequest(archive.desk.id, {
    action: 'answer',
    choice: 'Archive',
    archive: { closePullRequests: false },
  })
  expect(
    await phone.answer(archive.pocket.id, { action: 'answer', choice: 'Archive' }),
  ).toMatchObject({ ok: true })
  for (const task of [archive.deskTask, archive.pocketTask]) {
    await waitUntil(() => store.getTask(task.id)?.archived, `${task.displayId} to be archived`)
  }
  expect(answerOf(archive.pocket.id)).toEqual(answerOf(archive.desk.id))
}, 60_000)

test('a move request stays on the Mac, and the phone can’t answer it', async () => {
  const task = await newTask('Mac-only requests')
  const move = ask(task.id, {
    kind: 'question',
    title: 'Move to another Factory?',
    body: 'This belongs elsewhere.',
    choices: ['Move', 'Keep it'],
    move: { factoryId: factory.id, reason: 'Wrong repo', askedBy: 'task-lead' },
  })
  expect((await listed()).requests.find((r) => r.id === move.id)?.onPhone).toBe(false)
  expect((await opened(move.id)).form).toMatchObject({ type: 'mac', reason: expect.any(String) })
  expect(failure(await phone.answer(move.id, { action: 'answer', choice: 'Keep it' }))).toBe(
    'answer-on-mac',
  )
  expect(store.getComment(move.id)?.answer).toBeUndefined()
})

async function attach(name: string, bytes: Buffer, mediaType = 'image/png'): Promise<Attachment> {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const dir = tedPaths(home).attachments
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${hash}${path.extname(name)}`), bytes)
  return { hash, name, size: bytes.length, mediaType }
}

function image(id: string, part: number) {
  return phone.send({ type: 'request', route: 'image', image: id, part })
}

async function sameOutcome(
  request: Omit<NewComment, 'taskId' | 'author'>,
  title: string,
  desktop: AnswerRequest,
  fromPhone: PhoneAnswer,
) {
  const pair = await twins(request, title)
  expect((await opened(pair.pocket.id)).onPhone, title).toBe(true)
  const desk = await client.answerRequest(pair.desk.id, desktop).then(
    () => undefined,
    (error: Error) => error.message,
  )
  const reply = await phone.answer(pair.pocket.id, fromPhone)
  if (desk === undefined) {
    expect(reply, title).toMatchObject({ ok: true, body: { answered: true } })
    expect(answerOf(pair.pocket.id), title).toEqual(answerOf(pair.desk.id))
  } else {
    expect(failure(reply), `${title}: ${desk}`).toBe('refused')
    expect(store.getComment(pair.pocket.id)?.answer, title).toBeUndefined()
  }
  return pair
}

test('a design review opens on the phone with its design, setup and images, and is answered as on the Mac', async () => {
  const shot = await attach('step-1.png', randomBytes(2_000))
  const prototype = await attach('onboarding.html', Buffer.from('<html></html>'), 'text/html')
  const extra = await attach('extra.png', randomBytes(1_000))
  const notes = await attach('notes.txt', Buffer.from('notes'), 'text/plain')
  const task = await newTask('Onboarding design')
  store.writeBrief({ taskId: task.id, text: '## Goal\n\nA friendlier start.' })
  const review = ask(task.id, {
    kind: 'review',
    title: 'Design review',
    body: 'Onboarding\n\nThree steps.',
    gate: { approveLabel: 'Approve' },
    attachments: [shot, prototype, extra, notes],
    design: {
      summary: 'Three steps.',
      worthYourEye: ['The skip link'],
      screenshots: [{ hash: shot.hash, name: shot.name, caption: 'Step 1 · Welcome' }],
      prototype: { hash: prototype.hash, name: prototype.name },
      figma: { url: 'https://www.figma.com/design/abc', label: 'Onboarding v2' },
      setup: {
        workflow: [{ stage: 'clarify', setting: 'few questions' }],
        checks: [{ name: 'Tests', command: 'pnpm test', passed: false, durationMs: 41_400 }],
        apps: [],
        agents: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            about: 'Reads the diff',
            powers: [],
            instructions: 'Read it.',
          },
        ],
        worktree: [{ repo: 'app', step: 'setup', sandboxAccess: ['network'] }],
        files: [{ path: '.ted/workflow.yaml', about: 'The Workflow' }],
      },
    },
  })
  expect((await listed()).requests.find((r) => r.id === review.id)).toMatchObject({
    kind: 'review',
    onPhone: true,
  })
  const shown = await opened(review.id)
  expect(shown).toMatchObject({
    kind: 'review',
    onPhone: true,
    cut: false,
    attachments: 1,
    images: [{ image: phoneImageId(review.id, extra.hash), caption: 'extra.png' }],
    form: {
      type: 'design',
      stage: expect.any(String),
      brief: '## Goal\n\nA friendlier start.',
      cut: false,
      design: {
        summary: 'Three steps.',
        worthYourEye: ['The skip link'],
        screenshots: [{ image: phoneImageId(review.id, shot.hash), caption: 'Step 1 · Welcome' }],
        figma: { url: 'https://www.figma.com/design/abc', label: 'Onboarding v2' },
        prototype: { name: 'onboarding.html' },
      },
    },
  })
  expect(shown.form.type === 'design' && shown.form.design.setup).toEqual({
    workflow: [{ stage: 'Clarify', setting: 'few questions' }],
    checks: [{ name: 'Tests', command: 'pnpm test', passed: false, seconds: 41 }],
    agents: [{ name: 'Reviewer', about: 'Reads the diff' }],
    worktree: [{ repo: 'app', step: 'setup', access: ['network'] }],
    files: [{ path: '.ted/workflow.yaml', about: 'The Workflow' }],
  })
  const screenshot = shown.form.type === 'design' ? shown.form.design.screenshots?.[0] : undefined
  const reply = await image(screenshot?.image ?? '', 0)
  expect(reply.ok && parsePhoneImageBody(reply.body)).toMatchObject({ parts: 1, part: 0 })

  const design = { summary: 'Plain.', worthYourEye: ['Colours'] }
  await sameOutcome(
    {
      kind: 'review',
      title: 'Design review',
      body: 'Plain.',
      gate: { approveLabel: 'Approve' },
      design,
    },
    'A design review sent back',
    { action: 'request-changes', text: 'Bigger buttons' },
    { action: 'request-changes', text: 'Bigger buttons' },
  )
  await sameOutcome(
    {
      kind: 'review',
      title: 'Design review',
      body: 'Plain.',
      gate: { approveLabel: 'Approve' },
      design,
    },
    'A design review approved',
    { action: 'approve' },
    { action: 'approve' },
  )
  await sameOutcome(
    {
      kind: 'review',
      title: 'Setup proposal',
      body: 'Setup.',
      gate: { approveLabel: 'Approve' },
      design: {
        setup: {
          workflow: [],
          checks: [],
          apps: [],
          files: [],
          agents: [
            { id: 'reviewer', name: 'Reviewer', about: 'Reads', powers: [], instructions: 'Read.' },
          ],
        },
      },
    },
    'A Setup proposal approved',
    { action: 'approve' },
    { action: 'approve' },
  )
}, 60_000)

test('a design review too long for one reply cuts the brief, then the points worth your eye, then the summary', async () => {
  const line = 'Look closely at the spacing between the cards. '
  const task = await newTask('A long design')
  store.writeBrief({ taskId: task.id, text: `## Goal\n\n${line.repeat(1_000)}` })
  const review = (design: NonNullable<NewComment['design']>) =>
    ask(task.id, {
      kind: 'review',
      title: 'Design review',
      body: 'Short.',
      gate: { approveLabel: 'Approve' },
      design,
    })
  const fits = async (id: string) => {
    const reply = await phone.request(id)
    expect(Buffer.byteLength(JSON.stringify(reply.ok && reply.body))).toBeLessThanOrEqual(
      phoneReplyBodyMax,
    )
    const shown = await opened(id)
    if (shown.form.type !== 'design') throw new Error(`form is ${shown.form.type}`)
    return shown.form
  }

  const briefOnly = await fits(
    review({
      summary: 'Small.',
      worthYourEye: ['One point'],
      screenshots: [{ hash: 'a'.repeat(64), name: 'wide.png' }],
    }).id,
  )
  expect(briefOnly.cut).toBe(true)
  expect(briefOnly.brief.length).toBeGreaterThan(0)
  expect(briefOnly.design).toEqual({
    summary: 'Small.',
    worthYourEye: ['One point'],
    moreScreenshots: 1,
  })

  const points = Array.from({ length: 1_200 }, (_, n) => `${n}. ${line}`)
  const manyPoints = await fits(review({ summary: 'Small.', worthYourEye: points }).id)
  expect(manyPoints).toMatchObject({ cut: true, brief: '', design: { summary: 'Small.' } })
  expect(manyPoints.design.worthYourEye?.length).toBeGreaterThan(0)
  expect(manyPoints.design.worthYourEye?.length).toBeLessThan(points.length)
  expect(manyPoints.design.worthYourEye?.[0]).toBe(points[0])

  const summary = line.repeat(1_200)
  const all = await fits(review({ summary, worthYourEye: points }).id)
  expect(all).toMatchObject({ cut: true, brief: '' })
  expect(all.design.worthYourEye).toBeUndefined()
  expect(all.design.summary?.length).toBeGreaterThan(0)
  expect(summary.startsWith(all.design.summary ?? 'x')).toBe(true)
})

test.each(['request', 'design'])('a long %s image list fits after its text', async (kind) => {
  const task = await newTask('Long image list')
  const attachments = Array.from({ length: 300 }, (_, n) => ({
    hash: n.toString(16).padStart(64, '0'),
    name: `${n}-${'漢"😀'.repeat(60)}.png`,
    size: 10,
    mediaType: 'image/png',
  }))
  const body = 'Keep this whole. '.repeat(400)
  const design = {
    summary: 'Before and after.',
    screenshots: attachments.map(({ hash, name }) => ({ hash, name, caption: name })),
  }
  const request = ask(task.id, {
    body,
    attachments,
    ...(kind === 'design'
      ? { kind: 'review', title: 'Design review', gate: { approveLabel: 'Approve' }, design }
      : { kind: 'question', choices: ['Yes', 'No'] }),
  })
  const reply = await phone.request(request.id)
  if (!reply.ok) throw new Error(`request failed: ${reply.error.code}`)
  expect(Buffer.byteLength(JSON.stringify(reply.body))).toBeLessThanOrEqual(phoneReplyBodyMax)
  const shown = parsePhoneRequestBody(reply.body).request
  expect(shown).toMatchObject({ body, cut: false, attachments: 0 })
  if (kind === 'design' && shown.form.type !== 'design') {
    throw new Error(`expected design, got ${shown.form.type}`)
  }
  const review = shown.form.type === 'design' ? shown.form.design : undefined
  if (review) expect(review.summary).toBe(design.summary)
  const images = (review ? review.screenshots : shown.images) ?? []
  expect(images.length).toBeGreaterThan(0)
  expect(images.length).toBeLessThan(attachments.length)
  expect(review ? review.moreScreenshots : shown.moreImages).toBe(
    attachments.length - images.length,
  )
  expect(images.map((image) => image.image)).toEqual(
    attachments.slice(0, images.length).map(({ hash }) => phoneImageId(request.id, hash)),
  )
  expect(images.map((image) => image.caption)).toEqual(
    attachments.slice(0, images.length).map(({ name }) => name),
  )
})

test('a request’s image attachments load through the image route in parts, and nothing else does', async () => {
  const big = randomBytes(phoneImagePartBytes * 2 + 500)
  const photo = await attach('before.png', big)
  const broken = await attach('broken.png', Buffer.from('broken image'))
  const notes = await attach('notes.txt', Buffer.from('notes'), 'text/plain')
  const task = await newTask('Pictures')
  const question = ask(task.id, {
    kind: 'question',
    body: 'Which looks better?',
    choices: ['Before', 'After'],
    attachments: [photo, broken, notes],
  })
  const shown = await opened(question.id)
  expect(shown).toMatchObject({
    attachments: 1,
    images: [
      { image: expect.any(String), caption: 'before.png' },
      { image: expect.any(String), caption: 'broken.png' },
    ],
  })
  const [first, second] = shown.images ?? []
  const id = first?.image ?? ''
  expect(id.length).toBeLessThanOrEqual(200)

  const before = shrunk.length
  const [zero, one] = await Promise.all([image(id, 0), image(id, 1)])
  expect(shrunk.length - before).toBe(1)
  const two = await image(id, 2)
  const bodies = [zero, one, two].map((reply) => {
    if (!reply.ok) throw new Error(`image failed: ${reply.error.code}`)
    expect(Buffer.byteLength(JSON.stringify(reply.body))).toBeLessThanOrEqual(phoneReplyBodyMax)
    return parsePhoneImageBody(reply.body)
  })
  expect(bodies.map((body) => [body.mediaType, body.parts, body.part])).toEqual([
    ['image/jpeg', 3, 0],
    ['image/jpeg', 3, 1],
    ['image/jpeg', 3, 2],
  ])
  expect(Buffer.concat(bodies.map((body) => Buffer.from(body.data, 'base64url')))).toEqual(big)
  expect(shrunk.length - before).toBe(1)

  expect(failure(await image(id, 3))).toBe('bad-request')
  expect(failure(await phone.send({ type: 'request', route: 'image', image: id, part: -1 }))).toBe(
    'bad-request',
  )
  expect(await image(second?.image ?? '', 0)).toMatchObject({
    ok: false,
    error: {
      code: 'refused',
      message: 'This image can’t be shown on your phone. Open it on your Mac.',
    },
  })

  const other = ask(task.id, { kind: 'note', body: 'Unrelated' })
  for (const unknown of [
    'nope',
    phoneImageId(other.id, photo.hash) ?? '',
    phoneImageId(question.id, notes.hash) ?? '',
    phoneImageId(question.id, 'a'.repeat(64)) ?? '',
  ]) {
    expect(failure(await image(unknown, 0)), unknown).toBe('gone')
  }
  store.archiveTask(task.id)
  expect(failure(await image(id, 0))).toBe('gone')
})

test('a request answered on the Mac is gone for the phone, and a refused answer says why', async () => {
  const task = await newTask('Answered twice')
  const question = ask(task.id, {
    kind: 'question',
    body: 'Red or blue?',
    choices: ['Red', 'Blue'],
  })
  await client.answerRequest(question.id, { action: 'answer', choice: 'Red' })
  expect(failure(await phone.answer(question.id, { action: 'answer', choice: 'Blue' }))).toBe(
    'gone',
  )
  expect(failure(await phone.request(question.id))).toBe('gone')
  expect(answerOf(question.id)).toMatchObject({ choice: 'Red' })

  const other = ask(task.id, { kind: 'question', body: 'Big or small?', choices: ['Big', 'Small'] })
  const refused = await phone.answer(other.id, { action: 'answer', choice: 'Medium' })
  expect(refused).toMatchObject({
    ok: false,
    error: { code: 'refused', message: expect.stringContaining('Medium') },
  })
  expect(store.getComment(other.id)?.answer).toBeUndefined()
  expect(failure(await phone.request('no-such-request'))).toBe('gone')
})

test('a proposal too long for the relay opens on the phone as Answer on your Mac', async () => {
  const task = await newTask('A long split')
  const summary = `${'Each notebook gets an owner who decides who can see it. '.repeat(1200)}End.`
  const huge = ask(task.id, {
    kind: 'proposal',
    title: 'Sharing, in one Task',
    body: summary,
    proposal: {
      rows: [
        {
          title: 'Notebook owners',
          scope: 'Give every notebook an owner.',
          priority: 'high',
          blockedBy: [],
        },
      ],
    },
  })
  expect(Buffer.byteLength(summary)).toBeGreaterThan(phoneReplyBodyMax)
  const reply = await phone.request(huge.id)
  expect(reply.ok).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(reply.ok && reply.body))).toBeLessThanOrEqual(
    phoneReplyBodyMax,
  )
  expect(await opened(huge.id)).toMatchObject({
    form: { type: 'mac', reason: expect.stringContaining('too long') },
  })
})

test('a phone key that isn’t paired gets not-paired on the Inbox routes', async () => {
  const stranger = new TestPhone(encodePairingLink(phone.link))
  expect(failure(await stranger.requests(phone))).toBe('not-paired')
  expect(failure(await stranger.answer('any', { action: 'approve' }, phone))).toBe('not-paired')
})

test('a Run’s permission request is approved from the phone as from the desktop', async () => {
  const bash = (command: string) => ({
    permission: { tool: 'Bash', input: { command, description: 'Run it' }, description: 'Run it' },
  })
  const start = async () => {
    const task = await ok<Task>('POST', '/tasks', {
      title: steps(bash('npm test -- --run phone'), { endTurn: true }),
      factory: 'NB',
    })
    await ok('POST', `/tasks/${task.id}/start`)
    return waitUntil(
      async () =>
        (await ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
          (c) => c.kind === 'permission' && c.answer === undefined,
        ),
      'a permission request',
      30_000,
    )
  }
  const desk = await start()
  const pocket = await start()
  expect(await opened(pocket.id)).toMatchObject({
    kind: 'permission',
    onPhone: true,
    form: { type: 'permission', command: 'npm test -- --run phone', cut: false },
  })
  await client.answerRequest(desk.id, { action: 'approve' })
  expect(await phone.answer(pocket.id, { action: 'approve' })).toMatchObject({ ok: true })
  expect(answerOf(pocket.id)).toEqual(answerOf(desk.id))
  expect(answerOf(pocket.id)).toMatchObject({ kind: 'approved' })
}, 90_000)

test('a planning chat’s round and an Automation’s question are answered from the phone', async () => {
  const roundFile = path.join(scratch, 'round.json')
  await writeFile(
    roundFile,
    JSON.stringify({
      title: 'Who can share',
      questions: [
        {
          question: 'Who can share a notebook?',
          choices: ['The owner only', 'Anyone'],
          recommended: 'The owner only',
        },
        { question: 'Where are people told?', recommended: 'In the app only' },
      ],
    }),
  )
  const planRound = async (message: string) => {
    const plan = await ok<Plan>('POST', '/plans', {
      factory: 'NB',
      message: `${message}\n${steps({ run: ['ted', 'ask', '--round', roundFile] }, { endTurn: true })}`,
    })
    return waitUntil(
      async () =>
        (await ok<PlanDetail>('GET', `/plans/${plan.id}`)).requests.find(
          (r) => r.kind === 'round' && r.answer === undefined,
        ),
      'the plan’s round',
      30_000,
    )
  }
  const deskRound = await planRound('Plan sharing on the Mac')
  const pocketRound = await planRound('Plan sharing on the phone')
  const detail = await opened(pocketRound.id)
  expect(detail).toMatchObject({
    source: 'plan',
    kind: 'round',
    title: 'Plan sharing on the phone',
    onPhone: true,
    form: {
      type: 'round',
      questions: [
        {
          question: 'Who can share a notebook?',
          choices: ['The owner only', 'Anyone'],
          recommended: 'The owner only',
        },
        { question: 'Where are people told?', recommended: 'In the app only' },
      ],
    },
  })
  const answers = [{ answer: 'Anyone' }, { answer: 'By email' }]
  await client.answerPlanRequest(deskRound.id, { action: 'answer-round', answers })
  expect(await phone.answer(pocketRound.id, { action: 'answer-round', answers })).toMatchObject({
    ok: true,
  })
  const planAnswer = async (planId: string, id: string) => {
    const found = (await ok<PlanDetail>('GET', `/plans/${planId}`)).requests.find(
      (r) => r.id === id,
    )
    const { at: _, ...rest } = found?.answer ?? { at: '' }
    return rest
  }
  expect(await planAnswer(pocketRound.planId, pocketRound.id)).toEqual(
    await planAnswer(deskRound.planId, deskRound.id),
  )
  expect(await planAnswer(pocketRound.planId, pocketRound.id)).toMatchObject({ kind: 'answered' })

  const question = async (name: string) => {
    const automation = await ok<Automation>('POST', '/automations', {
      name,
      factory: 'NB',
      schedule: { kind: 'daily', at: '09:00' },
      prompt: steps(
        { everyMessage: [{ say: 'Got it' }, { endTurn: true }] },
        { run: ['ted', 'comment', '--choice', 'Yes', '--choice', 'No', 'Create NB tasks?'] },
        { endTurn: true },
      ),
    })
    await ok('POST', `/automations/${automation.id}/run`)
    return waitUntil(
      async () =>
        (await ok<AutomationDetail>('GET', `/automations/${automation.id}`)).requests.find(
          (r) => r.kind === 'question' && r.answer === undefined,
        ),
      'the Automation’s question',
      30_000,
    )
  }
  const deskQuestion = await question('Asks on the Mac')
  const pocketQuestion = await question('Asks on the phone')
  expect(await opened(pocketQuestion.id)).toMatchObject({
    source: 'automation',
    kind: 'question',
    title: 'Asks on the phone',
    body: 'Create NB tasks?',
    form: { type: 'choices', choices: ['Yes', 'No'], multiple: false, text: true },
  })
  await client.answerAutomationRequest(deskQuestion.id, { choice: 'No', text: 'Not today' })
  expect(
    await phone.answer(pocketQuestion.id, { action: 'answer', choice: 'No', text: 'Not today' }),
  ).toMatchObject({ ok: true })
  const automationAnswer = (id: string) => store.automations.comment(id)?.answer?.text
  expect(automationAnswer(pocketQuestion.id)).toBe('No\n\nNot today')
  expect(automationAnswer(pocketQuestion.id)).toBe(automationAnswer(deskQuestion.id))
}, 120_000)

test('a phone registers its push token and gets one notification per request while the user is away', async () => {
  const pushPhone = await pairedPhone('Push Phone')
  const phoneId = store.phones.byKey(pushPhone.publicKey())?.id ?? ''
  const token = 'ExponentPushToken[push-phone_1]'

  for (const bad of ['', 'abc', 'ExponentPushToken[]', `ExponentPushToken[${'a'.repeat(201)}]`]) {
    expect(
      failure(await pushPhone.send({ type: 'request', route: 'push-token', token: bad })),
      bad,
    ).toBe('bad-request')
  }
  expect(failure(await pushPhone.send({ type: 'request', route: 'push-token' }))).toBe(
    'bad-request',
  )
  expect(store.phones.pushToken(phoneId)).toBeUndefined()

  expect(await client.reportPresence({ away: false })).toEqual({ away: false })
  expect(await pushPhone.send({ type: 'request', route: 'push-token', token })).toMatchObject({
    ok: true,
    body: {},
  })
  expect(store.phones.pushToken(phoneId)).toBe(token)
  expect(store.phones.pushToken(store.phones.byKey(phone.publicKey())?.id ?? '')).toBeUndefined()

  const task = await newTask('Notify me')
  const asked = ask(task.id, { kind: 'question', body: 'Ship the beta?' })
  await waitUntil(
    async () => (await client.listWaiting()).some((r) => r.id === asked.id),
    'the request in the Inbox',
  )
  expect(pushed.filter((message) => message.requestId === asked.id)).toEqual([])

  expect(await client.reportPresence({ away: true })).toEqual({ away: true })
  await expect
    .poll(() => pushed.filter((message) => message.requestId === asked.id))
    .toEqual([{ to: token, title: 'Notify me', body: 'Ship the beta?', requestId: asked.id }])
  expect(await opened(asked.id)).toMatchObject({ id: asked.id, title: 'Notify me' })
  expect(
    (await pushPhone.request(asked.id)).ok,
    'the notification’s requestId opens the request',
  ).toBe(true)

  await client.removePhone(phoneId)
  expect(store.phones.pushToken(phoneId)).toBeUndefined()
  await client.reportPresence({ away: false })
})

test('a planning chat that saves a phone answer but can’t resume says the answer was saved', async () => {
  const roundFile = path.join(scratch, 'saved-round.json')
  await writeFile(
    roundFile,
    JSON.stringify({
      title: 'Who can export',
      questions: [{ question: 'Who can export a notebook?', recommended: 'The owner only' }],
    }),
  )
  const plan = await ok<Plan>('POST', '/plans', {
    factory: 'NB',
    message: `Plan exports\n${steps({ run: ['ted', 'ask', '--round', roundFile] }, { endTurn: true })}`,
  })
  const asked = await waitUntil(
    async () =>
      (await ok<PlanDetail>('GET', `/plans/${plan.id}`)).requests.find(
        (r) => r.kind === 'round' && r.answer === undefined,
      ),
    'the plan’s round',
    30_000,
  )
  expect(await ok<Plan>('POST', `/plans/${plan.id}/stop`)).toMatchObject({ canResume: true })
  store.holdNewWork('test disk full')
  try {
    const reply = await phone.answer(asked.id, {
      action: 'answer-round',
      answers: [{ answer: 'Anyone' }],
    })
    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        message: expect.stringContaining('Your answer is saved, but the planner couldn’t resume'),
      },
    })
  } finally {
    store.holdNewWork(undefined)
  }
  const saved = (await ok<PlanDetail>('GET', `/plans/${plan.id}`)).requests.find(
    (r) => r.id === asked.id,
  )
  expect(saved?.answer).toMatchObject({ kind: 'answered' })
  expect(failure(await phone.answer(asked.id, { action: 'answer-round', answers: [] }))).toBe(
    'gone',
  )
}, 90_000)

test('the phone lists current stops-work problems, redacted, and never warnings', async () => {
  const problems = async () => {
    const reply = await phone.send({ type: 'request', route: 'problems' })
    if (!reply.ok) throw new Error(`problems failed: ${reply.error.code}`)
    return parsePhoneProblemsBody(reply.body).problems
  }
  const stops = store.raiseBanner({
    id: `phone-test-clone:${factory.id}`,
    problem: 'phone-test-clone',
    severity: 'stops-work',
    factoryId: factory.id,
    text: 'Couldn’t clone https://user:hunter2@example.com/acme/notes.git',
  })
  const disk = store.raiseBanner({
    id: 'phone-test-stop:app',
    problem: 'phone-test-stop',
    severity: 'stops-work',
    text: 'Disk full · new work held',
  })
  store.raiseBanner({
    id: 'phone-test-warning:app',
    problem: 'phone-test-warning',
    severity: 'warning',
    text: 'Disk almost full',
  })

  const listedProblems = await problems()
  expect(listedProblems.map((problem) => problem.id).sort()).toEqual([disk.id, stops.id].sort())
  expect(listedProblems.find((problem) => problem.id === disk.id)).toEqual({
    id: disk.id,
    text: 'Disk full · new work held',
    raisedAt: disk.raisedAt,
    dismissible: true,
  })
  const clone = listedProblems.find((problem) => problem.id === stops.id)
  expect(clone?.factory).toBe(factory.name)
  expect(clone?.text).toContain('https://[redacted]@example.com')
  expect(clone?.text).not.toContain('hunter2')

  const dismissed = await phone.send({
    type: 'request',
    route: 'problem-dismiss',
    problemId: disk.id,
    raisedAt: disk.raisedAt,
  })
  expect(dismissed.ok).toBe(true)
  expect((await problems()).map((problem) => problem.id)).toEqual([stops.id])
  expect(store.getBanner(disk.id)?.dismissed).toBe(true)

  store.clearBanner(stops.id)
  store.clearBanner(disk.id)
  store.clearBanner('phone-test-warning:app')
  expect(await problems()).toEqual([])
})

test('the phone problems reply fits the reply size limit and keeps the first problems', () => {
  const wide = '\u{1d11e}'.repeat(phoneProblemTextMax + 10)
  const banners: Banner[] = Array.from({ length: phoneProblemsMax }, (_, index) => ({
    id: `wide-${index}:factory`,
    problem: 'phone-test-wide',
    severity: 'stops-work',
    factoryId: 'factory',
    text: wide,
    raisedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, phoneProblemsMax - index)).toISOString(),
  }))
  const body = phoneProblems({
    banners: () => [...banners].reverse(),
    factoryName: () => 'F'.repeat(phoneProblemFactoryMax * 2),
  })
  const bytes = (problems: PhoneProblemsBody['problems']) =>
    Buffer.byteLength(JSON.stringify({ problems }), 'utf8')
  expect(bytes(body.problems)).toBeLessThanOrEqual(phoneReplyBodyMax)
  expect(body.problems.length).toBeGreaterThan(0)
  expect(body.problems.length).toBeLessThan(banners.length)
  expect(body.problems.map((problem) => problem.id)).toEqual(
    banners.slice(0, body.problems.length).map((banner) => banner.id),
  )
  const [first] = body.problems
  if (first === undefined) throw new Error('no problems listed')
  const next = { ...first, id: `wide-${body.problems.length}:factory` }
  expect(bytes([...body.problems, next])).toBeGreaterThan(phoneReplyBodyMax)
  expect([...(first.factory ?? '')]).toHaveLength(phoneProblemFactoryMax)
})
