#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { withDaemon } from '@ted/daemon/launch'
import { checkWorkflowPath, NothingToCheckError } from '@ted/daemon/workflow'
import {
  type AgentKind,
  type AgentStageId,
  agentKinds,
  type Banner,
  type ClarifyDepth,
  DaemonClient,
  DaemonUnreachableError,
  type DesignFileInput,
  type DesignReviewInput,
  type Effort,
  efforts,
  type Factory,
  type IntegrationRemedy,
  type IntegrationsHealth,
  isShowing,
  minGhVersion,
  type ProposalInput,
  parseLinearUrl,
  type RepoSetupReport,
  type RoundInput,
  type RunWithConversation,
  readDaemonInfo,
  runTokenFrom,
  type SetTaskReposRequest,
  type TaskLead,
  tedHome,
  tedPaths,
  type ValidateJudgments,
} from '@ted/protocol'
import { AutomationUsageError, automationCommand, automationUsage } from './automation.ts'
import { exportCommand } from './export.ts'

const usage = `Usage:
  ted help                                   Show this list of commands
  ted status                                 Show whether TED is running and every active problem
  ted doctor                                 Run health checks and show every active problem
  ted open                                   Open TED, or bring its window to the front
  ted comment "<text>"                       Post a note on the Run’s Task (reads stdin if no text)
  ted comment --attach <path> … ["<text>"]   Post a note with files; images show in the thread
  ted comment --tutorial "<text>"            In a setup Task, post a Comment with a Tutorial chip
  ted comment --choice "<answer>" … "<question>"
                                             Ask the human a question with choice buttons
  ted ask --supersedes <request-id> [--choice "<answer>" …] "<question>"
                                             Replace your own unanswered request with a new one
  ted ask --round <file> [--supersedes <request-id>]
                                             Post a Clarify round: a JSON file with a title, an
                                             optional summary and questions, each with its
                                             recommended answer and optional choices
  ted ask --close --summary <file>           Close the round the human talked through with you,
                                             posting the file as your summary note
  ted clarify depth none|few|grilling "<why>"
                                             Pick the Clarify depth and say why
  ted clarify too-big "<why>" --settle "<point>" … [--supersedes <request-id>]
                                             Ask the human what to do with a Task too big for
                                             one pull request per repo; each --settle names
                                             something a plan must settle (reads why from stdin
                                             if no text)
  ted outcome advance [--skip] [--task <id>] End the current Stage and move the Task on
                                             (--skip: the Stage had nothing to do; skips its Gate)
                [--changes "<one line>"]       On a re-sign-off, say what changed since the human
                                             approved
                [--design <file>]              At Design, post the design review: a JSON file with
                                             screenshots, a video, a prototype, a Figma link and
                                             Worth your eye (see the Design Stage file)
  ted outcome back --to <Stage> --findings <file>
                                             Send the Task back to an earlier Stage
                At Validate, both take [--review pass|fail] [--review-notes <n>]
                [--visual pass|fail] [--visual-notes <n>] for the confirmation row
  ted outcome ask [--choice "<answer>" …] "<question>"
                                             Ask the human instead of moving on
  ted checks [--name <Check>]                Run the Factory’s Checks now, one after another,
                                             stopping at the first failure
  ted run-app [<App>] [--repo <name>]        Start one of the Task’s Apps, or reuse the running
             [--reason <text>]               one, and wait until it answers; prints its URL.
                                             An iOS simulator App waits for a free simulator;
                                             --reason tells the human why you need one
  ted app screenshot <App> [--repo <name>]   Save a screenshot of an iOS simulator App to the Task
  ted app record <App> --start|--stop        Record an iOS simulator App’s screen; --stop saves
                                             the video to the Task
  ted brief write [--file <file>]            Write a new version of the Task brief (reads stdin
                                             without --file)
  ted brief show                             Show the latest Task brief
  ted status [--task <id>] "<text>"          Set the Task’s activity line
  ted run start [--agent claude|codex] [--model <name>] [--effort <level>] --prompt-file <file>
                [--name <name>] [--own-worktree]
                                             Start a sub-agent on this Task (Task Lead only);
                                             prints its Run ID
  ted run start --reviewer --prompt-file <file>
                                             Start the reviewer: TED picks its agent, model and
                                             effort from the reviewer setting
  ted run wait <id>                          Wait for a sub-agent’s final message and print it
  ted run send <id> "<text>"                 Send a sub-agent a follow-up (reads stdin if no text)
  ted run stop <id>                          Stop a sub-agent
  ted task create [--factory <key>] [--start] [--source <url>] [--description "<text>"]
                [--sentry-id <SHORT-ID>] [--follow-up <id>] "<title>"
                                             Create a Task (--start starts it); a Linear URL
                                             as the source fills it in from Linear. TED refuses
                                             a source it already tracks; --follow-up revisits
                                             a Done Task. --sentry-id puts Fixes <SHORT-ID> in
                                             the pull request
  ted peers [--offset <n>]                  See current Tasks in this Lead’s Factory
  ted peers show <Task>                     Read a peer’s description and latest brief
  ted peers watch [--cursor <cursor>] [--timeout <seconds>]
                                             Wait up to 25 seconds for activity to change
  ted peers send <Task> --operation <unique-id> "<text>"
                                             Send an attributed peer note (stdin if no text)
  ted peers inbox [--offset <n>]            Read received messages and delivery receipts
  ted coordinator tasks [--offset <n>]       Read this Coordinator’s Factory Tasks and their open requests
  ted coordinator task <id> [--offset <n>]   Read a Task, brief, open requests, Comments and version
  ted coordinator start <id> --operation <id> --version <version>
  ted coordinator move <id> --after <id> / --before <id> --operation <id> --version <version> --neighbours <json>
                                             Start or reorder waiting Tasks (Coordinator only)
  ted coordinator tell <id> --operation <id> --version <version> [--message "<text>"]
                                             Send a message to a Task’s Task Lead, on the
                                             human’s instruction; reads stdin if no --message
                                             (Coordinator only)
  ted coordinator answer <id> --request <comment-id> --operation <id> --version <version>
                         [--choice "<answer>"] [--message "<text>"]
                         [--approve | --request-changes] [--skip-rows <json>] [--start-unblocked]
                         [--answers <json> | --recommended]
                                             Answer an open request on a Task, on the human’s
                                             instruction: a question (--choice, --message), a
                                             Gate request, sign-off or proposal (--approve or
                                             --request-changes), or a Clarify round (--answers
                                             or --recommended); never a permission prompt,
                                             simulator ask or the Linear team ask
                                             (Coordinator only)
  ted coordinator resume <id> --operation <id> --version <version> [--message "<text>"]
                                             Resume a stopped or failed Task through the queue
                                             (Coordinator only)
  ted task list                              List Tasks with their Stages
  ted task start <id>                        Start a Task from Backlog
  ted task propose --file <file> [--supersedes <request-id>]
                                             Propose splitting the Task: a JSON file with a
                                             title, an optional summary and tasks, each with a
                                             title, scope, optional description, priority and
                                             blockedBy row numbers; row 1 is this Task
  ted task block [<id>] --by <id>            Make a Task wait until another Task merges
  ted task unblock [<id>] [--by <id>]        Remove one blocker, or all of them
  ted task repos set <name> …                Set which of the Factory’s repos the Task changes
  ted task repos add <name>                  Add a repo; prints its setup output when done
  ted task repos remove <name> [--yes]       Remove a repo (--yes: even if it has commits)
  ted export --factory <key> [--format json|markdown] --output <path>
                                             Export a Factory’s retained Tasks and history
  ted backup list                            List backups of TED’s data, newest first
  ted backup restore <name> [--yes]          Restore a backup (asks before stopping Runs)
  ted task lead <id> claude|codex [--model <name>] [--effort <level>]
                                             Set the Task Lead’s agent, model and effort
  ted task lead <id> --default-model         Run this Task Lead on the CLI’s default model
                                             when its model isn’t available
  ted workflow check [<path>]                Check workflow.yaml and Stage files (default: .ted)
  ted dev run show <run-id>                  Show a Run’s state and Conversation
${automationUsage}

Inside a Run, commands act on the Run’s own Task (TED_TASK).`

