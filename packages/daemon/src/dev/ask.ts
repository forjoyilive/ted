import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type CommentKind, DaemonClient, readDaemonInfo, type Task } from '@ted/protocol'
import { isArray, isInteger, isObject, parseJson } from '@ted/protocol/parse'
import { checkDemoHome, demoVersion } from './home.ts'

export const demoAskKinds = ['question', 'permission', 'sign-off'] as const
export type DemoAskKind = (typeof demoAskKinds)[number]

export function isDemoAskKind(value: string): value is DemoAskKind {
  return demoAskKinds.some((kind) => kind === value)
}

const signOffStages: readonly string[] = ['intake', 'clarify', 'design']

const commentKind: Record<DemoAskKind, CommentKind> = {
  question: 'question',
  permission: 'permission',
  'sign-off': 'signoff',
}

const brief =
  '## Goal\n\nMake notes easier to use.\n\n## Decisions so far\n\nKeep the experience simple.\n\n## Current state\n\nReady for the next Stage.\n\n## Open questions\n\nNone.\n\n## Next step\n\nReview the change.\n'

const questions = [
  { body: 'Should new notes open in the editor or the preview?', choices: ['Editor', 'Preview'] },
  { body: 'How long should deleted notes stay in the trash?', choices: ['7 days', '30 days'] },
  { body: 'Which notebook should imported notes go to?', choices: ['Inbox', 'Archive'] },
]

export interface DemoAskResult {
  task: Task
  kind: DemoAskKind
}

async function connect(home: string): Promise<DaemonClient> {
  const known = await checkDemoHome(home)
  if (!known) throw new Error(`There is no demo in ${home}. Run pnpm app --demo first.`)
  if (known.version !== demoVersion || !known.complete)
    throw new Error('This demo is incomplete or outdated. Run pnpm ted dev seed --reset.')
  const info = await readDaemonInfo(home)
  const client = info && new DaemonClient(info)
  const running =
    client &&
    (await client.listTasks().then(
      () => true,
      () => false,
    ))
  if (!client || !running) throw new Error('Open the demo first: pnpm app --demo.')
  return client
}

async function idleLead(client: DaemonClient, task: Task): Promise<string | undefined> {
  if (task.archived || !task.leadRunId) return undefined
  const { run } = await client.getRun(task.leadRunId).catch(() => ({ run: undefined }))
  return run?.state === 'idle' ? run.id : undefined
}

async function signOffStage(client: DaemonClient, task: Task): Promise<boolean> {
  if (!signOffStages.includes(task.stage)) return false
  const { rows } = await client.taskGates(task.id)
  return rows.some((row) => row.stage === task.stage && row.effective)
}

async function pick(
  client: DaemonClient,
  kind: DemoAskKind,
  wanted: string | undefined,
): Promise<{ task: Task; run: string }> {
  const tasks = await client.listTasks()
  const waiting = new Set(
    (await client.listWaiting()).flatMap((r) => (r.source === 'task' ? [r.taskId] : [])),
  )
  const candidates = wanted
    ? tasks.filter((t) => t.displayId.toLowerCase() === wanted.toLowerCase() || t.id === wanted)
    : tasks
  if (wanted && candidates.length === 0) throw new Error(`There is no demo Task ${wanted}.`)
  for (const task of candidates) {
    if (waiting.has(task.id)) continue
    if (kind === 'sign-off' && !(await signOffStage(client, task))) continue
    const run = await idleLead(client, task)
    if (run) return { task, run }
  }
  if (wanted)
    throw new Error(
      kind === 'sign-off'
        ? `${wanted} can’t ask for a sign-off now: it needs a waiting Task Lead, no open request, and a sign-off in its Stage (Intake, Clarify or Design).`
        : `${wanted} can’t ask now: it needs a waiting Task Lead and no open request.`,
    )
  throw new Error(
    kind === 'sign-off'
      ? 'No demo Task in Intake, Clarify or Design is waiting with its sign-off on. Answer an open request, or rebuild the demo with pnpm ted dev seed --reset.'
      : 'No demo Task Lead is waiting without an open request. Answer one, or rebuild the demo with pnpm ted dev seed --reset.',
  )
}

function steps(kind: DemoAskKind, task: Task, n: number): unknown[] {
  if (kind === 'question') {
    const question = questions[n % questions.length] ?? questions[0]
    return [{ demoRequest: { comment: question } }]
  }
  if (kind === 'permission')
    return [
      {
        permission: {
          tool: 'Bash',
          input: { command: 'ls notes' },
          description: 'List the demo notes folder',
        },
      },
    ]
  return [
    ...(task.stage === 'clarify' && task.clarifyDepth === 'auto'
      ? [{ demoRequest: { depth: { depth: 'none', why: 'The scope is already clear.' } } }]
      : []),
    { demoRequest: { brief } },
    { demoRequest: { outcome: { outcome: 'advance' } } },
  ]
}

async function nextScript(folder: string): Promise<number> {
  const numbers = (await readdir(folder).catch(() => [])).flatMap((name) => {
    const n = /^(\d+)\.json$/.exec(name)?.[1]
    return n === undefined ? [] : [Number(n)]
  })
  return Math.max(0, ...numbers) + 1
}

async function scriptFailure(file: string): Promise<string | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const body = parseJson(text)
  const results = isObject(body) && isArray(body.results) ? body.results : []
  const failed = results.find((r) => isObject(r) && isInteger(r.code) && r.code !== 0)
  if (!isObject(failed)) return undefined
  return `${String(failed.step)}: ${String(failed.stderr)}`
}

export async function askDemo(
  home: string,
  kind: DemoAskKind,
  { task: wanted, timeoutMs = 60_000 }: { task?: string; timeoutMs?: number } = {},
): Promise<DemoAskResult> {
  const client = await connect(home)
  const { task, run } = await pick(client, kind, wanted)
  const folder = path.join(home, 'inputs', 'runs', run)
  await mkdir(folder, { recursive: true })
  const n = await nextScript(folder)
  const file = path.join(folder, `${n}.json`)
  await writeFile(`${file}.tmp`, JSON.stringify({ steps: steps(kind, task, n) }))
  await rename(`${file}.tmp`, file)
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const failure = await scriptFailure(path.join(folder, `${n}.result.json`))
    if (failure) throw new Error(`${task.displayId} couldn’t ask: ${failure}`)
    const waiting = await client.listWaiting()
    if (
      waiting.some(
        (r) => r.source === 'task' && r.taskId === task.id && r.kind === commentKind[kind],
      )
    )
      return { task, kind }
    await sleep(100)
  }
  throw new Error(`${task.displayId}’s ${kind} didn’t reach the Inbox in time.`)
}
