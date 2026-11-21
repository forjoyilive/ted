import { expect, test } from 'vitest'
import {
  type PhoneAnswerSubject,
  type PhoneForm,
  type PhoneRequestDetail,
  type PhoneRequestSummary,
  parsePhoneAnswer,
  parsePhoneAnsweredBody,
  parsePhoneForm,
  parsePhoneRequestBody,
  parsePhoneRequestDetail,
  parsePhoneRequestSummary,
  parsePhoneRequestsBody,
  phoneAnswerability,
  phoneRequestKinds,
  phoneRequestSources,
} from '../src/phone-requests.ts'

const summary: PhoneRequestSummary = {
  id: 'c-1',
  source: 'task',
  kind: 'question',
  factory: 'Ted',
  factoryId: 'f-ted',
  factoryIcon: { kind: 'symbol', symbol: 'code', color: 'blue' },
  title: 'List and answer Inbox requests on the phone',
  ref: 'TED-700',
  headline: 'Which repo should hold the parser?',
  createdAt: '2026-11-19T18:22:53.000Z',
  failed: true,
  onPhone: true,
  task: { id: 't-1', priority: 'high', actions: ['stop', 'priority', 'archive', 'delete'] },
}

test('the phone parses approval answers and the identity of a running command', () => {
  for (const answer of [
    {
      action: 'confirm-tasks',
      decision: 'confirm',
      chatId: 'chat-1',
      revision: 'reviewed',
      choices: { 'task-1': { children: 'detach', closePullRequests: false } },
    },
    { action: 'approve-command', decision: 'always', chatId: 'chat-1', revision: 'reviewed' },
    { action: 'stop-command', chatId: 'chat-1' },
  ])
    expect(parsePhoneAnswer(answer)).toEqual(answer)
  expect(() =>
    parsePhoneAnswer({ action: 'approve-command', decision: 'always', chatId: 'chat-1' }),
  ).toThrow()
})

const forms: PhoneForm[] = [
  {
    type: 'approval',
    approval: {
      kind: 'confirmation',
      operation: 'archive',
      chatId: 'chat-1',
      title: 'Archive TED-1?',
      warnings: ['This stops its Run.'],
      revision: 'reviewed',
      decision: 'confirm',
      refusal: 'This changed.',
      tasks: [
        {
          id: 'task-1',
          label: 'TED-1 · Archive it',
          working: true,
          descendants: ['TED-2'],
          blocked: ['TED-3'],
          blockedTogether: ['TED-4'],
          pullRequests: ['ted #12'],
          children: 'detach',
          closePullRequests: true,
          result: 'Archived.',
        },
      ],
    },
  },
  {
    type: 'approval',
    approval: {
      kind: 'outside-command',
      chatId: 'chat-1',
      title: 'Run release?',
      warnings: ['The folder changed.'],
      command: 'pnpm release 1.0.0',
      argument: '1.0.0',
      repo: 'ted',
      folder: '/example/ted',
      runLabel: 'Run',
      canAlways: true,
      revision: 'reviewed',
      result: 'Approved',
    },
  },
  { type: 'choices', choices: ['Yes', 'No'], multiple: false, text: true },
  { type: 'text' },
  {
    type: 'round',
    questions: [
      {
        question: 'Who can share?',
        choices: ['Owner', 'Anyone'],
        multiple: true,
        recommended: 'Owner',
        recommendedChoices: ['Owner'],
      },
      { question: 'Where are people told?', recommended: 'In the app' },
    ],
  },
  { type: 'permission', command: 'rm -rf build', cut: false },
  { type: 'signoff', stage: 'Review', brief: '## Goal\n\nShip it.', cut: true },
  {
    type: 'design',
    stage: 'Design',
    brief: '## Goal\n\nOnboarding.',
    cut: false,
    design: {
      summary: 'Three steps.',
      worthYourEye: ['The skip link', 'Dark mode'],
      screenshots: [{ image: 'aW1n', caption: 'Step 1 · Welcome' }, { image: 'aW1o' }],
      figma: { url: 'https://www.figma.com/design/x', label: 'Onboarding v2' },
      prototype: { name: 'onboarding.html', caption: 'Click through' },
      video: { name: 'flow.mov' },
      setup: {
        workflow: [{ stage: 'Clarify', setting: 'few questions' }, { stage: 'Work' }],
        checks: [
          {
            name: 'Tests',
            command: 'pnpm test',
            repo: 'app',
            passed: false,
            seconds: 41,
            reason: 'One failed',
          },
          { name: 'Lint', command: 'pnpm lint', passed: true, seconds: 3 },
        ],
        apps: [
          { name: 'Web', kind: 'web', run: 'pnpm dev', repo: 'app', passed: true, reason: 'Up' },
          { name: 'CLI', kind: 'command', passed: false },
        ],
        agents: [{ name: 'Reviewer', about: 'Reads the diff' }],
        worktree: [
          { repo: 'app', step: 'setup', access: ['network'] },
          { step: 'teardown', access: [] },
        ],
        files: [{ path: '.ted/workflow.yaml', about: 'The Workflow' }],
        defaults: 'Stages as they are.',
      },
    },
  },
  { type: 'design', stage: 'Design', brief: '', cut: true, design: {} },
  {
    type: 'proposal',
    title: 'Sharing, in two Tasks',
    summary: 'Owners first.',
    rows: [
      { title: 'Owners', scope: 'Give notebooks owners.', priority: 'high', blockedBy: [] },
      { title: 'Share dialog', scope: 'Let owners share.', priority: 'none', blockedBy: [1] },
    ],
  },
  { type: 'mac', reason: 'Answer this on your Mac.' },
]