class UsageError extends Error {}

function parse() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        offset: { type: 'string' },
        timeout: { type: 'string' },
        cursor: { type: 'string' },
        operation: { type: 'string' },
        version: { type: 'string' },
        neighbours: { type: 'string' },
        message: { type: 'string' },
        request: { type: 'string' },
        approve: { type: 'boolean' },
        'request-changes': { type: 'boolean' },
        answers: { type: 'string' },
        recommended: { type: 'boolean' },
        'skip-rows': { type: 'string' },
        'start-unblocked': { type: 'boolean' },
        after: { type: 'string' },
        before: { type: 'string' },
        choice: { type: 'string', multiple: true },
        attach: { type: 'string', multiple: true },
        agent: { type: 'string' },
        'default-model': { type: 'boolean' },
        design: { type: 'string' },
        tutorial: { type: 'boolean' },
        effort: { type: 'string' },
        model: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        'follow-up': { type: 'string' },
        schedule: { type: 'string' },
        template: { type: 'string' },
        off: { type: 'boolean' },
        factory: { type: 'string' },
        format: { type: 'string' },
        output: { type: 'string' },
        file: { type: 'string' },
        findings: { type: 'string' },
        'own-worktree': { type: 'boolean' },
        'prompt-file': { type: 'string' },
        review: { type: 'string' },
        'review-notes': { type: 'string' },
        reviewer: { type: 'boolean' },
        repo: { type: 'string' },
        visual: { type: 'string' },
        'visual-notes': { type: 'string' },
        round: { type: 'string' },
        settle: { type: 'string', multiple: true },
        source: { type: 'string' },
        'sentry-id': { type: 'string' },
        by: { type: 'string' },
        start: { type: 'boolean' },
        stop: { type: 'boolean' },
        reason: { type: 'string' },
        supersedes: { type: 'string' },
        skip: { type: 'boolean' },
        changes: { type: 'string' },
        close: { type: 'boolean' },
        summary: { type: 'string' },
        task: { type: 'string' },
        to: { type: 'string' },
        yes: { type: 'boolean' },
      },
    })
  } catch {
    return undefined
  }
}

const parsed = parse()
const [group, command, ...rest] = parsed?.positionals ?? []
const options = parsed?.values ?? {}
const home = tedHome()

function inPlan(): boolean {
  return options.task === undefined && !process.env.TED_TASK && !!process.env.TED_PLAN
}

function taskRef(given?: string): string {
  const ref = given ?? options.task ?? process.env.TED_TASK
  if (!ref) throw new UsageError('outside a Run, name the Task with --task <id>')
  return ref
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const mediaTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
}

