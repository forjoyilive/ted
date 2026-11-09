import {
  type Billing,
  billingNames,
  type ChatItem,
  type Comment,
  type ConversationEntry,
  type Run,
  type RunChat,
  type RunMessage,
  type RunSummary,
  type Task,
} from '@ted/protocol'
import type { AgentChatEntry, Agents } from '../agents/index.ts'
import type { DiskWatch } from '../disk.ts'
import { RequestError } from '../errors.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { TedStore } from '../store/index.ts'
import type { Caller } from '../tasks/tasks.ts'
import { preambleText, subAgentPreamble } from '../workflow/workflow.ts'
import type { RunManager } from './run-manager.ts'
import { createSteering } from './steering.ts'

export interface Conversations {
  chat(runId: string): Promise<RunChat>
  taskRuns(ref: string): RunSummary[]
  send(runId: string, text: string, options?: { interrupt?: boolean }): Promise<RunMessage>
  stopTurn(runId: string): Promise<RunSummary>
  sendNow(runId: string, messageId: string): Promise<RunMessage>
  deleteMessage(runId: string, messageId: string): RunMessage
  boundary(runId: string, caller: Caller): Promise<{ delivered: number }>
  restart(runId: string): Promise<RunSummary>
  stop(runId: string): Promise<RunSummary>
  openTab(ref: string, runId: string): Task
  closeTab(ref: string, runId: string): Task
}

const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length)

function credentialFrom(account: string | undefined): Billing | undefined {
  if (account === undefined) return undefined
  if (/api key/i.test(account)) return 'api-key'
  if (/subscription/i.test(account)) return 'subscription'
  return undefined
}

function reportedCredential(
  agents: Agents,
  run: Run,
  entries: readonly ConversationEntry[],
): Billing | undefined {
  const agent = agents.get(run.agent)
  for (const { line } of entries) {
    const report = agent.credentialFrom(line)
    if (report) return report.billing
  }
  return undefined
}

