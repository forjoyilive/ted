import type { ClarifyDepth, Comment, CopySkip, ThreadEvent, ThreadEventTone } from '@ted/protocol'
import type { LoggedEvent } from '../store/index.ts'
import { stageTitle } from '../workflow/workflow.ts'
import { depthNames } from './rounds.ts'

export interface ThreadContext {
  comments: readonly Comment[]
  displayIdOf(taskId: string): string
  waitingFor: readonly string[]
}

export const nudgeMessage = 'Continue, or post a Comment if you need the human.'

const agentNames: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

const skipReasons: Record<CopySkip['reason'], string> = {
  'no-local-folder': 'no local folder is set',
  'local-folder-missing': 'the local folder wasn’t found',
  missing: 'not in the local folder',
  outside: 'outside the local folder',
  'not-a-file': 'not a file',
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function agentLine(data: Record<string, unknown>): string {
  return [
    agentNames[text(data.agent)] ?? text(data.agent),
    text(data.model),
    data.effort ? `${text(data.effort)} effort` : '',
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

function copyLine(data: Record<string, unknown>): string | undefined {
  const name = text(data.name)
  const copied = Array.isArray(data.copied) ? data.copied.map(text) : []
  const skipped = Array.isArray(data.skipped) ? (data.skipped as CopySkip[]) : []
  if (copied.length === 0 && skipped.length === 0) return undefined
  const parts = [
    ...(copied.length > 0 ? [`Copied ${copied.join(', ')} into ${name}`] : []),
    ...skipped.map((s) => `didn’t copy ${s.path}: ${skipReasons[s.reason] ?? s.reason}`),
  ]
  const line = parts.join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

export function threadEvents(
  taskId: string,
  log: readonly LoggedEvent[],
  context: ThreadContext,
): ThreadEvent[] {
  const approvals = context.comments.flatMap((c) =>
    c.gate && c.answer?.kind === 'approved' ? [Date.parse(c.answer.at)] : [],
  )
  const usedApprovals = new Set<number>()
  const lines: ThreadEvent[] = []
  let sentBackTo: string | undefined
  let held = false
  let depthSet = false
  const add = (
    entry: LoggedEvent,
    tone: ThreadEventTone,
    line: string,
    findings?: string,
    checkRunId?: string,
  ) =>
    lines.push({
      id: entry.id,
      taskId,
      at: entry.at,
      tone,
      text: line,
      ...(findings !== undefined && findings !== '' && { findings }),
      ...(checkRunId !== undefined && { checkRunId }),
    })

  for (const entry of log) {
    const { data } = entry
    const who = data.runId ? 'Task Lead' : 'You'
    switch (entry.name) {
      case 'v1.TaskCreated':
      case 'v2.TaskCreated':
        add(entry, 'done', 'You created this Task')
        break
      case 'v1.TaskQueued':
        add(entry, 'edit', 'Task started')
        break
      case 'v1.TaskMovedToBacklog':
        add(entry, 'edit', 'Task moved back to Backlog')
        break
      case 'v1.TaskArchived':
        add(entry, 'edit', 'You archived this Task')
        break
      case 'v1.TaskBlockerAdded':
      case 'v2.TaskBlockerAdded':
        add(
          entry,
          'edit',
          `${who} made this Task wait for ${context.displayIdOf(text(data.blockerId))}`,
        )
        break
      case 'v1.TaskBlockerRemoved':
        add(
          entry,
          'edit',
          `${who} removed the blocker ${context.displayIdOf(text(data.blockerId))}`,
        )
        break
      case 'v1.TaskWaitingForBlockers': {
        const ids = context.waitingFor
        add(
          entry,
          'quiet',
          ids.length > 0
            ? `Waiting for ${ids.join(', ')} to merge`
            : 'Waiting for its blockers to merge',
        )
        break
      }
      case 'v1.TaskRequeuedAfterBlockers':
        add(entry, 'run', 'Blockers merged · Task queued to carry on')
        break
      case 'v1.TaskStopped': {
        if (data.why === 'blockers-removed') {
          add(entry, 'quiet', 'Blockers removed · resume the Task to carry on')
          break
        }
        const runs = typeof data.runs === 'number' ? data.runs : 0
        add(
          entry,
          'edit',
          runs === 0
            ? 'You stopped the Task'
            : `You stopped the Task · ${runs} ${runs === 1 ? 'Run' : 'Runs'} stopped`,
        )
        break
      }
      case 'v1.TaskResumed':
        add(entry, 'run', 'You resumed the Task')
        break
      case 'v1.TaskLeadNudged':
        add(entry, 'run', `TED nudged the Task Lead: “${nudgeMessage}”`)
        break
      case 'v1.TaskSentBack':
        sentBackTo = text(data.to)
        add(
          entry,
          'failure',
          `${stageTitle(text(data.from))} sent this back to ${stageTitle(text(data.to))}`,
          text(data.findings).trim(),
        )
        break
      case 'v2.TaskSentBack': {
        sentBackTo = text(data.to)
        const round =
          typeof data.round !== 'number'
            ? ''
            : typeof data.limit === 'number'
              ? ` (round ${data.round} of ${data.limit})`
              : ` (round ${data.round})`
        const checkRunId = text(data.checkRunId) || undefined
        const findings = text(data.findings).trim()
        add(
          entry,
          'failure',
          `${stageTitle(text(data.from))} sent this back to ${stageTitle(text(data.to))}${round}`,
          checkRunId === undefined ? findings : (findings.split(/\n\s*\n/)[0] ?? findings),
          checkRunId,
        )
        break
      }
      case 'v1.TaskStageEntered':
      case 'v2.TaskStageEntered': {
        const stage = text(data.stage)
        if (sentBackTo === stage) {
          sentBackTo = undefined
          break
        }
        const at = Date.parse(entry.at)
        const approval = approvals.find((t) => !usedApprovals.has(t) && t <= at)
        if (approval !== undefined) usedApprovals.add(approval)
        const moved = `Task moved to ${stageTitle(stage)}`
        add(
          entry,
          stage === 'done' ? 'done' : 'edit',
          approval !== undefined ? `You approved · ${moved}` : moved,
        )
        break
      }
      case 'v2.RunStarted':
      case 'v3.RunStarted':
        add(entry, 'run', `Task Lead started · ${agentLine(data)}`)
        break
      case 'v1.TaskLeadSet':
        add(entry, 'edit', `Task Lead set to ${agentLine(data)}`)
        break
      case 'v1.ClarifyDepthSet': {
        const name = depthNames[text(data.depth) as ClarifyDepth] ?? text(data.depth)
        const why = text(data.why) === '' ? '' : ` · ${text(data.why)}`
        if (data.by === 'human') add(entry, 'edit', `You set Clarify depth to ${name}`)
        else if (depthSet) add(entry, 'run', `Task Lead switched Clarify depth to ${name}${why}`)
        else add(entry, 'run', `Task Lead picked Clarify depth: ${name}${why}`)
        depthSet = true
        break
      }
      case 'v1.TaskWorktreeCreated': {
        const line = copyLine(data)
        if (line) add(entry, 'quiet', line)
        break
      }
      case 'v1.TaskWorktreeSetupStarted':
        add(entry, 'run', `Setting up ${text(data.name)} · ${text(data.command)}`)
        break
      case 'v1.TaskWorktreeSetupFinished': {
        const name = text(data.name)
        if (data.outcome === 'passed') add(entry, 'done', `Setup finished in ${name}`)
        else if (data.outcome === 'timed-out') add(entry, 'failure', `Setup timed out in ${name}`)
        else {
          const code = typeof data.exitCode === 'number' ? ` with exit code ${data.exitCode}` : ''
          add(entry, 'failure', `Setup failed in ${name}${code}`)
        }
        break
      }
      case 'v1.TaskWorktreeRemoved': {
        const outcome = text(data.teardownOutcome)
        const teardown =
          outcome === ''
            ? ''
            : outcome === 'passed'
              ? ' · teardown finished'
              : outcome === 'timed-out'
                ? ' · teardown timed out'
                : ' · teardown failed'
        add(entry, 'edit', `Worktree for ${text(data.name)} removed${teardown}`)
        break
      }
      case 'v1.TaskRunHeld':
        held = true
        add(
          entry,
          'quiet',
          `Paused · ${agentNames[text(data.agent)] ?? text(data.agent)} can’t run right now`,
        )
        break
      case 'v1.RunAutoModeUnavailable':
        add(
          entry,
          'quiet',
          'Claude Code’s auto mode isn’t available, so every permission prompt comes to you',
        )
        break
      case 'v1.RunMessageSent':
        lines.push({
          id: entry.id,
          taskId,
          at: entry.at,
          tone: 'edit',
          text: 'You steered the Task Lead in its Conversation',
          runId: text(data.runId),
        })
        break
      case 'v1.TaskRunReleased':
        if (held) add(entry, 'quiet', 'Continued')
        held = false
        break
    }
  }
  return lines
}