function mediaTypeOf(file: string): string {
  return mediaTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

try {
  if (!parsed) {
    throw new UsageError('')
  } else if (group === 'help' && command === undefined) {
    console.log(usage)
  } else if (group === 'export' && command === undefined) {
    console.log(await exportCommand(home, options))
  } else if (group === 'status' && command === undefined) {
    await status()
  } else if (group === 'doctor' && command === undefined) {
    await doctor()
  } else if (group === 'open' && command === undefined) {
    await openApp()
  } else if (group === 'peers') {
    const offset = Number(options.offset ?? '0')
    const timeout = Number(options.timeout ?? '25')
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new UsageError('offset must be a nonnegative integer')
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 25)
      throw new UsageError('timeout must be between 0 and 25 seconds')
    await withDaemon(home, async (client) => {
      if (command === undefined) console.log(JSON.stringify(await client.peers(offset)))
      else if (command === 'show' && rest.length === 1)
        console.log(JSON.stringify(await client.peer(rest[0] ?? '')))
      else if (command === 'inbox' && rest.length === 0)
        console.log(JSON.stringify(await client.peerInbox(offset)))
      else if (command === 'watch' && rest.length === 0) {
        const cursor = options.cursor ?? (await client.peers()).cursor
        console.log(JSON.stringify(await client.watchPeers(cursor, timeout)))
      } else if (command === 'send' && rest.length >= 1) {
        if (!options.operation)
          throw new UsageError('operation is required for replay-safe sending')
        const text = rest.slice(1).join(' ') || (await readStdin())
        console.log(
          JSON.stringify(
            await client.sendPeer(rest[0] ?? '', { operation: options.operation, text }),
          ),
        )
      } else
        throw new UsageError(
          'Use peers, peers show <Task>, peers watch, peers send <Task> <text>, or peers inbox',
        )
    })
  } else if (group === 'coordinator') {
    const page = Number(options.offset ?? '0')
    if (!Number.isSafeInteger(page) || page < 0)
      throw new UsageError('offset must be a nonnegative integer')
    await withDaemon(home, async (client) => {
      if (command === 'tasks' && rest.length === 0)
        console.log(JSON.stringify(await client.coordinatorTasks(page)))
      else if (command === 'task' && rest.length === 1)
        console.log(JSON.stringify(await client.coordinatorTask(rest[0] ?? '', page)))
      else if ((command === 'start' || command === 'move') && rest.length === 1) {
        if (!options.operation || !options.version)
          throw new UsageError('operation and version are required')
        console.log(
          JSON.stringify(
            await client.coordinatorAct(rest[0] ?? '', command, {
              operation: options.operation,
              version: options.version,
              ...(options.after && { after: options.after }),
              ...(options.before && { before: options.before }),
              ...(options.neighbours && {
                neighbours: JSON.parse(options.neighbours) as Record<string, string>,
              }),
            }),
          ),
        )
      } else if (command === 'resume' && rest.length === 1) {
        if (!options.operation || !options.version)
          throw new UsageError('operation and version are required')
        const message = options.message?.trim()
        console.log(
          JSON.stringify(
            await client.coordinatorAct(rest[0] ?? '', command, {
              operation: options.operation,
              version: options.version,
              ...(message && { message }),
            }),
          ),
        )
      } else if ((command === 'tell' || command === 'answer') && rest.length === 1) {
        if (!options.operation || !options.version)
          throw new UsageError('operation and version are required')
        const choices = options.choice ?? []
        const decided = options.approve || options['request-changes']
        const round = options.answers !== undefined || options.recommended
        if (command === 'tell' && (options.request || choices.length > 0 || decided || round))
          throw new UsageError('tell takes only --message')
        if (command === 'answer' && !options.request)
          throw new UsageError('name the request with --request <comment-id>')
        if (command === 'answer' && choices.length > 1) throw new UsageError('give one --choice')
        if (options.approve && options['request-changes'])
          throw new UsageError('give --approve or --request-changes, not both')
        const given = choices.length > 0 || options.approve || round
        const typed = options.message ?? (command === 'tell' || !given ? await readStdin() : '')
        const message = typed.trim() === '' ? undefined : typed.trim()
        if (message === undefined && (command === 'tell' || !given))
          throw new UsageError(
            command === 'tell'
              ? 'give the message with --message "<text>" or on stdin'
              : options['request-changes']
                ? 'give the changes to ask for with --message "<text>" or on stdin'
                : 'give --choice, --approve, --request-changes, --answers, --recommended or --message',
          )
        const json = (name: 'answers' | 'skip-rows') => {
          const raw = options[name]
          if (raw === undefined) return undefined
          try {
            return JSON.parse(raw) as unknown
          } catch {
            throw new UsageError(`--${name} must be JSON`)
          }
        }
        const answers = json('answers')
        const skipRows = json('skip-rows')
        console.log(
          JSON.stringify(
            await client.coordinatorAct(rest[0] ?? '', command, {
              operation: options.operation,
              version: options.version,
              ...(message !== undefined && { message }),
              ...(command === 'answer' && { request: options.request }),
              ...(choices[0] !== undefined && { choice: choices[0] }),
              ...(options.approve && { decision: 'approve' as const }),
              ...(options['request-changes'] && { decision: 'request-changes' as const }),
              ...(answers !== undefined && {
                answers: answers as { answer: string; note?: string }[],
              }),
              ...(options.recommended && { recommended: true }),
              ...(skipRows !== undefined && { skipRows: skipRows as number[] }),
              ...(options['start-unblocked'] && { startUnblocked: true }),
            }),
          ),
        )
      } else
        throw new UsageError('Use coordinator tasks, task, start, move, tell, answer or resume')
    })
  } else if (group === 'automation') {
    await automationCommand(home, command, rest, options)
  } else if (
    group === 'comment' &&
    options.task === undefined &&
    !process.env.TED_TASK &&
    process.env.TED_AUTOMATION
  ) {
    const body = [command, ...rest].filter((s) => s !== undefined).join(' ') || (await readStdin())
    if (body.trim() === '') throw new UsageError('give the Comment as text or on stdin')
    const choices = options.choice ?? []
    const comment = await withDaemon(home, (client) =>
      client.postAutomationComment({ body, ...(choices.length > 0 && { choices }) }),
    )
    console.log(
      comment.kind === 'question'
        ? `Asked the human (request ${comment.id}). TED sends you their answer.`
        : 'Posted',
    )
  } else if (group === 'comment') {
    const ref = taskRef()
    const files = options.attach ?? []
    const text = [command, ...rest].filter((s) => s !== undefined).join(' ')
    const body = text || (await readStdin())
    if (body.trim() === '' && files.length === 0) {
      throw new UsageError('give the Comment as text or on stdin')
    }
    const choices = options.choice ?? []
    if (files.length > 0 && choices.length > 0) {
      throw new UsageError('a question can’t carry files; post them in a note first')
    }
    const contents = await Promise.all(
      files.map(async (file) => ({
        name: path.basename(file),
        mediaType: mediaTypeOf(file),
        bytes: new Uint8Array(await readFile(file)),
      })),
    )
    const comment = await withDaemon(home, async (client) => {
      const attachments = []
      for (const { bytes, ...file } of contents) {
        attachments.push(await client.uploadTaskAttachment(ref, file, bytes))
      }
      return client.postComment(ref, {
        body,
        ...(choices.length > 0 && { choices }),
        ...(attachments.length > 0 && { attachments }),
        ...(options.tutorial === true && { tutorial: true }),
      })
    })
    console.log(
      comment.kind === 'question'
        ? `Asked the human (request ${comment.id}). TED sends you their answer.`
        : 'Posted',
    )
  } else if (
    group === 'ask' &&
    options.close === true &&
    options.summary !== undefined &&
    command === undefined
  ) {
    const ref = taskRef()
    const summary = await readFile(path.resolve(options.summary), 'utf8')
    if (summary.trim() === '') throw new UsageError('the summary file is empty')
    const round = await withDaemon(home, (client) => client.closeRound(ref, { summary }))
    console.log(
      `Closed Round ${round.round?.number ?? ''} as answered in Talk it through and posted your summary. If anything is still open, ask it in a new round with \`ted ask --round <file>\`.`,
    )
  } else if (
    inPlan() &&
    ((group === 'ask' && options.round !== undefined && command === undefined) ||
      (group === 'task' && command === 'propose' && rest.length === 0))
  ) {
    const supersedes = options.supersedes
    if (group === 'task' && options.file === undefined) {
      throw new UsageError('give the proposal with --file <file>')
    }
    const input =
      group === 'ask'
        ? { round: await readRound(options.round ?? '') }
        : { proposal: await readJsonFile<ProposalInput>(options.file ?? '', 'proposal') }
    const request = await withDaemon(home, (client) =>
      client.postPlanRequest({ ...input, ...(supersedes !== undefined && { supersedes }) }),
    )
    const what =
      request.kind === 'round'
        ? `Round ${request.round?.number ?? ''}`
        : `a proposal of ${request.proposal?.rows.length ?? 0} rows`
    console.log(
      `${supersedes === undefined ? 'Posted' : `Replaced request ${supersedes} with`} ${what} (request ${request.id}). TED sends you the human’s answer.`,
    )
  } else if (group === 'ask' && options.round !== undefined && command === undefined) {
    const ref = taskRef()
    const round = await readRound(options.round)
    const supersedes = options.supersedes
    const request = await withDaemon(home, (client) =>
      client.postComment(ref, { round, ...(supersedes !== undefined && { supersedes }) }),
    )
    console.log(
      `${supersedes === undefined ? 'Posted' : `Replaced request ${supersedes} with`} Round ${request.round?.number ?? ''} (request ${request.id}). TED sends you the human’s answers.`,
    )
  } else if (group === 'clarify' && command === 'depth' && rest.length >= 1) {
    const ref = taskRef()
    const [depth = '', ...why] = rest
    if (!['none', 'few', 'grilling'].includes(depth)) {
      throw new UsageError('the depth is none, few or grilling')
    }
    const reason = why.join(' ')
    if (reason.trim() === '') throw new UsageError('say why you picked this depth')
    const task = await withDaemon(home, (client) =>
      client.setClarifyDepth(ref, { depth: depth as ClarifyDepth, why: reason }),
    )
    console.log(`${task.displayId}’s Clarify depth is ${depth}`)
  } else if (group === 'clarify' && command === 'too-big') {
    const ref = taskRef()
    const why = rest.join(' ') || (await readStdin())
    if (why.trim() === '') throw new UsageError('say why the Task is too big')
    const settle = options.settle ?? []
    if (settle.length === 0) {
      throw new UsageError('name what a plan must settle with --settle "<point>"')
    }
    const supersedes = options.supersedes
    const request = await withDaemon(home, (client) =>
      client.postComment(ref, {
        sizeCheck: { why, settle },
        ...(supersedes !== undefined && { supersedes }),
      }),
    )
    console.log(
      `Asked the human what to do with this Task (request ${request.id}). TED sends you their answer.`,
    )
  } else if (group === 'task' && command === 'propose' && rest.length === 0) {
    const ref = taskRef()
    if (options.file === undefined) throw new UsageError('give the proposal with --file <file>')
    const proposal = await readJsonFile<ProposalInput>(options.file, 'proposal')
    const supersedes = options.supersedes
    const request = await withDaemon(home, (client) =>
      client.postComment(ref, { proposal, ...(supersedes !== undefined && { supersedes }) }),
    )
    const rows = request.proposal?.rows.length ?? 0
    console.log(
      `${supersedes === undefined ? 'Posted' : `Replaced request ${supersedes} with`} a proposal of ${rows} rows (request ${request.id}). TED sends you the human’s answer.`,
    )
  } else if (group === 'ask' && options.supersedes !== undefined) {
    const ref = taskRef()
    const supersedes = options.supersedes
    const body = [command, ...rest].filter((s) => s !== undefined).join(' ') || (await readStdin())
    if (body.trim() === '') throw new UsageError('give the new request as text or on stdin')
    const choices = options.choice ?? []
    const request = await withDaemon(home, (client) =>
      client.postComment(ref, { body, supersedes, ...(choices.length > 0 && { choices }) }),
    )
    console.log(
      `Replaced request ${supersedes} with request ${request.id}. TED sends you their answer.`,
    )
  } else if (group === 'status' && command !== undefined) {
    const ref = taskRef()
    const text = [command, ...rest].join(' ')
    await withDaemon(home, (client) => client.setActivity(ref, text))
    console.log('Activity line set')
  } else if (group === 'outcome' && command === 'advance' && rest.length === 0) {
    const ref = taskRef()
    const skip = options.skip === true
    const judged = judgments()
    const changes = options.changes
    const review = options.design === undefined ? undefined : await readDesign(options.design)
    const result = await withDaemon(home, async (client) => {
      const design = review && (await uploadDesign(client, ref, review))
      return client.reportOutcome(ref, {
        outcome: 'advance',
        ...(skip && { skip }),
        ...(judged && { judged }),
        ...(changes !== undefined && { changes }),
        ...(design && { design }),
      })
    })
    console.log(result.message)
  } else if (group === 'outcome' && command === 'back' && rest.length === 0) {
    const ref = taskRef()
    const to = options.to?.toLowerCase()
    if (to === undefined) throw new UsageError('name the Stage to go back to with --to <Stage>')
    if (options.findings === undefined) {
      throw new UsageError('give the Findings file with --findings <file>')
    }
    const findings = await readFile(path.resolve(options.findings), 'utf8')
    if (findings.trim() === '') throw new UsageError('the Findings file is empty')
    const judged = judgments()
    const result = await withDaemon(home, (client) =>
      client.reportOutcome(ref, {
        outcome: 'back',
        to: to as AgentStageId,
        findings,
        ...(judged && { judged }),
      }),
    )
    console.log(result.message)
  } else if (group === 'outcome' && command === 'ask') {
    const ref = taskRef()
    const question = rest.join(' ') || (await readStdin())
    if (question.trim() === '') throw new UsageError('give the question as text or on stdin')
    const choices = options.choice ?? []
    const result = await withDaemon(home, (client) =>
      client.reportOutcome(ref, {
        outcome: 'ask',
        question,
        ...(choices.length > 0 && { choices }),
      }),
    )
    console.log(result.message)
  } else if (group === 'run' && command === 'start' && rest.length === 0) {
    await startSubAgent()
  } else if (group === 'run' && command === 'wait' && rest.length === 1) {
    await waitForSubAgent(rest[0] ?? '')
  } else if (group === 'run' && command === 'send' && rest.length >= 1) {
    const [id = '', ...words] = rest
    const text = words.join(' ') || (await readStdin())
    if (text.trim() === '') throw new UsageError('give the message as text or on stdin')
    const sub = await withDaemon(home, (client) => client.sendSubAgent(id, text))
    console.log(
      `Sent to sub-agent “${printable(sub.name)}”. Run \`ted run wait ${sub.id}\` for its answer.`,
    )
  } else if (group === 'run' && command === 'boundary' && rest.length === 0) {
    const runId = process.env.TED_RUN
    if (!runId) throw new UsageError('ted run boundary only works inside a Run')
    await withDaemon(home, (client) => client.reachedBoundary(runId))
  } else if (group === 'run' && command === 'stop' && rest.length === 1) {
    const sub = await withDaemon(home, (client) => client.stopSubAgent(rest[0] ?? ''))
    console.log(`Stopped sub-agent “${printable(sub.name)}”`)
  } else if (group === 'run-app' && rest.length === 0) {
    await runApp(command)
  } else if (group === 'app' && command === 'screenshot' && rest.length === 1) {
    const ref = taskRef()
    const app = { name: rest[0] ?? '', ...(options.repo && { repo: options.repo }) }
    const shot = await withDaemon(home, (client) => client.screenshotApp(ref, app))
    console.log(`Saved ${printable(shot.attachment?.name ?? 'the screenshot')} to the Task`)
  } else if (group === 'app' && command === 'record' && rest.length === 1) {
    if (options.start === options.stop) throw new UsageError('say --start or --stop')
    const ref = taskRef()
    const app = { name: rest[0] ?? '', ...(options.repo && { repo: options.repo }) }
    const action = options.start ? 'start' : 'stop'
    const capture = await withDaemon(home, (client) => client.recordApp(ref, { ...app, action }))
    console.log(
      action === 'start'
        ? `Recording ${printable(app.name)}. Stop with ted app record ${printable(app.name)} --stop.`
        : `Saved ${printable(capture.attachment?.name ?? 'the recording')} to the Task`,
    )
  } else if (group === 'checks' && command === undefined) {
    const ref = taskRef()
    const name = options.name
    const { checkRun, report } = await withDaemon(home, async (client) => {
      const started = await client.runChecks(ref, name === undefined ? {} : { name })
      for (;;) {
        const current = await client.getCheckRun(started.id)
        if (current.checkRun.finishedAt !== undefined) return current
        await sleep(500)
      }
    })
    console.log(printable(report ?? ''))
    if (checkRun.outcome !== 'passed') process.exitCode = 1
  } else if (group === 'brief' && command === 'write' && rest.length === 0) {
    const ref = taskRef()
    const text =
      options.file === undefined
        ? await readStdin()
        : await readFile(path.resolve(options.file), 'utf8')
    if (text.trim() === '') throw new UsageError('give the Task brief with --file or on stdin')
    const brief = await withDaemon(home, (client) => client.writeBrief(ref, text))
    console.log(`Wrote version ${brief.version} of the Task brief`)
  } else if (group === 'brief' && command === 'show' && rest.length === 0) {
    const ref = taskRef()
    const brief = await withDaemon(home, (client) => client.getBrief(ref))
    process.stdout.write(printable(brief.text))
  } else if (
    group === 'task' &&
    command === 'create' &&
    (rest.length > 0 || options.source !== undefined)
  ) {
    const title = rest.join(' ')
    const { factory, source, start, description } = options
    const followUp = options['follow-up']
    const sentryId = options['sentry-id']
    const task = await withDaemon(home, async (client) => {
      if (source !== undefined && parseLinearUrl(source) && !runTokenFrom(process.env)) {
        const lookup = await client.lookupLinear(source)
        if (lookup.state === 'no-key') {
          console.error(
            'No Linear API key, so the Task was created with the link only. Add one in Settings → Integrations.',
          )
        } else if (lookup.state === 'failed') {
          console.error(printable(lookup.error))
        }
      }
      return client.createTask({
        ...(title !== '' && { title }),
        ...(factory !== undefined && { factory }),
        ...(source !== undefined && { source }),
        ...(sentryId !== undefined && { sentryId }),
        ...(description !== undefined && { description }),
        ...(followUp !== undefined && { followUp }),
        ...(start !== undefined && { start }),
      })
    })
    console.log(`Created ${task.displayId}  ${printable(task.title)}`)
  } else if (group === 'task' && command === 'list' && rest.length === 0) {
    const tasks = await withDaemon(home, (client) => client.listTasks())
    console.log(
      tasks.length === 0
        ? 'No Tasks yet.'
        : tasks.map((t) => `${t.displayId}  ${stageName(t.stage)}  ${t.title}`).join('\n'),
    )
  } else if (group === 'task' && command === 'start' && rest.length === 1) {
    const ref = rest[0] ?? ''
    const task = await withDaemon(home, (client) => client.startTask(ref))
    console.log(
      task.status?.kind === 'queued'
        ? `Queued ${task.displayId} · ${'place' in task.status ? `${ordinal(task.status.place)} in line for a slot` : task.status.hold}`
        : `Started ${task.displayId} on branch ${task.branch}`,
    )
  } else if (group === 'task' && command === 'block' && rest.length <= 1) {
    const ref = taskRef(rest[0])
    const by = options.by
    if (by === undefined) throw new UsageError('name the blocker with --by <id>')
    const task = await withDaemon(home, (client) => client.blockTask(ref, by))
    console.log(`${task.displayId} waits for ${by}`)
  } else if (group === 'task' && command === 'unblock' && rest.length <= 1) {
    const ref = taskRef(rest[0])
    const by = options.by
    const task = await withDaemon(home, (client) => client.unblockTask(ref, by))
    console.log(
      by === undefined
        ? `${task.displayId} no longer waits for any Task`
        : `${task.displayId} no longer waits for ${by}`,
    )
  } else if (
    group === 'task' &&
    command === 'repos' &&
    (rest[0] === 'set' || rest[0] === 'add' || rest[0] === 'remove') &&
    rest.length >= 2
  ) {
    await taskRepos(rest[0], rest.slice(1))
  } else if (group === 'backup' && command === 'list' && rest.length === 0) {
    const { backups } = await withDaemon(home, (client) => client.listBackups())
    console.log(
      backups.length === 0
        ? 'No backups yet.'
        : backups.map((b) => `${b.name}  ${b.kind}  ${formatDate(b.takenAt)}`).join('\n'),
    )
  } else if (group === 'backup' && command === 'restore' && rest.length === 1) {
    await restoreBackup(rest[0] ?? '')
  } else if (
    group === 'task' &&
    command === 'lead' &&
    rest.length === 1 &&
    options['default-model']
  ) {
    const ref = rest[0] ?? ''
    const task = await withDaemon(home, (client) => client.useDefaultModel(ref))
    console.log(`${task.displayId}’s Task Lead now runs on the default model`)
  } else if (group === 'task' && command === 'lead' && rest.length === 2) {
    const [ref = '', agent = ''] = rest
    const { model, effort } = options
    if (!agentKinds.includes(agent as AgentKind))
      throw new UsageError('agent must be claude or codex')
    if (effort !== undefined && !efforts.includes(effort as Effort)) {
      throw new UsageError(`--effort must be one of ${efforts.join(', ')}`)
    }
    const lead: TaskLead = {
      agent: agent as AgentKind,
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort: effort as Effort }),
    }
    const task = await withDaemon(home, (client) => client.setTaskLead(ref, lead))
    console.log(`${task.displayId}’s Task Lead is ${describeLead(task.lead ?? lead)}`)
  } else if (group === 'workflow' && command === 'check' && rest.length <= 1) {
    await workflowCheck(rest[0] ?? '.ted')
  } else if (group === 'dev' && command === 'run' && rest[0] === 'show' && rest.length === 2) {
    const id = rest[1] ?? ''
    console.log(formatRun(await withDaemon(home, (client) => client.getRun(id))))
  } else {
    throw new UsageError('')
  }
} catch (error) {
  if (error instanceof NothingToCheckError) {
    console.error(`ted: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AutomationUsageError) {
    console.error(error.message === '' ? usage : `ted: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof UsageError) {
    console.error(error.message === '' ? usage : `ted: ${error.message}`)
    process.exitCode = 2
  } else {
    console.error(`ted: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

async function taskRepos(action: 'set' | 'add' | 'remove', names: string[]): Promise<void> {
  const ref = taskRef()
  const confirm = options.yes === true
  const request: SetTaskReposRequest =
    action === 'set'
      ? { set: names, confirm }
      : action === 'add'
        ? { add: names }
        : { remove: names, confirm }
  const { changed, setups } = await withDaemon(home, async (client) => {
    const changed = await client.setTaskRepos(ref, request)
    const setups: RepoSetupReport[] = []
    if (changed.confirm) return { changed, setups }
    for (const name of changed.added) {
      for (;;) {
        const report = await client.repoSetup(ref, name)
        if (report.state !== 'running') {
          setups.push(report)
          break
        }
        await sleep(500)
      }
    }
    return { changed, setups }
  })
  if (changed.confirm) {
    for (const { name, commits } of changed.confirm) {
      console.error(
        `ted: ${printable(name)}’s worktree has ${commits} ${commits === 1 ? 'commit' : 'commits'} that would be lost. Ask the human first; if they agree, run the command again with --yes.`,
      )
    }
    process.exitCode = 1
    return
  }
  for (const report of setups) console.log(printable(addedLine(report)))
  for (const name of changed.removed) {
    console.log(`Removed ${printable(name)}; its worktree is gone.`)
  }
  console.log(`${changed.task.displayId}’s repos: ${changed.repos.map(printable).join(', ')}`)
}

function addedLine(report: RepoSetupReport): string {
  if (report.worktree === undefined) {
    return `Added ${report.name}. TED makes its worktree when the Task starts.`
  }
  const added = `Added ${report.name} at ${report.worktree}.`
  if (report.state === 'none' || report.command === undefined) return added
  const how =
    report.state === 'passed'
      ? 'passed'
      : report.state === 'timed-out'
        ? 'timed out'
        : `failed${report.exitCode !== undefined ? ` with exit code ${report.exitCode}` : ''}`
  const output = report.output.trimEnd()
  return [
    `${added} Its setup, \`${report.command}\`, ${how}.`,
    ...(output === '' ? [] : ['Setup output:', output]),
  ].join('\n')
}

function judgments(): ValidateJudgments | undefined {
  const one = (name: 'review' | 'visual') => {
    const result = options[name]
    const notes = options[`${name}-notes`]
    if (result === undefined && notes === undefined) return undefined
    if (result !== undefined && result !== 'pass' && result !== 'fail') {
      throw new UsageError(`--${name} must be pass or fail`)
    }
    const count = notes === undefined ? undefined : Number(notes)
    if (count !== undefined && !(Number.isInteger(count) && count >= 0)) {
      throw new UsageError(`--${name}-notes must be a whole number`)
    }
    return { passed: result !== 'fail', ...(count !== undefined && { notes: count }) }
  }
  const review = one('review')
  const visual = one('visual')
  if (!review && !visual) return undefined
  return { ...(review && { review }), ...(visual && { visual }) }
}

async function startSubAgent(): Promise<void> {
  const ref = taskRef()
  const { agent, model, effort, name } = options
  const file = options['prompt-file']
  if (file === undefined)
    throw new UsageError('give the sub-agent’s instructions with --prompt-file <file>')
  if (agent !== undefined && !agentKinds.includes(agent as AgentKind)) {
    throw new UsageError('--agent must be claude or codex')
  }
  if (effort !== undefined && !efforts.includes(effort as Effort)) {
    throw new UsageError(`--effort must be one of ${efforts.join(', ')}`)
  }
  const prompt = await readFile(path.resolve(file), 'utf8')
  if (prompt.trim() === '') throw new UsageError('the prompt file is empty')
  const sub = await withDaemon(home, (client) =>
    client.startSubAgent(ref, {
      prompt,
      ...(agent !== undefined && { agent: agent as AgentKind }),
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort: effort as Effort }),
      ...(name !== undefined && { name }),
      ...(options['own-worktree'] && { ownWorktree: true }),
      ...(options.reviewer && { reviewer: true }),
    }),
  )
  const when = sub.state === 'queued' ? 'queued for a free slot' : 'started'
  console.log(`Started sub-agent “${printable(sub.name)}” (Run ${sub.id}), ${when}.`)
  console.log(`Run \`ted run wait ${sub.id}\` for its final message.`)
}