function splitPrompt(prompt: string, preamble: string): { instructions?: string; rest: string } {
  const at = preamble === '' ? -1 : prompt.indexOf(preamble)
  if (at === -1) return { rest: prompt }
  const rest = `${prompt.slice(0, at)}${prompt.slice(at + preamble.length)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { instructions: preamble, rest }
}

function titleOf(text: string): string {
  const first = text.trim().split('\n')[0] ?? ''
  return first.replace(/^#+\s*/, '').slice(0, 120)
}

function mergeByTime(items: ChatItem[], extra: readonly (ChatItem & { at: string })[]): ChatItem[] {
  const merged = [...items]
  for (const item of extra) {
    const at = Date.parse(item.at)
    const after = merged.findLastIndex((other) => {
      if (other.kind === 'human' && other.queued === true) return false
      const when = 'at' in other && other.at !== undefined ? Date.parse(other.at) : undefined
      return when === undefined || when <= at
    })
    merged.splice(after + 1, 0, item)
  }
  return merged
}

export function withPermissions(items: ChatItem[], requests: readonly Comment[]): ChatItem[] {
  return mergeByTime(
    items,
    requests.map((request) => ({
      kind: 'permission',
      id: request.id,
      request,
      at: request.createdAt,
    })),
  )
}

export function chatItems(input: {
  run: Run
  entries: AgentChatEntry[]
  messages: readonly RunMessage[]
  interrupts?: readonly { id: string; at: string }[]
  preamble: string
}): ChatItem[] {
  const { run, entries, messages, interrupts = [], preamble } = input
  const items: ChatItem[] = []
  const { instructions, rest } = splitPrompt(run.prompt, preamble)
  if (instructions !== undefined) {
    items.push({
      kind: 'instructions',
      id: 'instructions',
      text: instructions,
      lines: lineCount(instructions),
      at: run.startedAt,
    })
  }
  if (rest !== '') {
    items.push({
      kind: 'prompt',
      id: 'prompt',
      text: rest,
      lines: lineCount(rest),
      at: run.startedAt,
    })
  }
  const unmatched = messages.filter((m) => m.queued !== true)
  const waiting = messages.filter((m) => m.queued === true)
  let promptSeen = run.prompt === ''
  for (const entry of entries) {
    if (entry.kind === 'user') {
      if (!promptSeen && entry.text.trim() === run.prompt.trim()) {
        promptSeen = true
        continue
      }
      const index = unmatched.findIndex((m) => m.text.trim() === entry.text.trim())
      const message = index === -1 ? undefined : unmatched.splice(index, 1)[0]
      if (message) {
        items.push({
          kind: 'human',
          id: message.id,
          text: message.text,
          at: message.at,
          sent: true,
        })
      } else {
        items.push({
          kind: 'ted',
          id: entry.key,
          title: titleOf(entry.text),
          text: entry.text,
          ...(entry.at !== undefined && { at: entry.at }),
        })
      }
    } else if (entry.kind === 'agent') {
      items.push({
        kind: 'agent',
        id: entry.key,
        text: entry.text,
        ...(entry.at !== undefined && { at: entry.at }),
        ...(!entry.done && { writing: true }),
      })
    } else {
      const { key, kind: _, ...tool } = entry
      const stopped =
        tool.status !== 'done' &&
        tool.at !== undefined &&
        interrupts.some(
          (i) => i.at >= (tool.at ?? '') && (tool.endedAt === undefined || tool.endedAt >= i.at),
        )
      items.push({
        kind: 'tool',
        id: key,
        ...tool,
        status: stopped
          ? 'stopped'
          : tool.status === 'running' && run.state !== 'working'
            ? 'done'
            : tool.status,
      })
    }
  }
  for (const message of unmatched) {
    items.push({ kind: 'human', id: message.id, text: message.text, at: message.at, sent: false })
  }
  const lastAgent = items.at(-1)
  if (run.state === 'working' && lastAgent?.kind === 'agent') lastAgent.writing = true
  const merged = mergeByTime(
    items,
    interrupts.map((i) => ({ kind: 'interrupted', id: i.id, at: i.at })),
  )
  for (const message of waiting) {
    merged.push({
      kind: 'human',
      id: message.id,
      text: message.text,
      at: message.at,
      sent: false,
      queued: true,
    })
  }
  return merged
}

function tokensOf(agents: Agents, run: Run, entries: readonly ConversationEntry[]) {
  const agent = agents.get(run.agent)
  let added = 0
  let latestTotal: number | undefined
  for (const { line } of entries) {
    const count = agent.tokensFrom(line)
    if (!count) continue
    if (count.total) latestTotal = count.input + count.output
    else added += count.input + count.output
  }
  const tokens = latestTotal ?? added
  return tokens > 0 ? tokens : undefined
}

export function createConversations(options: {
  home: string
  store: TedStore
  runs: RunManager
  agents: Agents
  health: AgentHealthMonitor
  disk: DiskWatch
}): Conversations {
  const { home, store, runs, agents, health, disk } = options
  let preamble: Promise<string> | undefined
  let subPreamble: Promise<string> | undefined
  const restarting = new Set<string>()

  const requireRun = (runId: string): Run => {
    const run = store.getRun(runId)
    if (!run) throw new RequestError(404, 'no such Run')
    return run
  }

  const requireTask = (ref: string): Task => {
    const task = store.getTask(ref)
    if (!task) throw new RequestError(404, `no Task ${ref}`)
    return task
  }

  const isCurrentLead = (run: Run) =>
    run.taskId !== undefined && store.getTask(run.taskId)?.leadRunId === run.id

  const steering = createSteering({ home, store, runs, isCurrentLead })

  const summary = (run: Run, given?: readonly ConversationEntry[]): RunSummary => {
    const entries = given ?? store.conversation(run.id)
    const tokens = tokensOf(agents, run, entries)
    const billing =
      reportedCredential(agents, run, entries) ??
      credentialFrom(health.list().find((h) => h.agent === run.agent)?.account)
    const credential = billing === undefined ? undefined : billingNames[billing]
    const cost =
      billing === 'api-key'
        ? agents.get(run.agent).costOf(
            entries.map((e) => e.line),
            run.model,
          )
        : undefined
    const subAgent = run.parentRunId !== undefined
    const paused = run.state === 'finished' ? undefined : store.agentPauses()[run.agent]
    return {
      id: run.id,
      ...(run.taskId !== undefined && { taskId: run.taskId }),
      ...(subAgent && { parentRunId: run.parentRunId }),
      name: run.name ?? (run.taskId !== undefined ? 'Task Lead' : 'Run'),
      role: subAgent ? 'sub-agent' : run.taskId !== undefined ? 'lead' : 'run',
      agent: run.agent,
      ...(run.model !== undefined && { model: run.model }),
      ...(run.effort !== undefined && { effort: run.effort }),
      ...(credential !== undefined && { credential }),
      ...(cost !== undefined && { cost }),
      ...(tokens !== undefined && { tokens }),
      state: run.state,
      ...(paused !== undefined && { paused }),
      ...(store.onSubAgents(run.id) && { onSubAgents: true }),
      ...(run.failure !== undefined && { failed: true }),
      startedAt: run.startedAt,
      current:
        run.taskId === undefined || isCurrentLead(run) || (subAgent && run.state !== 'finished'),
    }
  }

  return {
    async chat(runId) {
      const run = requireRun(runId)
      const entries = store.conversation(runId)
      preamble ??= preambleText().catch(() => '')
      subPreamble ??= subAgentPreamble().catch(() => '')
      return {
        run: summary(run, entries),
        items: withPermissions(
          chatItems({
            run,
            entries: agents.get(run.agent).chat(entries, run.cwd),
            messages: store.runMessages(runId),
            interrupts: store.runInterrupts(runId),
            preamble: run.parentRunId !== undefined ? await subPreamble : await preamble,
          }),
          run.taskId === undefined
            ? []
            : store
                .listComments(run.taskId)
                .filter(
                  (c) =>
                    c.kind === 'permission' && c.author.kind === 'run' && c.author.runId === run.id,
                ),
        ),
      }
    },
    taskRuns(ref) {
      const task = requireTask(ref)
      return store.taskRunList(task.id).map((run) => summary(run))
    },
    async send(runId, text, { interrupt = false } = {}) {
      const run = requireRun(runId)
      if (run.state === 'finished') {
        throw new RequestError(409, 'This Run has finished, so it can’t take messages')
      }
      if (restarting.has(runId)) {
        throw new RequestError(409, 'The Run is restarting. Send your message once it’s back.')
      }
      return steering.send(runId, text, { interrupt })
    },
    async stopTurn(runId) {
      requireRun(runId)
      await steering.stopTurn(runId)
      return summary(requireRun(runId))
    },
    sendNow: (runId, messageId) => {
      requireRun(runId)
      return steering.sendNow(runId, messageId)
    },
    deleteMessage: (runId, messageId) => steering.remove(runId, messageId),
    boundary(runId, caller) {
      if (caller.kind !== 'run' || caller.runId !== runId) {
        throw new RequestError(403, 'A Run can only report its own tool calls')
      }
      return steering.boundary(runId)
    },
    async restart(runId) {
      const run = requireRun(runId)
      if (run.state === 'working') {
        throw new RequestError(409, 'The Run is working. Restart it when it’s idle or waiting.')
      }
      if (run.state === 'finished') throw new RequestError(409, 'This Run has finished')
      if (disk.held()) throw new RequestError(507, 'The disk is full, so TED isn’t restarting Runs')
      if (restarting.has(runId)) throw new RequestError(409, 'The Run is already restarting')
      restarting.add(runId)
      try {
        const restarted = await runs.restart(runId, {
          ...(run.model !== undefined && { model: run.model }),
          ...(run.effort !== undefined && { effort: run.effort }),
          ...(run.usesDefaultModel === true && { usesDefaultModel: true }),
        })
        return summary(restarted)
      } catch (error) {
        if (error instanceof RequestError) throw error
        throw new RequestError(409, error instanceof Error ? error.message : String(error))
      } finally {
        restarting.delete(runId)
      }
    },
    async stop(runId) {
      const run = requireRun(runId)
      if (run.taskId !== undefined && isCurrentLead(run)) {
        throw new RequestError(409, 'This is the Task Lead. Stop the Task instead.')
      }
      await runs.stop(runId)
      return summary(requireRun(runId))
    },
    openTab(ref, runId) {
      const task = requireTask(ref)
      if (requireRun(runId).taskId !== task.id) {
        throw new RequestError(400, 'That Run belongs to another Task')
      }
      return store.openTab(task.id, runId)
    },
    closeTab(ref, runId) {
      return store.closeTab(requireTask(ref).id, runId)
    },
  }
}