const detail: PhoneRequestDetail = {
  ...summary,
  body: 'Pick **one**.',
  cut: false,
  attachments: 2,
  form: forms[0] ?? { type: 'text' },
}

test('a summary keeps every field, and ref, failed, factoryIcon and task only when given', () => {
  expect(parsePhoneRequestSummary(summary)).toEqual(summary)
  const { ref: _, failed: __, factoryIcon: ___, task: ____, ...plain } = summary
  expect(parsePhoneRequestSummary({ ...plain, source: 'plan' })).toEqual({
    ...plain,
    source: 'plan',
  })
  for (const source of phoneRequestSources)
    expect(parsePhoneRequestSummary({ ...summary, source }).source).toBe(source)
  for (const kind of phoneRequestKinds)
    expect(parsePhoneRequestSummary({ ...summary, kind }).kind).toBe(kind)
  for (const [field, value] of [
    ['id', 1],
    ['source', 'other'],
    ['kind', 'note'],
    ['factory', null],
    ['factoryId', undefined],
    ['factoryIcon', { kind: 'letter', color: 'beige' }],
    ['title', 2],
    ['ref', 3],
    ['headline', undefined],
    ['createdAt', 5],
    ['failed', false],
    ['onPhone', 'yes'],
    ['task', 'TED-700'],
    ['task', { priority: 'high', actions: [] }],
    ['task', { id: 't-1', priority: 'soon', actions: [] }],
    ['task', { id: 't-1', priority: 'high', actions: ['fly'] }],
  ] as const) {
    expect(() => parsePhoneRequestSummary({ ...summary, [field]: value }), field).toThrow()
  }
  expect(() => parsePhoneRequestSummary('text')).toThrow()
})

test('every form round-trips, and each refuses a bad field', () => {
  for (const form of forms) expect(parsePhoneForm(form)).toEqual(form)
  for (const bad of [
    { type: 'choices', choices: ['Yes', 2], multiple: false, text: true },
    { type: 'choices', choices: ['Yes'], multiple: 'no', text: true },
    { type: 'choices', choices: ['Yes'], multiple: false },
    { type: 'round', questions: [{ question: 'Q?' }] },
    { type: 'round', questions: [{ question: 'Q?', recommended: 'A', multiple: false }] },
    { type: 'round', questions: 'none' },
    { type: 'permission', command: 'ls' },
    { type: 'signoff', stage: 'Review', brief: 3, cut: false },
    { type: 'design', stage: 'Design', brief: '', cut: false },
    { type: 'design', stage: 'Design', brief: '', cut: false, design: { worthYourEye: [1] } },
    { type: 'design', stage: 'Design', brief: '', cut: false, design: { screenshots: [{}] } },
    { type: 'design', stage: 'Design', brief: '', cut: false, design: { figma: { label: 'x' } } },
    { type: 'design', stage: 'Design', brief: '', cut: false, design: { video: { caption: 'x' } } },
    {
      type: 'design',
      stage: 'Design',
      brief: '',
      cut: false,
      design: { setup: { checks: [{ name: 'T', command: 'c', passed: true, seconds: 1.5 }] } },
    },
    {
      type: 'design',
      stage: 'Design',
      brief: '',
      cut: false,
      design: { setup: { worktree: [{ step: 'later', access: [] }] } },
    },
    { type: 'proposal', title: 'T', summary: 'S', rows: [{ title: 'R', scope: 'S' }] },
    {
      type: 'proposal',
      title: 'T',
      summary: 'S',
      rows: [{ title: 'R', scope: 'S', priority: 'soon', blockedBy: [] }],
    },
    {
      type: 'proposal',
      title: 'T',
      summary: 'S',
      rows: [{ title: 'R', scope: 'S', priority: 'low', blockedBy: [1.5] }],
    },
    { type: 'mac' },
    { type: 'diff' },
  ]) {
    expect(() => parsePhoneForm(bad), JSON.stringify(bad)).toThrow()
  }
})

