import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CheckRun, DaemonClient, Run, Task } from '@ted/protocol'
import { isArray, isInteger, isObject, isString, parseJson } from '@ted/protocol/parse'
import { waitForLock } from '../lock.ts'
import { until } from './demo.ts'
import { commitDemoTask, demoGit } from './fixtures.ts'

const script = (...steps: unknown[]) => JSON.stringify({ steps })
const idle = { endTurn: true }
// One advance fetches and test-merges every repo of the Task; it took 13.9 s beside other test runs.
const advanceWaitMs = 60_000
const checksWaitMs = 180_000
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
    {
      title: 'Share a read-only link',
      scope: 'Publish one note with an expiring URL.',
      files: ['src/share/links.ts', 'src/share/ShareDialog.tsx'],
    },
    {
      title: 'Manage shared links',
      scope: 'List and revoke published links.',
      blockedBy: [1],
      files: ['src/share/links.ts', 'src/settings/SharedLinks.tsx'],
    },
  ],
}

interface DemoStepResult {
  step: string
  code: number | null
  stderr: string
}

function demoScriptResults(text: string): DemoStepResult[] {
  const body = parseJson(text)
  const results = isObject(body) ? body.results : undefined
  if (!isArray(results)) throw new Error(`Unreadable demo script results: ${text}`)
  return results.map((result) => {
    if (!isObject(result)) throw new Error(`Unreadable demo step result: ${text}`)
    const { step, code, stderr } = result
    return {
      step: isString(step) ? step : '',
      code: isInteger(code) ? code : null,
      stderr: isString(stderr) ? stderr : '',
    }
  })
}

export function demoCheckProblem(runs: readonly CheckRun[]): string | undefined {
  const run = runs.find((r) => r.outcome === 'failed' || r.outcome === 'interrupted')
  if (!run) return undefined
  return run.outcome === 'interrupted'
    ? `Demo check run ${run.id} was interrupted: Ted could not run it, so the Task has no check coverage. The daemon log says why.`
    : `Demo check failed: ${JSON.stringify(run)}`
}

interface DemoState {
  task(id: string): Promise<Task>
  run(id: string): Run | undefined
  revision(id: string): number
  plan: DaemonClient['getPlan']
  automation: DaemonClient['getAutomation']
}

export async function seedScenarios(
  home: string,
  client: DaemonClient,
): Promise<Record<string, string>> {
  const tasks = new Map<string, Task>()
  const runs = new Map<string, Run>()
  const revisions = new Map<string, number>()
  const details = new Map<string, { revision: number; value: Promise<unknown> }>()
  let disconnected = false
  const subscription = await client.subscribe(
    (event) => {
      if (event.type === 'task-created' || event.type === 'task-updated')
        tasks.set(event.task.id, event.task)
      if (event.type === 'task-deleted') tasks.delete(event.taskId)
      if (event.type === 'run-updated') runs.set(event.run.id, event.run)
      if (event.type === 'plan-updated' || event.type === 'automation-updated') {
        const key =
          event.type === 'plan-updated'
            ? `plan:${event.planId}`
            : `automation:${event.automationId}`
        revisions.set(key, (revisions.get(key) ?? 0) + 1)
      }
      if (event.type === 'run-updated') {
        const key = `plan:${event.run.id}`
        revisions.set(key, (revisions.get(key) ?? 0) + 1)
      }
      if (event.type === 'run-output' || event.type === 'run-updated') {
        const id = event.type === 'run-output' ? event.runId : event.run.id
        revisions.set(id, (revisions.get(id) ?? 0) + 1)
      }
    },
    { onClose: () => (disconnected = true) },
  )
  const connected = () => {
    if (disconnected) throw new Error('The demo’s daemon event stream closed while seeding.')
  }
  function detail<T>(key: string, read: () => Promise<T>): Promise<T> {
    connected()
    const revision = revisions.get(key) ?? 0
    let cached = details.get(key)
    if (!cached || cached.revision !== revision) {
      cached = { revision, value: read() }
      details.set(key, cached)
    }
    return cached.value as Promise<T>
  }
  try {
    return await populateScenarios(home, client, {
      task: (id) =>
        until(async () => {
          connected()
          return tasks.get(id)
        }, `Task ${id}`),
      run: (id) => {
        connected()
        return runs.get(id)
      },
      revision: (id) => revisions.get(id) ?? 0,
      plan: (id) => detail(`plan:${id}`, () => client.getPlan(id)),
      automation: (id) => detail(`automation:${id}`, () => client.getAutomation(id)),
    })
  } finally {
    subscription.close()
  }
}

