import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DaemonClient, Task } from '@ted/protocol'
import { demoTask, until } from './demo.ts'
import { commitDemoTask, demoGit } from './fixtures.ts'

const script = (...steps: unknown[]) => JSON.stringify({ steps })
const idle = { endTurn: true }
const round = {
  title: 'Choose the first release',
  questions: [
    {
      question: 'Which export format should ship first?',
      choices: ['Markdown', 'PDF'],
      recommended: 'Markdown',
    },
  ],
}
const proposal = {
  title: 'Ship sharing in two Tasks',
  tasks: [
    { title: 'Share a read-only link', scope: 'Publish one note with an expiring URL.' },
    { title: 'Manage shared links', scope: 'List and revoke published links.', blockedBy: [1] },
  ],
}

export async function seedScenarios(
  home: string,
  client: DaemonClient,
): Promise<Record<string, string>> {
  const began = Date.now()
  const garden = await client.createFactory({
    name: 'Garden',
    key: 'GD',
    showTutorial: false,
    repos: [
      { name: 'web', source: { remote: 'https://github.com/demo/garden' } },
      { name: 'api', source: { remote: 'https://github.com/demo/garden-api' } },
    ],
  })
  const journal = await client.createFactory({
    name: 'Field Notes',
    key: 'FN',
    showTutorial: false,
    repos: [{ name: 'journal', source: { remote: 'https://github.com/demo/journal' } }],
  })
  await until(async () => {
    const factories = await client.listFactories()
    const failed = factories.flatMap((f) => f.setup ?? []).find((s) => s.state === 'failed')
    if (failed) throw new Error(`Demo clone failed: ${failed.error}`)
    return factories.every((f) => f.cloned) && (await client.listTasks()).length >= 2
  }, 'Factory clones')
  await mkdir(path.join(home, 'inputs'), { recursive: true })
  await writeFile(
    path.join(home, 'inputs', 'brief.md'),
    '## Goal\n\nMake notes easier to use.\n\n## Decisions so far\n\nKeep the experience simple.\n\n## Current state\n\nReady for the next Stage.\n\n## Open questions\n\nNone.\n\n## Next step\n\nReview the change.\n',
  )
  const ids: Record<string, string> = {}
  async function make(
    name: string,
    title: string,
    start = true,
    factory = garden.key,
  ): Promise<Task> {
    const task = await client.createTask({
      factory,
      title,
      description: 'A realistic example for exploring TED Dev.',
      start: false,
    })
    console.log(`Demo: ${name} (${task.displayId}) · ${Date.now() - began} ms`)
    ids[name] = task.displayId
    if (start) {
      const brief = {
        demoRequest: { brief: await readFile(path.join(home, 'inputs', 'brief.md'), 'utf8') },
      }
      const advance = { demoRequest: { outcome: { outcome: 'advance' } } }
      const initial: unknown[] = []
      if (
        [
          'round',
          'grilling',
          'proposal',
          'design',
          'working',
          'review',
          'validate',
          'merge',
          'done',
          'ci',
          'partlyMerged',
        ].includes(name)
      )
        initial.push(brief, advance)
      if (
        ['design', 'working', 'review', 'validate', 'merge', 'done', 'ci', 'partlyMerged'].includes(
          name,
        )
      )
        initial.push(
          { demoRequest: { depth: { depth: 'none', why: 'The scope is already clear.' } } },
          brief,
          advance,
        )
      if (['working', 'review', 'validate', 'merge', 'done', 'ci', 'partlyMerged'].includes(name))
        initial.push(brief, advance)
      await writeFile(path.join(home, 'inputs', `${task.displayId}.json`), script(...initial, idle))
      await client.startTask(task.id)
    }
    return task
  }
  async function lead(task: Task) {
    return until(async () => {
      const current = await demoTask(client, task.id)
      if (!current.leadRunId) return undefined
      const run = await client.getRun(current.leadRunId)
      return run.run.state === 'idle' ? run.run.id : undefined
    }, `idle Task Lead for ${task.displayId}`)
  }
  let nextScript = 0
  async function steps(task: Task, list: unknown[], wait = true) {
    const run = await lead(task)
    const marker = `demo-script-${++nextScript}-done`
    await client.sendRunMessage(run, script(...list, ...(wait ? [{ say: marker }, idle] : [])))
    if (wait)
      await until(async () => {
        const current = await client.getRun(run)
        return (
          current.run.state === 'idle' &&
          current.conversation.some((entry) => {
            const line = JSON.parse(entry.line)
            return (
              line.type === 'assistant' &&
              line.message?.content?.some((part: { text?: string }) => part.text === marker)
            )
          })
        )
      }, `script on ${task.displayId}`)
  }
  async function command(task: Task, ...args: string[]) {
    const prefix: unknown[] = []
    if (args[0] === 'outcome' && args[1] === 'advance') {
      const current = await demoTask(client, task.id)
      if (current.stage === 'clarify' && current.clarifyDepth === 'auto')
        prefix.push({
          demoRequest: { depth: { depth: 'none', why: 'The scope is already clear.' } },
        })
      prefix.push({
        demoRequest: { brief: await readFile(path.join(home, 'inputs', 'brief.md'), 'utf8') },
      })
    }
    let request: unknown
    if (args[0] === 'brief')
      request = { brief: await readFile(path.join(home, 'inputs', 'brief.md'), 'utf8') }
    if (args[0] === 'outcome' && args.length === 2) request = { outcome: { outcome: 'advance' } }
    if (args[0] === 'clarify') request = { depth: { depth: args[2], why: args[3] } }
    await steps(task, [...prefix, request ? { demoRequest: request } : { run: ['ted', ...args] }])
    const run = await lead(task)
    const entries = (await client.getRun(run)).conversation
    const result = entries.findLast((e) => e.line.includes('stdout') && e.line.includes('stderr'))
    if (result?.line.includes('\\"code\\":1'))
      throw new Error(`Demo command failed: ted ${args.join(' ')}: ${result.line}`)
  }
  let validationQueue = Promise.resolve()
  async function reach(task: Task, target: string) {
    for (let i = 0; i < 12; i++) {
      await lead(task)
      const current = await demoTask(client, task.id)
      const checks = await client.listCheckRuns(task.id)
      const failed = checks.find((r) => r.outcome === 'failed')
      if (failed)
        throw new Error(
          `Demo Check failed: ${JSON.stringify(await client.getCheckRun(failed.id))}; ${JSON.stringify(await client.checkOutput(failed.id, 0))}`,
        )
      if (current.stage === target) {
        console.log(`Demo: ${task.displayId} reached ${target} · ${Date.now() - began} ms`)
        return
      }
      if (current.stage === 'validate')
        await until(
          async () => (await client.listCheckRuns(task.id)).some((r) => r.finishedAt !== undefined),
          'Validate Checks',
        )
      const open = (await client.listComments(task.id)).findLast(
        (c) => c.kind !== 'note' && !c.answer,
      )
      if (open) {
        if (open.kind !== 'signoff' && open.kind !== 'review')
          throw new Error(`Unexpected demo request on ${task.displayId}: ${JSON.stringify(open)}`)
        await client.answerRequest(open.id, { action: 'approve' })
      } else {
        if (current.stage === 'work') {
          const preparation = validationQueue.then(async () => {
            await commitDemoTask(home, current)
            await command(task, 'outcome', 'advance')
            await until(
              async () =>
                (await demoTask(client, task.id)).repos.every((r) => r.pullRequest !== undefined),
              'draft pull requests',
            )
          })
          validationQueue = preparation.catch(() => {})
          await preparation
        } else await command(task, 'outcome', 'advance')
      }
      await lead(task)
    }
    throw new Error(`Could not reach ${target} for ${task.displayId}`)
  }
  const setup = (await client.listTasks()).find((t) => t.factoryId === journal.id && t.setup)
  if (setup) ids.setup = setup.displayId
  await make('backlog', 'Add keyboard hints to the editor', false)
  await make('intake', 'Import a notebook from Markdown')
  const question = await make('question', 'Choose a default notebook')
  await steps(question, [
    {
      demoRequest: {
        comment: {
          body: 'Which notebook should new notes use?',
          choices: ['Personal', 'Work'],
        },
      },
    },
  ])
  const clarify = await make('round', 'Export notes for a long trip')
  await reach(clarify, 'clarify')
  await mkdir(path.join(home, 'inputs'), { recursive: true })
  await writeFile(path.join(home, 'inputs', 'round.json'), JSON.stringify(round))
  await command(clarify, 'clarify', 'depth', 'few', 'Choose the first export format.')
  await steps(clarify, [{ demoRequest: { comment: { round } } }])
  const grilling = await make('grilling', 'Decide how offline edits should sync')
  await reach(grilling, 'clarify')
  await command(
    grilling,
    'clarify',
    'depth',
    'grilling',
    'Sync conflicts need an explicit decision.',
  )
  await command(grilling, 'outcome', 'advance')
  const design = await make('design', 'Make the note editor easier to scan')
  await reach(design, 'design')
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420"><rect width="720" height="420" fill="#fafaf8"/><rect x="24" y="24" width="160" height="372" rx="12" fill="#e4e7df"/><text x="48" y="65" font-size="24" font-family="sans-serif">Garden</text><text x="220" y="80" font-size="30" font-family="sans-serif">A quieter place to think</text><text x="220" y="130" font-size="18" font-family="sans-serif">Your notes, ready when you are.</text></svg>'
  const image = await client.uploadAttachment(
    { name: 'editor.svg', mediaType: 'image/svg+xml' },
    Buffer.from(svg),
  )
  const html =
    '<!doctype html><html><meta charset="utf-8"><title>Garden editor</title><style>body{font:18px system-ui;margin:48px;background:#fafaf8;color:#252820}textarea{display:block;width:90%;height:200px;margin-top:20px;font:inherit}button{padding:10px}</style><h1>A quieter place to think</h1><button onclick="document.querySelector(\'textarea\').focus()">Write a note</button><textarea placeholder="What’s on your mind?"></textarea></html>'
  const prototype = await client.uploadAttachment(
    { name: 'editor.html', mediaType: 'text/html' },
    Buffer.from(html),
  )
  await client.postComment(design.id, {
    body: 'Editor design assets for review.',
    attachments: [image, prototype],
  })
  const designFile = path.join(home, 'inputs', 'design.json')
  await writeFile(
    designFile,
    JSON.stringify({
      title: 'A calmer editor',
      summary: 'More space for the note and a clearer notebook list.',
      screenshots: [{ path: path.join(home, 'inputs', 'editor.svg'), caption: 'Editor layout' }],
      prototype: path.join(home, 'inputs', 'editor.html'),
      worthYourEye: ['The writing area stays focused when switching notebooks.'],
    }),
  )
  await writeFile(path.join(home, 'inputs', 'editor.svg'), svg)
  await writeFile(path.join(home, 'inputs', 'editor.html'), html)
  await command(design, 'outcome', 'advance', '--design', designFile)
  const work = await make('working', 'Keep the last edited note close at hand')
  await reach(work, 'work')
  const review = await make('review', 'Show notebook names in search results')
  const validate = await make('validate', 'Preserve headings when pasting text')
  const merge = await make('merge', 'Remember the sidebar width')
  async function configurePrs(task: Task, change: (index: number) => Record<string, unknown>) {
    const current = await demoTask(client, task.id)
    const file = path.join(home, 'gh.json')
    const state = JSON.parse(await readFile(file, 'utf8'))
    state.merge.prs ??= {}
    for (const [index, repo] of current.repos.entries()) {
      if (repo.pullRequest)
        state.merge.prs[repo.pullRequest.number] = {
          allowed: ['squash'],
          checks: [{ name: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          ...change(index),
        }
    }
    await writeFile(file, JSON.stringify(state))
  }
  const done = await make('done', 'Keep notebook sorting between launches')
  const ci = await make('ci', 'Keep pinned notes at the top')
  const partly = await make('partlyMerged', 'Align notebook labels across web and API')
  await client.setTaskRepos(partly.id, { set: ['demo/garden', 'demo/garden-api'] })
  await Promise.all([
    reach(review, 'review'),
    reach(validate, 'validate'),
    reach(merge, 'merge'),
    reach(done, 'merge'),
    reach(ci, 'review'),
    reach(partly, 'merge'),
  ])
  await command(review, 'outcome', 'advance')
  await configurePrs(done, () => ({}))
  const doneSignoff = await until(
    async () => (await client.listComments(done.id)).find((c) => c.kind === 'signoff' && !c.answer),
    'Merge sign-off',
  )
  await client.answerRequest(doneSignoff.id, { action: 'approve' })
  await until(async () => (await demoTask(client, done.id)).stage === 'done', 'merged Task')
  const followUp = await client.followUpTask(
    done.id,
    'Also preserve sorting when switching notebooks.',
  )
  ids.followUp = followUp.displayId
  await configurePrs(ci, () => ({
    checks: [{ name: 'Build', status: 'IN_PROGRESS', conclusion: null, required: true }],
  }))
  await command(ci, 'outcome', 'advance')
  const reviewGate = (await client.listComments(ci.id)).findLast(
    (c) => c.kind === 'signoff' && !c.answer,
  )
  if (reviewGate) await client.answerRequest(reviewGate.id, { action: 'approve' })
  await until(
    async () => (await demoTask(client, ci.id)).statuses.includes('waiting-for-github'),
    'pending CI',
  )
  await configurePrs(partly, (index) =>
    index === 1 ? { mergeFails: 'Demo: the second repository rejected its merge.' } : {},
  )
  const partlySignoff = await until(
    async () =>
      (await client.listComments(partly.id)).find((c) => c.kind === 'signoff' && !c.answer),
    'multi-repo sign-off',
  )
  await client.answerRequest(partlySignoff.id, { action: 'approve' })
  await until(
    async () => (await demoTask(client, partly.id)).status?.kind === 'partly-merged',
    'partly merged Task',
  )
  const stopped = await make('stopped', 'Add a compact notebook picker')
  await lead(stopped)
  await client.stopTask(stopped.id)
  const failed = await make('failed', 'Recover an interrupted file import')
  await lead(failed)
  await writeFile(path.join(home, 'inputs', `${failed.displayId}.json`), script({ exit: 1 }))
  await steps(failed, [{ exit: 1 }], false)
  await until(
    async () => (await demoTask(client, failed.id)).status?.kind === 'failed',
    'Task failure',
  )
  await writeFile(path.join(home, 'inputs', `${failed.displayId}.json`), script(idle))
  const split = await make('proposal', 'Share notebooks with a small team')
  await reach(split, 'clarify')
  await writeFile(path.join(home, 'inputs', 'proposal.json'), JSON.stringify(proposal))
  await steps(split, [{ demoRequest: { comment: { proposal } } }])
  const permission = await make('permission', 'Inspect the local import folder')
  await steps(
    permission,
    [
      {
        permission: {
          tool: 'Bash',
          input: { command: 'ls imports' },
          description: 'Inspect the demo import folder',
        },
      },
    ],
    false,
  )
  await until(
    async () => (await demoTask(client, permission.id)).status?.kind === 'waiting-on-you',
    'permission request',
  )
  const blocker = await make('blocked', 'Polish the new search result layout', false)
  await client.blockTask(blocker.id, review.id)
  await writeFile(
    path.join(home, 'inputs', 'sub-agent.md'),
    '# Check editor empty states\n\nRead the empty notebook behavior and report back.\n' +
      script({ say: 'Empty notebooks keep the new-note action visible.' }, idle),
  )
  await command(
    work,
    'run',
    'start',
    '--agent',
    'claude',
    '--name',
    'Editor empty states',
    '--prompt-file',
    path.join(home, 'inputs', 'sub-agent.md'),
  )
  const workRepo = (await demoTask(client, work.id)).repos.find((repo) => repo.name === 'web')
  if (!workRepo) throw new Error('Missing demo editor worktree.')
  await writeFile(
    path.join(workRepo.worktree, 'README.md'),
    '# Garden\n\nRemember the last edited note.\n',
  )
  const diffs = await client.fileDiffs(work.id, 'web', 'README.md')
  const row = diffs
    .flatMap((d) => d.hunks)
    .flatMap((h) => h.rows)
    .find((r) => r.kind === 'added' && r.new)
  if (!row?.new) throw new Error('Demo diff has no added line.')
  await client.draftLineComment(work.id, {
    repo: 'web',
    path: 'README.md',
    from: { new: row.new },
    body: 'Please also mention how an empty notebook behaves.',
  })
  const simulator = await make('simulator', 'Try swiping between notes on iPhone')
  await client.updateSettings({ maxBootedSimulators: 1 })
  await client.startApp(work.id, { repo: 'web', name: 'iPhone' })
  await steps(
    simulator,
    [
      {
        run: [
          'ted',
          'run-app',
          'iPhone',
          '--repo',
          'web',
          '--reason',
          'Compare the swipe interaction with the editor design.',
        ],
      },
    ],
    false,
  )
  await until(
    async () => (await client.listComments(simulator.id)).some((c) => c.simulator && !c.answer),
    'simulator request',
  )
  await seedPlansAndAutomations(home, client, garden.key)
  await writeFile(path.join(home, 'stub-codex.json'), JSON.stringify({ signedIn: false }))
  await client.checkAgentHealth()
  await client.startPlan({
    factory: garden.key,
    message: 'Plan an accessible export dialog',
    agent: 'codex',
  })
  const paused = await client.createTask({
    factory: garden.key,
    title: 'Check the export filename on Windows',
    lead: { agent: 'codex' },
    start: true,
  })
  ids.paused = paused.displayId
  await until(
    async () => (await demoTask(client, paused.id)).status?.kind === 'paused',
    'paused Task',
  )
  const workingRun = await lead(work)
  await steps(work, [
    { say: 'I’m checking how the editor restores its previous note.' },
    {
      demoRequest: {
        comment: {
          body: 'The editor now remembers the last note. I’m checking empty notebooks next.',
        },
      },
    },
  ])
  await steps(
    work,
    [
      { say: 'Checking the last few edge cases.' },
      { waitFor: path.join(home, 'continue-working') },
    ],
    false,
  )
  await until(
    async () => (await client.getRun(workingRun)).run.state === 'working',
    'working example',
  )
  await client.sendRunMessage(workingRun, 'Also check the case where the notebook is empty.')
  await client.updateSettings({ maxWorkingRuns: 1 })
  const queued = await client.createTask({
    factory: garden.key,
    title: 'Add a shortcut for the notebook switcher',
    start: true,
  })
  await client.startPlan({
    factory: garden.key,
    message: 'Explore quick notebook switching',
    agent: 'claude',
  })
  ids.queued = queued.displayId
  await until(
    async () => (await demoTask(client, queued.id)).status?.kind === 'queued',
    'queued Task',
  )
  const journalRepo = path.join(home, 'fixture-repos', 'journal')
  await writeFile(
    path.join(journalRepo, '.ted', 'workflow.yaml'),
    'version: 1\nstages: [invalid demo setting]\n',
  )
  await demoGit(home, journalRepo, 'add', '.ted/workflow.yaml')
  await demoGit(home, journalRepo, 'commit', '-m', 'Demonstrate an invalid Workflow')
  await demoGit(home, journalRepo, 'push', path.join(home, 'origins', 'journal.git'), 'HEAD:main')
  await client.factorySettings(journal.id)
  return ids
}

export async function verifyDemo(client: DaemonClient): Promise<void> {
  const tasks = await client.listTasks()
  const factories = await client.listFactories()
  const need = (ok: boolean, label: string) => {
    if (!ok) throw new Error(`Demo coverage is missing ${label}.`)
  }
  need(
    factories.length === 2 && factories.some((f) => f.repos.length === 2),
    'two Factories and multiple repos',
  )
  for (const stage of [
    'backlog',
    'intake',
    'clarify',
    'design',
    'work',
    'validate',
    'review',
    'merge',
    'done',
  ])
    need(
      tasks.some((t) => t.stage === stage),
      `${stage} Stage`,
    )
  for (const status of [
    'working',
    'waiting-on-you',
    'queued',
    'paused',
    'stopped',
    'failed',
    'waiting-for-github',
    'partly-merged',
  ] as const)
    need(
      tasks.some((t) => t.statuses.includes(status)),
      `${status} status`,
    )
  need(
    tasks.some((t) => t.setup),
    'setup Task',
  )
  need(
    tasks.some((t) => t.followUpOf),
    'Follow-up',
  )
  need(
    tasks.some((t) => t.blockedBy.length > 0),
    'blocker',
  )
  const inbox = await client.listInbox()
  for (const kind of ['question', 'round', 'review', 'signoff', 'permission', 'proposal'])
    need(
      inbox.some((i) => i.request.kind === kind),
      `${kind} Inbox request`,
    )
  need(
    inbox.some((i) => i.request.simulator !== undefined),
    'simulator request',
  )
  for (const stage of ['clarify', 'review', 'merge'])
    need(
      inbox.some((i) => i.request.kind === 'signoff' && i.request.stage === stage),
      `${stage} sign-off`,
    )
  const design = inbox.find((item) => item.request.design)?.request.design
  need(
    (design?.screenshots?.length ?? 0) > 0 && design?.prototype !== undefined,
    'design screenshots and prototype',
  )
  const work = tasks.find((task) => task.title === 'Keep the last edited note close at hand')
  need(work?.leadRunId !== undefined, 'editor Run')
  if (work?.leadRunId) {
    const runs = await client.listTaskRuns(work.id)
    need(
      runs.some((run) => run.parentRunId === work.leadRunId),
      'sub-agent',
    )
    const chat = await client.getRunChat(work.leadRunId)
    need(
      chat.items.some((item) => item.kind === 'agent'),
      'chat history',
    )
    need(
      chat.items.some((item) => item.kind === 'human' && item.queued === true),
      'pending steering message',
    )
    need(
      (await client.lineComments(work.id)).some((line) => !line.sent),
      'line comment drafts',
    )
    need((await client.listApps(work.id)).length >= 2, 'declared Apps')
  }
  const comments = await Promise.all(tasks.map((task) => client.listComments(task.id)))
  need(
    comments.some((list) => list.some((comment) => (comment.attachments?.length ?? 0) > 0)),
    'attachments',
  )
  const plans = await client.listPlans()
  for (const status of [
    'working',
    'waiting',
    'idle',
    'queued',
    'paused',
    'failed',
    'stopped',
    'finished',
  ])
    need(
      plans.some((p) => p.status === status),
      `${status} Plan`,
    )
  const automations = await client.listAutomations()
  const histories = await Promise.all(automations.map((a) => client.getAutomation(a.id)))
  need(
    histories.some((a) => a.history.some((r) => r.result.kind === 'failed')),
    'failed Automation history',
  )
  need(
    (await client.listBanners()).some((b) => b.problem === 'workflow-invalid'),
    'invalid Workflow',
  )
  need(
    Object.values((await client.drift()).factories).some((n) => n > 0),
    'Factory drift',
  )
  const checks = await Promise.all(tasks.map((t) => client.listCheckRuns(t.id)))
  need(
    checks.some((runs) => runs.some((run) => run.outcome === 'passed')),
    'Check results',
  )
}

async function seedPlansAndAutomations(
  home: string,
  client: DaemonClient,
  factory: string,
): Promise<void> {
  const start = async (title: string, steps: unknown[] = [idle]) => {
    const plan = await client.startPlan({
      factory,
      message: `${title}\n${script(...steps)}`,
      agent: 'claude',
    })
    await until(
      async () => (await client.getPlan(plan.id)).plan.status !== 'queued',
      `Plan ${title}`,
    )
    return plan
  }
  await start('Plan a better notebook search')
  await start('Explore offline-first notebooks', [
    { say: 'Comparing the local cache and sync queue.' },
    { waitFor: path.join(home, 'continue-planning') },
  ])
  const waiting = await start('Choose the next export format', [
    { demoRequest: { planRequest: { round } } },
    idle,
  ])
  await until(
    async () => (await client.getPlan(waiting.id)).plan.status === 'waiting',
    'waiting Plan',
  )
  const stopped = await start('Explore notebook templates')
  await client.stopPlan(stopped.id)
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
  const failed = await start('Investigate a failed importer', [{ exit: 1 }])
  await until(async () => (await client.getPlan(failed.id)).plan.status === 'failed', 'failed Plan')
  await writeFile(path.join(home, 'stub-claude.json'), '{}')
  const finished = await start('Plan shared notebooks', [
    { demoRequest: { planRequest: { proposal } } },
    idle,
  ])
  const request = await until(
    async () =>
      (await client.getPlan(finished.id)).requests.find((r) => r.kind === 'proposal' && !r.answer),
    'Plan proposal',
  )
  await client.answerPlanRequest(request.id, { action: 'approve' })
  const automation = await client.createAutomation({
    factory,
    name: 'Daily notebook maintenance',
    prompt: `Check notebook health.\n${script({ say: 'The notebooks are healthy. No follow-up needed.' }, idle)}`,
    schedule: { kind: 'daily', at: '09:00' },
    agent: 'claude',
    on: false,
  })
  await client.runAutomation(automation.id)
  await until(
    async () => (await client.getAutomation(automation.id)).history.some((r) => r.finishedAt),
    'successful Automation',
  )
  await client.editAutomation(automation.id, {
    prompt: `Check notebook imports.\n${script({ say: 'The fixture import could not be read.' }, { exit: 1 })}`,
  })
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
  await client.runAutomation(automation.id)
  await until(
    async () =>
      (await client.getAutomation(automation.id)).history.filter((r) => r.finishedAt).length === 2,
    'failed Automation',
  )
  await writeFile(path.join(home, 'stub-claude.json'), '{}')
}