test('a detail is a summary with body, cut, attachments, images and form', () => {
  expect(parsePhoneRequestDetail(detail)).toEqual(detail)
  const withImages = { ...detail, images: [{ image: 'aW1n', caption: 'sidebar.png' }] }
  expect(parsePhoneRequestDetail(withImages)).toEqual(withImages)
  for (const [field, value] of [
    ['images', [{ caption: 'no id' }]],
    ['images', 'none'],
    ['body', 1],
    ['cut', 'no'],
    ['attachments', 1.5],
    ['form', { type: 'other' }],
    ['onPhone', undefined],
  ] as const) {
    expect(() => parsePhoneRequestDetail({ ...detail, [field]: value }), field).toThrow()
  }
})

test('reply bodies for requests, request and answer', () => {
  const list = { requests: [summary], more: 3 }
  expect(parsePhoneRequestsBody(list)).toEqual(list)
  expect(() => parsePhoneRequestsBody({ requests: [summary] })).toThrow(/more/)
  expect(() => parsePhoneRequestsBody({ requests: 'none', more: 0 })).toThrow(/requests/)
  expect(() => parsePhoneRequestsBody({ requests: [{ id: 'x' }], more: 0 })).toThrow()
  expect(parsePhoneRequestBody({ request: detail })).toEqual({ request: detail })
  expect(() => parsePhoneRequestBody({ request: summary })).toThrow()
  expect(parsePhoneAnsweredBody({ answered: true })).toEqual({ answered: true })
  expect(() => parsePhoneAnsweredBody({ answered: false })).toThrow(/answered/)
  expect(() => parsePhoneAnsweredBody({})).toThrow(/answered/)
})

test('answers keep every field of each action and refuse the rest', () => {
  for (const answer of [
    { action: 'answer', choice: 'Yes' },
    { action: 'answer', choice: 'Yes', text: 'and soon' },
    { action: 'answer', choices: ['A', 'B'], text: 'both' },
    { action: 'answer', choices: [] },
    { action: 'answer', text: 'my own words' },
    { action: 'answer-round', answers: [{ answer: 'Owner', choices: ['Owner'] }, { answer: 'A' }] },
    { action: 'approve' },
    { action: 'deny' },
    { action: 'request-changes', text: 'Bigger button' },
  ]) {
    expect(parsePhoneAnswer(answer), JSON.stringify(answer)).toEqual(answer)
  }
  expect(parsePhoneAnswer({ action: 'approve', text: 'ignored', simulator: 'x' })).toEqual({
    action: 'approve',
  })
  expect(parsePhoneAnswer({ action: 'answer', choice: 'Archive', archive: {} })).toEqual({
    action: 'answer',
    choice: 'Archive',
  })
  for (const bad of [
    { action: 'answer' },
    { action: 'answer', choice: 'A', choices: ['A'] },
    { action: 'answer', choice: 1 },
    { action: 'answer', choices: ['A', 2] },
    { action: 'answer', text: 3 },
    { action: 'answer-round', answers: [{ choices: ['A'] }] },
    { action: 'answer-round', answers: 'A' },
    { action: 'request-changes' },
    { action: 'accept-recommended' },
    { action: 'merge' },
    'approve',
  ]) {
    expect(() => parsePhoneAnswer(bad), JSON.stringify(bad)).toThrow()
  }
})

const task = (
  request: Extract<PhoneAnswerSubject, { source: 'task' }>['request'],
  facts: { tasksUnder?: number; openPullRequests?: number } = {},
): PhoneAnswerSubject => ({
  source: 'task',
  request,
  tasksUnder: facts.tasksUnder ?? 0,
  openPullRequests: facts.openPullRequests ?? 0,
})