async function waitForSubAgent(id: string): Promise<void> {
  const result = await withDaemon(home, async (client) => {
    for (;;) {
      const current = await client.waitForSubAgent(id)
      if (current.done) return current
    }
  })
  if (result.message !== undefined) process.stdout.write(`${printable(result.message).trimEnd()}\n`)
  if (result.state === 'failed') {
    console.error(`ted: sub-agent “${printable(result.name)}” failed`)
    if (result.error !== undefined) console.error(printable(result.error))
    process.exitCode = 1
  } else if (result.state === 'stopped') {
    console.error(
      `ted: sub-agent “${printable(result.name)}” was stopped${result.error ? `: ${printable(result.error)}` : ''}`,
    )
    process.exitCode = 1
  }
}

async function restoreBackup(name: string): Promise<void> {
  await withDaemon(home, async (client) => {
    const { backups, activeRuns } = await client.listBackups()
    if (!backups.some((b) => b.name === name)) throw new Error(`no backup ${name}`)
    if (activeRuns > 0 && !options.yes) {
      const runs = activeRuns === 1 ? '1 Run' : `${activeRuns} Runs`
      const them = activeRuns === 1 ? 'it' : 'them'
      process.stdout.write(`Restoring stops ${runs}. Stop ${them} and restore? [y/N] `)
      if (!/^y(es)?$/i.test((await readLine()).trim())) throw new Error('nothing restored')
    }
    const result = await client.restoreBackup({ name, stopRuns: true })
    if (result.stoppedRuns > 0) {
      console.log(`Stopped ${result.stoppedRuns === 1 ? '1 Run' : `${result.stoppedRuns} Runs`}.`)
    }
    console.log(`Restored ${result.restored}.`)
    console.log(`Your data from before the restore is in backup ${result.saved}.`)
  })
}

