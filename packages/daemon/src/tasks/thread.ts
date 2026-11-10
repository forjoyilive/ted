import type {
  ClarifyDepth,
  Comment,
  CopySkip,
  DescriptionVersion,
  Judgment,
  LayerUse,
  ThreadEvent,
  ThreadEventTone,
} from '@ted/protocol'
import { diffTexts } from '../agents/diff.ts'
import type { LoggedEvent } from '../store/index.ts'
import { stageTitle } from '../workflow/workflow.ts'
import { summary } from './github-activity.ts'
import { depthNames } from './rounds.ts'

export interface ThreadContext {
  comments: readonly Comment[]
  displayIdOf(taskId: string): string
  waitingFor: readonly string[]
  descriptions?: readonly DescriptionVersion[]
  planTitleOf?: (planId: string) => string | undefined
}

const planEndLines: Record<string, string> = {
  approved: 'TED told the Task Lead; it carries on with Clarify.',
  stopped:
    'Planning chat stopped without approval. TED told the Task Lead to ask its size question again.',
  failed:
    'Planning chat failed without approval. TED told the Task Lead to ask its size question again.',
  deleted:
    'Planning chat deleted without approval. TED told the Task Lead to ask its size question again.',
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

function judgmentsIn(data: Record<string, unknown>): Judgment[] {
  return (['review', 'visual'] as const).flatMap((key) => {
    const value = data[key] as { passed?: unknown; notes?: unknown } | null | undefined
    if (!value || typeof value.passed !== 'boolean') return []
    const name: Judgment['name'] = key === 'review' ? 'Review' : 'Visual'
    return [
      {
        name,
        passed: value.passed,
        ...(typeof value.notes === 'number' && value.notes > 0 && { notes: value.notes }),
      },
    ]
  })
}

function reviewedBy(data: Record<string, unknown>): string {
  const reviewer = data.reviewer as { agent?: unknown; unavailable?: unknown } | null | undefined
  if (!reviewer) return ''
  const agent = agentNames[text(reviewer.agent)] ?? text(reviewer.agent)
  const unavailable = text(reviewer.unavailable)
  return ` · Reviewed by ${agent}${
    unavailable === '' ? '' : ` (${agentNames[unavailable] ?? unavailable} unavailable)`
  }`
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

function methodNote(data: Record<string, unknown>): string {
  const method = text(data.method)
  const requested = text(data.requested)
  if (method === '' || requested === '' || method === requested) return ''
  return ` · ${requested} isn’t allowed on GitHub, so TED used ${method}`
}

function leadFailedLine(data: Record<string, unknown>): string {
  if (data.resumeFailed === true)
    return 'Resume failed · started a fresh Task Lead Run from the brief'
  const what = `Task Lead Run ${text(data.reason)}`
  if (data.recovery === 'resume') return `${what} · resuming the session`
  if (data.recovery === 'failed') return `${what} · Task marked Failed`
  return `${what} · starting a fresh Task Lead Run from the brief`
}

function settingsFallback(layers: unknown): string | undefined {
  let parsed: unknown
  try {
    parsed = typeof layers === 'string' ? JSON.parse(layers) : layers
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  for (const use of parsed as LayerUse[]) {
    if (use.status !== 'last-valid' && use.status !== 'skipped') continue
    const error = use.problems?.find((p) => p.severity === 'error')
    const file = error?.file ?? (use.layer === 'library' ? 'workflow.yaml' : '.ted/workflow.yaml')
    const where = use.layer === 'library' ? 'Library ' : ''
    return use.status === 'last-valid'
      ? `Used last valid TED settings: ${where}${file} has an error`
      : `Used the inherited TED settings: ${where}${file} has an error`
  }
  return undefined
}

function inTalk(comments: readonly Comment[], runId: string, at: string): boolean {
  return comments.some(
    ({ talk, answer }) =>
      talk?.runId === runId && talk.startedAt <= at && (answer === undefined || at <= answer.at),
  )
}

function appWhere(data: Record<string, unknown>): string {
  const url = text(data.url)
  if (url !== '') return ` · ${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  return typeof data.port === 'number' ? ` · port ${data.port}` : ''
}

export function appExitLine(name: string, code: unknown, signal: unknown): string {
  if (typeof code === 'number') return `${name} exited with code ${code}`
  if (typeof signal === 'string' && signal !== '') return `${name} was ended by ${signal}`
  return `${name} stopped running`
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
  let judged: Record<string, unknown> | undefined
  let depthSet = false
  const splits = new Set(log.filter((e) => e.name === 'v1.TaskSplit').map((e) => e.at))
  const descriptionChanges = (version: unknown) => {
    const versions = context.descriptions ?? []
    const at = typeof version === 'number' ? version : undefined
    const before = versions.find((v) => v.version === (at ?? 0) - 1)
    const after = versions.find((v) => v.version === at)
    return before && after ? { changes: diffTexts('Description', before.text, after.text) } : {}
  }
  const edits = new Map(
    log.filter((e) => e.name === 'v1.TaskEdited').map((e) => [e.at, e.data.version] as const),
  )
  const add = (
    entry: LoggedEvent,
    tone: ThreadEventTone,
    line: string,
    findings?: string,
    checkRunId?: string,
    extra?: Pick<ThreadEvent, 'judgments' | 'validate' | 'changes' | 'planId'>,
  ) =>
    lines.push({
      id: entry.id,
      taskId,
      at: entry.at,
      tone,
      text: line,
      ...(findings !== undefined && findings !== '' && { findings }),
      ...(checkRunId !== undefined && { checkRunId }),
      ...(extra?.judgments !== undefined &&
        extra.judgments.length > 0 && { judgments: extra.judgments }),
      ...(extra?.validate !== undefined && { validate: extra.validate }),
      ...(extra?.changes !== undefined && { changes: extra.changes }),
      ...(extra?.planId !== undefined && { planId: extra.planId }),
    })

  const setup = log.some((entry) => entry.name === 'v1.SetupTaskCreated')
  for (const entry of log) {
    const { data } = entry
    const who = data.runId ? 'Task Lead' : 'You'
    switch (entry.name) {
      case 'v1.TaskCreated':
      case 'v2.TaskCreated':
        add(
          entry,
          'done',
          setup ? 'TED created this Task to set up this Factory' : 'You created this Task',
        )
        break
      case 'v1.TaskFollowsUp':
        add(entry, 'edit', `Follow-up to ${context.displayIdOf(text(data.originalId))}`)
        break
      case 'v1.TaskFollowedUp':
        add(entry, 'done', `You followed up in ${context.displayIdOf(text(data.followUpId))}`)
        break
      case 'v1.TaskSplitFrom':
        add(entry, 'edit', `Split from ${context.displayIdOf(text(data.originalId))}`)
        break
      case 'v1.TaskSplit': {
        const pieces = Array.isArray(data.pieceIds)
          ? data.pieceIds.map((id) => context.displayIdOf(text(id)))
          : []
        add(
          entry,
          'done',
          `TED created ${pieces.length} ${pieces.length === 1 ? 'Task' : 'Tasks'} in Backlog: ${pieces.join(', ')}. ${context.displayIdOf(taskId)} narrowed to ${text(data.narrowedTo)}.`,
          undefined,
          undefined,
          descriptionChanges(edits.get(entry.at)),
        )
        break
      }
      case 'v1.PlanStartedFromTask': {
        const planId = text(data.planId)
        const title = context.planTitleOf?.(planId)
        add(
          entry,
          'edit',
          `Planning in chat: ${title ?? 'a deleted planning chat'}`,
          undefined,
          undefined,
          title === undefined ? {} : { planId },
        )
        break
      }
      case 'v1.TaskPlanEnded': {
        const line = planEndLines[text(data.outcome)]
        if (line !== undefined) add(entry, 'edit', line)
        break
      }
      case 'v1.TaskNeedsPlanning':
        add(entry, 'edit', 'Moved to Backlog to be planned outside TED')
        break
      case 'v1.TaskStartedAfterPlanning':
        add(entry, 'edit', `Task started again after planning · ${stageTitle(text(data.stage))}`)
        break
      case 'v1.TaskEdited': {
        if (splits.has(entry.at)) break
        const title = text(data.title)
        const version = typeof data.version === 'number' ? data.version : undefined
        const renamed = title === '' ? '' : `renamed this Task to “${title}”`
        const line =
          version === undefined
            ? `You ${renamed}`
            : `You ${renamed === '' ? '' : `${renamed} and `}edited the description`
        const versions = context.descriptions ?? []
        const before = versions.find((v) => v.version === (version ?? 0) - 1)
        const after = versions.find((v) => v.version === version)
        add(
          entry,
          'edit',
          line,
          undefined,
          undefined,
          before && after ? { changes: diffTexts('Description', before.text, after.text) } : {},
        )
        break
      }
      case 'v1.TaskQueued':
        add(entry, 'edit', 'Task started')
        break
      case 'v1.TaskMovedToBacklog':
        add(entry, 'edit', 'Task moved back to Backlog')
        break
      case 'v1.TaskArchived':
        add(entry, 'edit', 'You archived this Task')
        break
      case 'v2.TaskArchived': {
        const closing = Array.isArray(data.closing) ? data.closing.map(String) : []
        const branches = typeof data.branches === 'number' ? data.branches : 0
        add(
          entry,
          'edit',
          [
            'You archived this Task',
            ...(closing.length > 0 ? [`closed ${joinAnd(closing)} on GitHub`] : []),
            ...(branches === 1 ? ['kept the branch'] : branches > 1 ? ['kept the branches'] : []),
          ].join(' · '),
        )
        break
      }
      case 'v3.TaskArchived': {
        const closing = Array.isArray(data.closing) ? data.closing.map(String) : []
        const branches = typeof data.branches === 'number' ? data.branches : 0
        add(
          entry,
          'edit',
          [
            'TED archived this Task',
            text(data.why),
            ...(closing.length > 0 ? [`closed ${joinAnd(closing)} on GitHub`] : []),
            ...(branches === 1 ? ['kept the branch'] : branches > 1 ? ['kept the branches'] : []),
          ]
            .filter((part) => part !== '')
            .join(' · '),
        )
        break
      }
      case 'v1.LinearIssueMoved':
        if (text(data.state) !== '') {
          add(entry, 'quiet', `Moved ${text(data.identifier)} to ${text(data.state)} in Linear`)
        }
        break
      case 'v1.LinearSyncAllowed':
        if (data.by === 'menu') {
          add(entry, 'edit', `You let TED sync this Task with ${text(data.identifier)} in Linear`)
        }
        break
      case 'v1.LinearTeamSyncAllowed':
        add(
          entry,
          'edit',
          `You let TED sync ${text(data.team)} issues with Linear for Automations in this Factory`,
        )
        break
      case 'v1.LinearPullRequestsLinked': {
        const count = Array.isArray(data.urls) ? data.urls.length : 0
        add(
          entry,
          'quiet',
          `Linked the ${count === 1 ? 'pull request' : 'pull requests'} in ${text(data.identifier)} in Linear`,
        )
        break
      }
      case 'v1.TaskUnarchived':
        add(
          entry,
          'edit',
          data.queued === true
            ? 'You unarchived this Task · a fresh Task Lead Run starts from the brief'
            : 'You unarchived this Task',
        )
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
      case 'v1.TaskRetried':
        add(entry, 'run', 'You retried the Task')
        break
      case 'v1.TaskLeadFailed':
        add(entry, 'failure', leadFailedLine(data))
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
        const fromValidate = text(data.from) === 'validate'
        const judgedNow = fromValidate ? judged : undefined
        judged = undefined
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
          `${stageTitle(text(data.from))} sent this back to ${stageTitle(text(data.to))}${round}${
            judgedNow ? reviewedBy(judgedNow) : ''
          }`,
          checkRunId === undefined ? findings : (findings.split(/\n\s*\n/)[0] ?? findings),
          checkRunId ?? (judgedNow ? text(judgedNow.checkRunId) || undefined : undefined),
          {
            ...(judgedNow && { judgments: judgmentsIn(judgedNow) }),
            ...(fromValidate && { validate: 'sent-back' as const }),
          },
        )
        break
      }
      case 'v1.ValidateJudged':
        if (data.outcome === 'sent-back') {
          judged = data
          break
        }
        judged = undefined
        add(
          entry,
          'done',
          `Validate passed${reviewedBy(data)}`,
          undefined,
          text(data.checkRunId) || undefined,
          { judgments: judgmentsIn(data), validate: 'passed' },
        )
        break
      case 'v1.LoopCheckStarted':
        add(
          entry,
          'run',
          typeof data.round === 'number'
            ? `TED is checking whether Validate’s ${data.round} rounds are converging`
            : 'TED is checking whether Validate’s rounds are converging',
        )
        break
      case 'v1.LoopCheckFinished': {
        const verdict = text(data.verdict)
        const reason = text(data.reason)
        add(
          entry,
          verdict === 'converging' ? 'done' : 'failure',
          verdict === 'failed'
            ? `Loop check gave no verdict · ${reason}`
            : `Loop check: ${verdict} · ${reason}`,
        )
        break
      }
      case 'v1.TaskStageEntered':
      case 'v2.TaskStageEntered': {
        const stage = text(data.stage)
        judged = undefined
        if (sentBackTo === stage) {
          sentBackTo = undefined
          const fallback = settingsFallback(data.layers)
          if (fallback) add(entry, 'quiet', fallback)
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
        const fallback = settingsFallback(data.layers)
        if (fallback) add(entry, 'quiet', fallback)
        break
      }
      case 'v2.RunStarted':
      case 'v3.RunStarted':
        add(entry, 'run', `Task Lead started · ${agentLine(data)}`)
        break
      case 'v4.RunStarted':
        add(
          entry,
          'run',
          data.parentRunId
            ? `Sub-agent “${text(data.name)}” started · ${agentLine(data)}`
            : `Task Lead started · ${agentLine(data)}`,
        )
        break
      case 'v1.TaskReposSet': {
        const names = Array.isArray(data.names) ? data.names.map(String).join(', ') : ''
        if (data.by === 'human') add(entry, 'edit', `You set Repos to ${names}`)
        else add(entry, 'run', `Task Lead set Repos to ${names}`)
        break
      }
      case 'v1.TaskGatesChanged':
        add(entry, 'edit', 'You changed this Task’s Gates')
        break
      case 'v1.GateKeptOvernight':
        add(
          entry,
          'quiet',
          `Overnight mode is on, but ${
            data.reason === 'unreadable'
              ? 'TED couldn’t read this Task’s changes'
              : 'this Task changes .ted/'
          }, so its ${stageTitle(text(data.stage))} Gate stays on`,
        )
        break
      case 'v1.GateSkippedOvernight':
        add(
          entry,
          'quiet',
          `Overnight mode is on, so TED skipped the ${stageTitle(text(data.stage))} Gate`,
        )
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
      case 'v1.AppStarted': {
        const by = text(data.by)
        const starter =
          by === 'task-lead' ? 'Task Lead' : by === 'sub-agent' ? 'A sub-agent' : 'You'
        const verb = data.restart === true ? 'restarted' : 'started'
        add(entry, 'run', `${starter} ${verb} ${text(data.name)}${appWhere(data)}`)
        break
      }
      case 'v1.AppStopped':
        add(entry, 'quiet', `You stopped ${text(data.name)}`)
        break
      case 'v1.AppExited':
        add(entry, 'failure', appExitLine(text(data.name), data.code, data.signal))
        break
      case 'v1.AppStartFailed':
        add(entry, 'failure', `${text(data.name)} couldn’t start: ${text(data.problem)}`)
        break
      case 'v1.SimulatorShutDown': {
        const why =
          data.idle === true
            ? 'because it was idle'
            : text(data.forTask) !== ''
              ? `to free a slot for ${text(data.forTask)}`
              : 'to free a slot'
        add(entry, 'quiet', `TED shut down ${text(data.name)}’s simulator ${why}`)
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
      case 'v1.RunMessageDelivered':
        if (inTalk(context.comments, text(data.runId), entry.at)) break
        lines.push({
          id: entry.id,
          taskId,
          at: entry.at,
          tone: 'edit',
          text: 'You steered the Task Lead in its Conversation',
          runId: text(data.runId),
        })
        break
      case 'v1.PullRequestMerged': {
        const name = text(data.name)
        if (data.byTed !== true) {
          add(entry, 'done', `The pull request for ${name} merged on GitHub`)
          break
        }
        const line =
          data.noCi === true ? `No CI on ${name} · merged without waiting` : `Merged ${name}`
        add(entry, 'done', `${line}${methodNote(data)}`)
        break
      }
      case 'v1.PullRequestAutoMergeEnabled':
        add(entry, 'run', `Turned on auto-merge for ${text(data.name)}${methodNote(data)}`)
        break
      case 'v1.PullRequestClosedOnGitHub':
        add(entry, 'quiet', `The pull request for ${text(data.name)} was closed on GitHub`)
        break
      case 'v1.GitHubActivitySent':
        add(
          entry,
          'run',
          `GitHub: ${gitHubSummary(data.notices)} · sent to the Task Lead${outsideCiNote(data.notices)}`,
        )
        break
      case 'v1.GitHubActivityHeld':
        add(
          entry,
          'quiet',
          `GitHub: ${gitHubSummary(data.notices)} · not sent to the Task Lead (outside contributor)`,
        )
        break
      case 'v1.GitHubActivityQueued':
        add(
          entry,
          'run',
          `GitHub: ${gitHubSummary(data.notices)} · a fresh Task Lead Run starts from the brief${outsideCiNote(data.notices)}`,
        )
        break
      case 'v1.MergeStoppedPartway': {
        const merged = Array.isArray(data.merged) ? data.merged.map(String) : []
        const open = Array.isArray(data.open) ? data.open.map(String) : []
        add(
          entry,
          'failure',
          `Merge stopped partway · ${joinAnd(merged)} merged, ${joinAnd(open)} didn’t. TED doesn’t revert a merged pull request.`,
        )
        break
      }
      case 'v1.TaskBranchRebased':
        add(
          entry,
          'run',
          `Rebased ${text(data.name)} onto ${text(data.onto)} with no conflicts · running Checks again`,
        )
        break
      case 'v1.TaskRunReleased':
        if (held) add(entry, 'quiet', 'Continued')
        held = false
        break
    }
  }
  return lines
}

function outsideCiNote(notices: unknown): string {
  const list = Array.isArray(notices) ? (notices as { kind?: unknown }[]) : []
  return list.some((n) => n.kind === 'outside-ci')
    ? ' · TED passed on only how many checks from outside apps failed; look at them on GitHub'
    : ''
}

function gitHubSummary(notices: unknown): string {
  const list = Array.isArray(notices) ? (notices as { kind?: unknown; where?: unknown }[]) : []
  return summary(
    list.flatMap((n) =>
      (n.kind === 'ci' ||
        n.kind === 'outside-ci' ||
        n.kind === 'review' ||
        n.kind === 'conflict' ||
        n.kind === 'outside') &&
      typeof n.where === 'string'
        ? [{ kind: n.kind, where: n.where }]
        : [],
    ),
  )
}

function joinAnd(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