test('one list decides which requests the phone may answer, with a reason for the rest', () => {
  const answerable: [string, PhoneAnswerSubject][] = [
    ['question', task({ kind: 'question', purpose: { kind: 'question' } })],
    ['round', task({ kind: 'round', purpose: { kind: 'round' } })],
    ['permission', task({ kind: 'permission', purpose: { kind: 'permission' } })],
    ['signoff', task({ kind: 'signoff', purpose: { kind: 'gate' } })],
    ['proposal', task({ kind: 'proposal', purpose: { kind: 'proposal' } })],
    ['design review', task({ kind: 'review', purpose: { kind: 'gate' } })],
    ['failure decision', task({ kind: 'question', purpose: { kind: 'failure' } })],
    ['failed Run', task({ kind: 'question', purpose: { kind: 'failed-run' } })],
    ['stuck CI', task({ kind: 'question', purpose: { kind: 'ci-stuck' } })],
    ['size check', task({ kind: 'question', purpose: { kind: 'size-check' } })],
    ['idle ask', task({ kind: 'question', purpose: { kind: 'idle-run' } })],
    ['send-back', task({ kind: 'question', purpose: { kind: 'send-back' } })],
    ['memory kill', task({ kind: 'question', purpose: { kind: 'memory-kill' } })],
    ['check report', task({ kind: 'question', purpose: { kind: 'check-report' } })],
    ['cleanup failure', task({ kind: 'question', purpose: { kind: 'cleanup-failure' } })],
    ['tracker closed', task({ kind: 'question', purpose: { kind: 'linear-closed' } })],
    [
      'archive with nothing to choose',
      task({ kind: 'question', purpose: { kind: 'archive' }, archive: { reason: 'Done' } }),
    ],
    ['plan question', { source: 'plan', kind: 'question' }],
    ['chat question', { source: 'chat', kind: 'question' }],
    ['chat round', { source: 'chat', kind: 'round' }],
    ['chat proposal', { source: 'chat', kind: 'proposal' }],
    ['confirmation', { source: 'chat', kind: 'confirmation' }],
    ['outside command', { source: 'chat', kind: 'outside-command' }],
    ['plan round', { source: 'plan', kind: 'round' }],
    ['plan proposal', { source: 'plan', kind: 'proposal' }],
    ['Automation question', { source: 'automation' }],
  ]
  for (const [name, subject] of answerable)
    expect(phoneAnswerability(subject), name).toEqual({ onPhone: true })

  const onMac: [string, PhoneAnswerSubject, RegExp][] = [
    ['simulator', task({ kind: 'permission', purpose: { kind: 'simulator' } }), /simulator/],
    ['move', task({ kind: 'question', purpose: { kind: 'move' } }), /Factory/],
    ['Linear team', task({ kind: 'question', purpose: { kind: 'linear-team' } }), /team/],
    [
      'tracker group',
      task({
        kind: 'question',
        purpose: { kind: 'tracker-group', tracker: 'asana', group: { key: 'k', name: 'n' } },
      }),
      /team/,
    ],
    ['Asana missing', task({ kind: 'question', purpose: { kind: 'asana-missing' } }), /Asana/],
    [
      'Asana unfinished',
      task({ kind: 'question', purpose: { kind: 'asana-unfinished' } }),
      /Asana/,
    ],
    [
      'archive with Tasks under it',
      task(
        { kind: 'question', purpose: { kind: 'archive' }, archive: { reason: 'Done' } },
        { tasksUnder: 1 },
      ),
      /Tasks under it/,
    ],
    [
      'archive with an open pull request',
      task(
        { kind: 'question', purpose: { kind: 'archive' }, archive: { reason: 'Done' } },
        { openPullRequests: 1 },
      ),
      /pull requests/,
    ],
    [
      'round being talked through',
      task({ kind: 'round', purpose: { kind: 'round' }, talkRequested: true }),
      /talked through/,
    ],
    ['note', task({ kind: 'note' }), /Mac/],
    ['plan note', { source: 'plan', kind: 'note' }, /Mac/],
    ['unknown chat request', { source: 'chat' }, /Answer this on your Mac/],
    ['Agent draft', { source: 'chat', kind: 'agent' }, /Review this on your Mac/],
    ['Automation card', { source: 'chat', kind: 'automation' }, /Review this on your Mac/],
  ]
  for (const [name, subject, reason] of onMac) {
    const decided = phoneAnswerability(subject)
    expect(decided.onPhone, name).toBe(false)
    expect(decided.onPhone ? '' : decided.reason, name).toMatch(reason)
  }
})