async function readLine(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    const newline = text.indexOf('\n')
    if (newline >= 0) return text.slice(0, newline)
  }
  return text
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function problems(): Promise<{ pid: number | undefined; banners: string[]; stops: boolean }> {
  const { banners, factories } = await withDaemon(home, async (client) => ({
    banners: await client.listBanners(),
    factories: await client.listFactories(),
  }))
  const pid = (await readDaemonInfo(home))?.pid
  return {
    pid,
    banners: formatBanners(banners, factories),
    stops: banners.some((b) => b.severity === 'stops-work'),
  }
}

async function openApp(): Promise<void> {
  const info = await readDaemonInfo(home)
  const token = runTokenFrom(process.env) ?? info?.token
  const result = await (info ? new DaemonClient(info, token).openApp() : undefined)?.catch(
    (error: unknown) => {
      if (error instanceof DaemonUnreachableError) return undefined
      throw error
    },
  )
  if (result?.opened) return void console.log('Opened TED')
  const app = process.env.TED_APP_EXECUTABLE
  if (!app) {
    console.error('ted: TED isn’t open. Open it from your app launcher.')
    process.exitCode = 1
    return
  }
  launchApp(app)
  console.log('Opening TED')
}

function launchApp(executable: string): void {
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const bundle = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1]
  const [command, args] = bundle ? ['/usr/bin/open', [bundle]] : [executable, []]
  spawn(command, args, { detached: true, stdio: 'ignore', env }).unref()
}