async function populateScenarios(
  home: string,
  client: DaemonClient,
  observed: DemoState,
): Promise<Record<string, string>> {
  const began = Date.now()
  const garden = await client.createFactory({
    name: 'Garden',
    key: 'GD',
    repos: [
      { name: 'web', source: { remote: 'https://github.com/demo/garden' } },
      { name: 'api', source: { remote: 'https://github.com/demo/garden-api' } },
    ],
  })
  const journal = await client.createFactory({
    name: 'Field Notes',
    key: 'FN',
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
    start: boolean | 'defer' = true,
    factory = garden.key,
  ): Promise<Task> {
    const task = await client.createTask({
      factory,
      title,
      description: 'A realistic example for exploring Ted Dev.',
      start: false,
      ...([
        'design',
        'working',
        'review',
        'validate',
        'merge',
        'done',
        'ci',
        'partlyMerged',
      ].includes(name) && { clarifyDepth: 'none' as const }),
    })
    if (factory === garden.key && name !== 'partlyMerged')
      await client.setTaskRepos(task.id, { set: ['demo/garden'] })
    if (name === 'grilling') {
      const { revision } = await client.taskGates(task.id)
      await client.setTaskGates(task.id, { overrides: { clarify: true }, revision })
    }
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
        initial.push(advance)
      if (
        ['design', 'working', 'review', 'validate', 'merge', 'done', 'ci', 'partlyMerged'].includes(
          name,
        )
      )
        initial.push(advance)
      if (['working', 'review', 'validate', 'merge', 'done', 'ci', 'partlyMerged'].includes(name))
        initial.push(brief, advance)
      if (name === 'question')
        initial.push({
          demoRequest: {
            comment: {
              body: 'Which notebook should new notes use?',
              choices: ['Personal', 'Work'],
            },
          },
        })
      if (name === 'round')
        initial.push(
          { demoRequest: { depth: { depth: 'few', why: 'Choose the first export format.' } } },
          { demoRequest: { comment: { round } } },
        )
      if (name === 'grilling')
        initial.push(
          {
            demoRequest: {
              depth: { depth: 'grilling', why: 'Sync conflicts need an explicit decision.' },
            },
          },
          brief,
          advance,
        )
      if (name === 'proposal') initial.push({ demoRequest: { comment: { proposal } } })
      if (name === 'permission')
        initial.push({
          permission: {
            tool: 'Bash',
            input: { command: 'ls imports' },
            description: 'Inspect the demo import folder',
          },
        })
      if (name === 'failed') initial.push({ exit: 1 })
      if (name === 'simulator')
        initial.push({
          run: [
            'ted',
            'run-app',
            'iPhone',
            '--repo',
            'web',
            '--reason',
            'Compare the swipe interaction with the editor design.',
          ],
        })
      await writeFile(path.join(home, 'inputs', `${task.displayId}.json`), script(...initial, idle))
      if (start === true) await client.startTask(task.id)
    }
    return task
  }
  async function lead(task: Task) {
    return until(async () => {
      const current = await observed.task(task.id)
      if (!current.leadRunId) return undefined
      const run = observed.run(current.leadRunId)
      return run?.state === 'idle' ? run.id : undefined
    }, `idle Task Lead for ${task.displayId}`)
  }
  const scriptCounts = new Map<string, number>()
  async function steps(task: Task, list: unknown[], wait = true, label = 'script') {
    const run = await lead(task)
    const folder = path.join(home, 'inputs', 'runs', run)
    const count = (scriptCounts.get(run) ?? 0) + 1
    scriptCounts.set(run, count)
    const n = String(count)
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, `${n}.json`)
    await writeFile(`${file}.tmp`, script(...list))
    await rename(`${file}.tmp`, file)
    if (!wait) return undefined
    let checkedRevision = -1
    // The result file can appear before the daemon reads the turn's output, so wait for the
    // stub's done line in the conversation: an idle state after it is this turn's end.
    await until(
      async () => {
        if (observed.run(run)?.state !== 'idle') return false
        const revision = observed.revision(run)
        if (revision === checkedRevision) return false
        checkedRevision = revision
        const current = await client.getRun(run)
        return (
          current.run.state === 'idle' &&
          current.conversation.some((entry) => {
            const line = parseJson(entry.line)
            return (
              isObject(line) &&
              line.type === 'system' &&
              line.subtype === 'demo_script_done' &&
              line.script === n
            )
          })
        )
      },
      `script on ${task.displayId}`,
      advanceWaitMs,
    )
    const results = demoScriptResults(await readFile(path.join(folder, `${n}.result.json`), 'utf8'))
    const failed = results.find((result) => result.code !== 0)
    if (failed)
      throw new Error(`Demo ${label} failed on ${task.displayId}: ${failed.step}: ${failed.stderr}`)
    return results
  }
  async function checksSettled(task: Task) {
    await until(
      async () => {
        if ((await observed.task(task.id)).checksActive) return false
        const problem = demoCheckProblem(await client.listCheckRuns(task.id))
        if (problem) throw new Error(problem)
        return true
      },
      `${task.displayId}’s checks to finish`,
      checksWaitMs,
    )
  }
  async function command(task: Task, ...args: string[]) {
    const prefix: unknown[] = []
    if (args[0] === 'outcome' && args[1] === 'advance') {
      await checksSettled(task)
      const current = await observed.task(task.id)
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
    await checkedSteps(
      task,
      [...prefix, request ? { demoRequest: request } : { run: ['ted', ...args] }],
      `ted ${args.join(' ')}`,
    )
  }
  async function checkedSteps(task: Task, list: unknown[], label: string) {
    const results = await steps(task, list, true, label)
    if (!results) throw new Error(`Demo command did not complete on ${task.displayId}.`)
  }
  async function atMerge(task: Task) {
    await until(
      async () => {
        const current = await observed.task(task.id)
        return current.stage === 'merge' && current.repos.every((r) => r.pullRequest !== undefined)
      },
      `${task.displayId} at Merge`,
      advanceWaitMs,
    )
  }
  async function advanceAtMerge(task: Task) {
    await atMerge(task)
    await command(task, 'outcome', 'advance')
  }
  const validations = new Set<Promise<void>>()
  async function reach(task: Task, target: string) {
    for (let i = 0; i < 12; i++) {
      await lead(task)
      const current = await observed.task(task.id)
      const checks = await client.listCheckRuns(task.id)
      const failed = checks.find((r) => r.outcome === 'failed')
      if (failed)
        throw new Error(
          `Demo check failed: ${JSON.stringify(await client.getCheckRun(failed.id))}; ${JSON.stringify(await client.checkOutput(failed.id, 0))}`,
        )
      const problem = demoCheckProblem(checks)
      if (problem) throw new Error(problem)
      if (current.stage === target) {
        if (target === 'merge')
          await until(
            async () =>
              (await observed.task(task.id)).repos.every((r) => r.pullRequest !== undefined),
            'pull requests at Merge',
          )
        console.log(`Demo: ${task.displayId} reached ${target} · ${Date.now() - began} ms`)
        return
      }
      if (current.stage === 'validate') await checksSettled(current)
      const open = (await client.listComments(task.id)).findLast(
        (c) => c.kind !== 'note' && !c.answer,
      )
      if (open) {
        if (open.kind !== 'signoff' && open.kind !== 'review')
          throw new Error(`Unexpected demo request on ${task.displayId}: ${JSON.stringify(open)}`)
        await client.answerRequest(open.id, { action: 'approve' })
      } else {
        if (current.stage === 'work') {
          while (validations.size >= 2) await Promise.race(validations)
          const preparation = (async () => {
            await commitDemoTask(home, current)
            const count = target === 'validate' ? 1 : target === 'review' ? 2 : 3
            const brief = await readFile(path.join(home, 'inputs', 'brief.md'), 'utf8')
            for (let n = 0; n < count; n++) {
              await checksSettled(task)
              const { stage } = await observed.task(task.id)
              await checkedSteps(
                task,
                [{ demoRequest: { brief } }, { demoRequest: { outcome: { outcome: 'advance' } } }],
                `advance ${task.displayId} toward ${target}`,
              )
              if (stage === 'work')
                await until(
                  async () => {
                    const problem = demoCheckProblem(await client.listCheckRuns(task.id))
                    if (problem) throw new Error(problem)
                    return (await observed.task(task.id)).stage !== 'work'
                  },
                  `${task.displayId} to leave Work`,
                  advanceWaitMs,
                )
            }
          })()
          validations.add(preparation)
          try {
            await preparation
          } finally {
            validations.delete(preparation)
          }
        } else await command(task, 'outcome', 'advance')
      }
      await lead(task)
    }
    throw new Error(`Could not reach ${target} for ${task.displayId}`)
  }
  const setup = (await client.listTasks()).find((t) => t.factoryId === journal.id && t.setup)
  if (setup) ids.setup = setup.displayId
  const gardenReady = Promise.withResolvers<void>()
  const pausedAgent = (async () => {
    await writeFile(path.join(home, 'stub-codex.json'), JSON.stringify({ signedIn: false }))
    await client.checkAgentHealth()
  })().then(
    () => ({}),
    (error: unknown) => ({ error }),
  )
  const planning = (async () => {
    const requestId = await preparePlansAndAutomations(
      home,
      client,
      garden.key,
      journal.key,
      gardenReady.promise,
      observed,
    )
    const ready = await pausedAgent
    if ('error' in ready) throw ready.error
    await client.startPlan({
      factory: garden.key,
      message: 'Plan an accessible export dialog',
      agent: 'codex',
    })
    return requestId
  })().then(
    (requestId) => ({ requestId }),
    (error: unknown) => ({ error }),
  )
  await make('backlog', 'Add keyboard hints to the editor', false)
  const intake = await make('intake', 'Import a notebook from Markdown', 'defer')
  const question = await make('question', 'Choose a default notebook', 'defer')
  const clarify = await make('round', 'Export notes for a long trip', 'defer')
  const grilling = await make('grilling', 'Decide how offline edits should sync', 'defer')
  const design = await make('design', 'Make the note editor easier to scan', 'defer')
  const work = await make('working', 'Keep the last edited note close at hand', 'defer')
  for (const task of [intake, question, clarify, grilling, design, work])
    await client.startTask(task.id)
  const review = await make('review', 'Show notebook names in search results', 'defer')
  const validate = await make('validate', 'Preserve headings when pasting text', 'defer')
  const merge = await make('merge', 'Remember the sidebar width', 'defer')
  const done = await make('done', 'Keep notebook sorting between launches', 'defer')
  const ci = await make('ci', 'Keep pinned notes at the top', 'defer')
  const partly = await make('partlyMerged', 'Align notebook labels across web and API', 'defer')
  await client.setTaskRepos(partly.id, { set: ['demo/garden', 'demo/garden-api'] })
  for (const task of [review, validate, merge, done, ci, partly]) await client.startTask(task.id)
  await Promise.all([
    reach(clarify, 'clarify'),
    reach(grilling, 'clarify'),
    reach(design, 'design'),
  ])
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
  await reach(work, 'work')
  async function prepareEditor() {
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
    const workRepo = (await observed.task(work.id)).repos.find((repo) => repo.name === 'web')
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
    const iPhone = (await client.listApps(work.id)).find(
      (a) => a.repo === 'web' && a.name === 'iPhone',
    )
    const declaration = iPhone?.outsideSandboxApproval?.declaration
    await client.startApp(work.id, {
      repo: 'web',
      name: 'iPhone',
      ...(declaration !== undefined && { declaration }),
    })
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
    const workingRun = await lead(work)
    await steps(
      work,
      [
        { say: 'Checking the last few edge cases.' },
        { waitFor: path.join(home, 'continue-working') },
      ],
      false,
    )
    await until(async () => observed.run(workingRun)?.state === 'working', 'working example')
    await client.sendRunMessage(workingRun, 'Also check the case where the notebook is empty.')
  }
  const editor = prepareEditor().then(
    () => ({}),
    (error: unknown) => ({ error }),
  )
  async function prepareInvalidSettings() {
    const journalRepo = path.join(home, 'fixture-repos', 'journal')
    await writeFile(
      path.join(journalRepo, '.ted', 'workflow.yaml'),
      'version: 1\nstages: [invalid demo setting]\n',
    )
    await demoGit(home, journalRepo, 'add', '.ted/workflow.yaml')
    await demoGit(home, journalRepo, 'commit', '-m', 'Demonstrate an invalid Workflow')
    await demoGit(home, journalRepo, 'push', path.join(home, 'origins', 'journal.git'), 'HEAD:main')
    await client.factorySettings(journal.id, { refresh: 'first' })
  }
  async function configurePrs(task: Task, change: (index: number) => Record<string, unknown>) {
    const current = await observed.task(task.id)
    const file = path.join(home, 'gh.json')
    const lock = await waitForLock(`${file}.lock.sqlite`, 60_000)
    if (!lock) throw new Error('Demo GitHub fixture lock timed out.')
    try {
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
      const temporary = `${file}.next`
      await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
      await rename(temporary, file)
    } finally {
      lock.release()
    }
  }
  await Promise.all([review, validate, merge, done, ci, partly].map(lead))
  gardenReady.resolve()
  const invalidSettings = planning.then(async (planned) => {
    if ('error' in planned) return planned
    try {
      await prepareInvalidSettings()
      return {}
    } catch (error) {
      return { error }
    }
  })
  const doneAtMerge = reach(done, 'merge')
  const finalExamples = (async () => {
    await doneAtMerge
    const ready = await planning
    if ('error' in ready) throw ready.error
    await configurePrs(done, () => ({}))
    await advanceAtMerge(done)
    const doneSignoff = await until(
      async () =>
        (await client.listComments(done.id)).find((c) => c.kind === 'signoff' && !c.answer),
      'Merge sign-off',
    )
    await client.answerRequest(doneSignoff.id, { action: 'approve' })
    await until(async () => (await observed.task(done.id)).stage === 'done', 'merged Task')
    const followUp = await client.followUpTask(
      done.id,
      'Also preserve sorting when switching notebooks.',
    )
    ids.followUp = followUp.displayId
    const stopped = await make('stopped', 'Add a compact notebook picker', 'defer')
    const failed = await make('failed', 'Recover an interrupted file import', 'defer')
    const split = await make('proposal', 'Share notebooks with a small team', 'defer')
    const permission = await make('permission', 'Inspect the local import folder', 'defer')
    for (const task of [stopped, failed, split, permission]) await client.startTask(task.id)
    await Promise.all([
      lead(stopped).then(() => client.stopTask(stopped.id)),
      until(
        async () => (await observed.task(failed.id)).status?.kind === 'failed',
        'Task failure',
      ).then(() => writeFile(path.join(home, 'inputs', `${failed.displayId}.json`), script(idle))),
      reach(split, 'clarify'),
      until(
        async () => (await observed.task(permission.id)).status?.kind === 'waiting-on-you',
        'permission request',
      ),
    ])
    const blocker = await make('blocked', 'Polish the new search result layout', false)
    await client.blockTask(blocker.id, review.id)
    const editorReady = await editor
    if ('error' in editorReady) throw editorReady.error
    const simulator = await make('simulator', 'Try swiping between notes on iPhone')
    await until(
      async () => (await client.listComments(simulator.id)).some((c) => c.simulator && !c.answer),
      'simulator request',
    )
  })().then(
    () => ({}),
    (error: unknown) => ({ error }),
  )
  await Promise.race([
    doneAtMerge,
    until(
      async () =>
        ['work', 'validate', 'review', 'merge', 'done'].includes(
          (await observed.task(done.id)).stage,
        ),
      'Done Task preparation',
    ),
  ])
  await Promise.all([
    reach(review, 'review'),
    reach(validate, 'validate'),
    reach(merge, 'merge'),
    doneAtMerge,
    reach(ci, 'review'),
    reach(partly, 'merge'),
  ])
  const planned = await planning
  if ('error' in planned) throw planned.error
  await command(review, 'outcome', 'advance')
  await advanceAtMerge(merge)
  await until(
    async () =>
      (await client.listComments(merge.id)).some((c) => c.kind === 'signoff' && !c.answer),
    'Merge sign-off',
  )
  await command(ci, 'outcome', 'advance')
  const reviewGate = (await client.listComments(ci.id)).findLast(
    (c) => c.kind === 'signoff' && !c.answer,
  )
  if (reviewGate) await client.answerRequest(reviewGate.id, { action: 'approve' })
  await atMerge(ci)
  await configurePrs(ci, () => ({
    checks: [{ name: 'Build', status: 'IN_PROGRESS', conclusion: null, required: true }],
  }))
  await command(ci, 'outcome', 'advance')
  await until(
    async () => (await observed.task(ci.id)).statuses.includes('waiting-for-github'),
    'pending CI',
  )
  const finalReady = await finalExamples
  if ('error' in finalReady) throw finalReady.error
  await configurePrs(partly, (index) =>
    index === 1 ? { mergeFails: 'Demo: the second repository rejected its merge.' } : {},
  )
  await advanceAtMerge(partly)
  const partlySignoff = await until(
    async () =>
      (await client.listComments(partly.id)).find((c) => c.kind === 'signoff' && !c.answer),
    'multi-repo sign-off',
  )
  await client.answerRequest(partlySignoff.id, { action: 'approve' })
  await until(
    async () => (await observed.task(partly.id)).status?.kind === 'partly-merged',
    'partly merged Task',
  )
  await client.answerPlanRequest(planned.requestId, { action: 'approve' })
  const paused = await client.createTask({
    factory: garden.key,
    title: 'Check the export filename on Windows',
    lead: { agent: 'codex' },
    start: true,
  })
  ids.paused = paused.displayId
  await until(async () => (await observed.task(paused.id)).status?.kind === 'paused', 'paused Task')
  await client.updateSettings({ maxWorkingRuns: 1 })
  const queued = await client.createTask({
    factory: garden.key,
    title: 'Add a shortcut for the notebook switcher',
    start: true,
  })
  ids.queued = queued.displayId
  await until(async () => (await observed.task(queued.id)).status?.kind === 'queued', 'queued Task')
  const settingsReady = await invalidSettings
  if ('error' in settingsReady) throw settingsReady.error
  return ids
}