async function status(): Promise<void> {
  const { pid, banners } = await problems()
  console.log(`TED’s background process is running (pid ${pid ?? 'unknown'})`)
  console.log(banners.join('\n'))
}

async function doctor(): Promise<void> {
  const health = await withDaemon(home, (client) => client.checkIntegrations())
  const { pid, banners, stops } = await problems()
  console.log(`✓ TED’s background process is running (pid ${pid ?? 'unknown'})`)
  const lines = integrationLines(health)
  console.log(lines.map((line) => printable(line)).join('\n'))
  console.log(banners.join('\n'))
  if (stops || health.git.state === 'not-installed') process.exitCode = 1
}

function remedyText(fix: IntegrationRemedy | undefined): string {
  return fix === undefined ? '' : 'url' in fix ? fix.url : fix.command
}

function integrationLines({ git, github }: IntegrationsHealth): string[] {
  const identity = [git.name, git.email && `<${git.email}>`].filter(Boolean).join(' ')
  const gitLine =
    git.state === 'not-installed'
      ? `✗ git not found · ${remedyText(git.fix)}`
      : git.state === 'no-identity'
        ? `! git ${git.version} has no name or email set · ${(git.copy ?? []).join(' && ')}`
        : `✓ git ${git.version} · ${identity}`
  const { cli } = github
  const ghLine =
    cli.state === 'ready'
      ? `✓ gh ${cli.version} · ${cli.path}`
      : cli.state === 'not-installed'
        ? `✗ gh not found · ${remedyText(cli.fix)}`
        : cli.state === 'too-old'
          ? `✗ gh ${cli.version} is older than ${minGhVersion} · ${remedyText(cli.fix)}`
          : `✗ gh isn’t working · ${cli.error ?? ''}`
  const hostLines =
    cli.state === 'ready'
      ? github.hosts.map((host) => {
          if (host.state === 'ready') return `✓ ${host.host} · signed in as ${host.login ?? '?'}`
          if (host.state === 'missing-workflow-scope') {
            return `! ${host.host} · can’t push changes to GitHub Actions workflows · ${host.fix?.command ?? ''}`
          }
          if (host.state === 'signed-out') {
            return `✗ ${host.host} · signed out · ${host.fix?.command ?? ''}`
          }
          return `✗ ${host.host} · ${host.error ?? 'couldn’t check'}`
        })
      : []
  return [gitLine, ghLine, ...hostLines]
}

function formatBanners(banners: Banner[], factories: Factory[]): string[] {
  if (banners.length === 0) return ['No problems.']
  const where = (b: Banner) =>
    b.factoryId === undefined
      ? 'TED'
      : (factories.find((f) => f.id === b.factoryId)?.name ?? 'a Factory')
  const rows = banners.map((b) => [
    b.severity === 'stops-work' ? 'Stops work' : 'Warning',
    where(b),
    [
      printable(b.text),
      ...(b.action ? [`[${printable(b.action.label)}]`] : []),
      ...(isShowing(b) ? [] : [`(dismissed until ${b.dismissedUntil})`]),
    ].join('  '),
  ])
  const width = (column: number) => Math.max(...rows.map((row) => row[column]?.length ?? 0))
  return [
    `${banners.length} ${banners.length === 1 ? 'problem' : 'problems'}:`,
    ...rows.map(([kind = '', place = '', rest]) =>
      ['  ', kind.padEnd(width(0)), '  ', place.padEnd(width(1)), '  ', rest].join(''),
    ),
  ]
}

async function workflowCheck(target: string): Promise<void> {
  const problems = await checkWorkflowPath(path.resolve(target), {
    libraryDir: tedPaths(home).library,
  })
  for (const p of problems) {
    const file = path.relative(process.cwd(), p.path)
    console.log(`${file}:${p.line}:${p.column}: ${p.severity}: ${printable(p.message)}`)
  }
  const count = (severity: string) => problems.filter((p) => p.severity === severity).length
  const errors = count('error')
  const warnings = count('warning')
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (problems.length === 0)
    console.log(`No problems in ${path.relative(process.cwd(), path.resolve(target)) || '.'}`)
  else {
    console.log(
      [errors > 0 && plural(errors, 'error'), warnings > 0 && plural(warnings, 'warning')]
        .filter(Boolean)
        .join(', '),
    )
  }
  if (errors > 0) process.exitCode = 1
}

function describeLead({ agent, model, effort }: TaskLead): string {
  return [agent, model ?? 'default model', effort ?? 'default effort'].join(' · ')
}

function formatRun({ run, conversation }: RunWithConversation): string {
  return [
    `Run ${run.id}  ${run.agent}  ${run.state}${run.problem === 'model-unavailable' ? '  model unavailable' : ''}`,
    `Session ${run.sessionId ?? 'not known yet'}`,
    ...conversation.map((entry) => summarize(entry.line)),
  ].join('\n')
}

interface ContentBlock {
  type: string
  text?: string
  name?: string
}