export async function verifyDemo(client: DaemonClient): Promise<void> {
  const tasks = await client.listTasks()
  const factories = await client.listFactories()
  const need = (ok: boolean, label: string) => {
    if (!ok) throw new Error(`Demo coverage is missing ${label}.`)
  }
  for (const task of tasks) {
    if (!task.leadRunId) continue
    const chat = await client.getRunChat(task.leadRunId)
    const leak = chat.items
      .flatMap((item) => (item.kind === 'agent' || item.kind === 'human' ? [item.text] : []))
      .find((text) =>
        ['"steps"', '"stdout"', '"code":', 'demo-script-', '/inputs/'].some((plumbing) =>
          text.includes(plumbing),
        ),
      )
    if (leak !== undefined)
      throw new Error(`Demo Task ${task.displayId} shows stub plumbing in its thread: ${leak}`)
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
  for (const status of ['working', 'waiting', 'idle', 'paused', 'failed', 'stopped', 'finished'])
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

async function preparePlansAndAutomations(
  home: string,
  client: DaemonClient,
  factory: string,
  secondaryFactory: string,
  gardenReady: Promise<void>,
  observed: DemoState,
): Promise<string> {
  const start = async (title: string, steps: unknown[] = [idle], target = secondaryFactory) => {
    const plan = await client.startPlan({
      factory: target,
      message: `${title}\n${script(...steps)}`,
      agent: 'claude',
    })
    await until(
      async () => (await observed.plan(plan.id)).plan.status !== 'queued',
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
  const stopped = await start('Explore notebook templates')
  await until(
    async () => (await observed.plan(waiting.id)).plan.status === 'waiting',
    'waiting Plan',
  )
  await client.stopPlan(stopped.id)
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
  const failed = await start('Investigate a failed importer', [{ exit: 1 }])
  await until(async () => (await observed.plan(failed.id)).plan.status === 'failed', 'failed Plan')
  await writeFile(path.join(home, 'stub-claude.json'), '{}')
  await gardenReady
  const finished = await start(
    'Plan shared notebooks',
    [{ demoRequest: { planRequest: { proposal } } }, idle],
    factory,
  )
  const request = await until(
    async () =>
      (await observed.plan(finished.id)).requests.find((r) => r.kind === 'proposal' && !r.answer),
    'Plan proposal',
  )
  const automation = await client.createAutomation({
    factory: secondaryFactory,
    name: 'Daily notebook maintenance',
    prompt: `Check notebook health.\n${script({ say: 'The notebooks are healthy. No follow-up needed.' }, idle)}`,
    schedule: { kind: 'daily', at: '09:00' },
    agent: 'claude',
    on: false,
  })
  await client.runAutomation(automation.id)
  await until(
    async () => (await observed.automation(automation.id)).history.some((r) => r.finishedAt),
    'successful Automation',
  )
  await client.editAutomation(automation.id, {
    prompt: `Check notebook imports.\n${script({ say: 'The fixture import could not be read.' }, { exit: 1 })}`,
  })
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
  await client.runAutomation(automation.id)
  await until(
    async () =>
      (await observed.automation(automation.id)).history.filter((r) => r.finishedAt).length === 2,
    'failed Automation',
  )
  await writeFile(path.join(home, 'stub-claude.json'), '{}')
  return request.id
}