function summarize(line: string): string {
  const message = JSON.parse(line) as {
    type?: string
    subtype?: string
    hook_name?: string
    message?: { content?: string | ContentBlock[] }
    id?: unknown
    method?: string
    params?: { item?: { type?: string; text?: string } }
  }
  if (message.method === undefined && message.id !== undefined) {
    return printable(`response ${String(message.id)}`)
  }
  if (message.method !== undefined) {
    const item = message.params?.item
    const detail = item?.text !== undefined ? `: ${item.text}` : item?.type ? ` ${item.type}` : ''
    return printable(`${message.method}${detail}`)
  }
  const content = message.message?.content
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
  const parts = blocks.map((b) =>
    b.type === 'text' ? b.text : b.name ? `${b.type} ${b.name}` : b.type,
  )
  const kind = [message.type, message.subtype, message.hook_name].filter(Boolean).join(' ')
  return printable(parts.length > 0 ? `${kind}: ${parts.join(' | ')}` : kind)
}

interface DesignFileSpec {
  path: string
  caption?: string
}

interface DesignSpec extends Omit<DesignReviewInput, 'screenshots' | 'video' | 'prototype'> {
  screenshots?: DesignFileSpec[]
  video?: DesignFileSpec
  prototype?: DesignFileSpec
}

function fileSpec(value: unknown, what: string): DesignFileSpec {
  if (typeof value === 'string') return { path: value }
  const { path: file, caption } = (value ?? {}) as Record<string, unknown>
  if (typeof file !== 'string' || (caption !== undefined && typeof caption !== 'string')) {
    throw new UsageError(`the design file’s ${what} needs a path, as text or as { "path": … }`)
  }
  return { path: file, ...(caption !== undefined && { caption }) }
}

async function readDesign(file: string): Promise<DesignSpec> {
  const text = await readFile(path.resolve(file), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new UsageError(
      `the design file isn’t valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('the design file must hold a JSON object')
  }
  const { screenshots, video, prototype, ...rest } = parsed as Record<string, unknown>
  if (screenshots !== undefined && !Array.isArray(screenshots)) {
    throw new UsageError('the design file’s screenshots must be a list')
  }
  return {
    ...(rest as Omit<DesignReviewInput, 'screenshots' | 'video' | 'prototype'>),
    ...(screenshots && { screenshots: screenshots.map((s) => fileSpec(s, 'screenshot')) }),
    ...(video !== undefined && { video: fileSpec(video, 'video') }),
    ...(prototype !== undefined && { prototype: fileSpec(prototype, 'prototype') }),
  }
}

async function uploadDesign(
  client: DaemonClient,
  ref: string,
  { screenshots, video, prototype, ...rest }: DesignSpec,
): Promise<DesignReviewInput> {
  const upload = async ({ path: file, caption }: DesignFileSpec): Promise<DesignFileInput> => {
    const bytes = new Uint8Array(await readFile(path.resolve(file)))
    const saved = await client.uploadTaskAttachment(
      ref,
      { name: path.basename(file), mediaType: mediaTypeOf(file) },
      bytes,
    )
    return { ...saved, ...(caption !== undefined && { caption }) }
  }
  const shots = []
  for (const shot of screenshots ?? []) shots.push(await upload(shot))
  return {
    ...rest,
    ...(shots.length > 0 && { screenshots: shots }),
    ...(video && { video: await upload(video) }),
    ...(prototype && { prototype: await upload(prototype) }),
  }
}

function readRound(file: string): Promise<RoundInput> {
  return readJsonFile<RoundInput>(file, 'round')
}

async function readJsonFile<T>(file: string, what: string): Promise<T> {
  const text = await readFile(path.resolve(file), 'utf8')
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new UsageError(
      `the ${what} file isn’t valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

async function runApp(given: string | undefined): Promise<void> {
  const ref = taskRef()
  const { app, log } = await withDaemon(home, async (client) => {
    let wanted: { name: string; repo?: string } | undefined =
      given === undefined ? undefined : { name: given, ...(options.repo && { repo: options.repo }) }
    if (wanted === undefined) {
      const apps = (await client.listApps(ref)).filter(
        (a) => options.repo === undefined || a.repo === options.repo,
      )
      const [only] = apps
      if (apps.length !== 1 || only === undefined) {
        throw new UsageError(
          apps.length === 0
            ? 'this Task has no Apps'
            : `name the App: ${apps.map((a) => printable(a.name)).join(', ')}`,
        )
      }
      wanted = { name: only.name, repo: only.repo }
    }
    let app = await client.startApp(ref, {
      ...wanted,
      ...(options.reason !== undefined && { reason: options.reason }),
    })
    if (app.state === 'waiting') {
      console.error(
        `Every simulator is booted, so TED asked the human which one to shut down. Waiting for an answer…`,
      )
    }
    while (app.state === 'starting' || app.state === 'waiting') {
      await sleep(500)
      const current = app
      const found = (await client.listApps(ref)).find(
        (a) => a.repo === current.repo && a.name === current.name,
      )
      if (found === undefined || found.removed === true) {
        throw new Error(
          `${printable(current.name)} was removed from the Factory’s settings while TED waited for it`,
        )
      }
      app = found
    }
    const log =
      app.state === 'running'
        ? undefined
        : await client.appLog(ref, { repo: app.repo, name: app.name })
    return { app, log }
  })
  const name = printable(app.name)
  if (app.state === 'running' && app.simulator !== undefined) {
    console.log(
      `${name} is running on ${printable(app.simulator.device)}. It keeps running until the human stops it or the Task ends.`,
    )
    return
  }
  if (app.state === 'running') {
    console.log(
      app.url !== undefined
        ? `${name} is running at ${printable(app.url)} (port ${app.port}). It keeps running until the human stops it or the Task ends.`
        : `${name} is running on port ${app.port}. It keeps running until the human stops it or the Task ends.`,
    )
    return
  }
  if (app.state === 'failed' && app.problem?.startsWith('No simulator slot') === true) {
    console.error(printable(app.problem))
    process.exitCode = 1
    return
  }
  const why =
    app.state === 'failed'
      ? `couldn’t start: ${app.problem ?? 'it failed'}`
      : app.exitCode !== undefined
        ? `exited with code ${app.exitCode}`
        : 'stopped'
  const tail = (log?.text ?? '').split('\n').slice(-40).join('\n')
  console.error(
    `${name} ${printable(why)}.${tail.trim() === '' ? '' : ` The end of its log:\n${printable(tail)}`}`,
  )
  process.exitCode = 1
}

function printable(text: string): string {
  return [...stripVTControlCharacters(text)].filter((c) => !isControl(c)).join('')
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code < 0x20 && char !== '\t' && char !== '\n') || (code >= 0x7f && code <= 0x9f)
}

function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')
  return `${n}${suffix}`
}
