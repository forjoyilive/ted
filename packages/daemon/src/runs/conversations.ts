import {
  type Billing,
  billingNames,
  type ChatItem,
  type Comment,
  type Run,
  type RunChat,
  type RunMessage,
  type RunSummary,
  type Task,
} from '@ted/protocol'
import type { AgentChatEntry, Agents } from '../agents/index.ts'
import type { Coordinators } from '../coordinators/coordinators.ts'
import {
  continueAfterPause,
  continueAfterRetry,
  coordinatorFromTed,
  coordinatorOpening,
  coordinatorTurn,
} from '../coordinators/coordinators.ts'
import type { DiskWatch } from '../disk.ts'
import { RequestError } from '../errors.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import { planOpening } from '../plans/prompts.ts'
import type { PromptPart } from '../store/coordinators.ts'
import type { TedStore } from '../store/index.ts'
import type { Caller } from '../tasks/tasks.ts'
import { preambleText, subAgentPreamble } from '../workflow/workflow.ts'
import { parsedOutput } from './parsed-output.ts'
import type { RunManager } from './run-manager.ts'
import type { OutputKept } from './run-output.ts'
import type { Steering } from './steering.ts'

export interface Conversations {
  chat(runId: string): Promise<RunChat>
  coordinatorChat(factoryId: string): Promise<RunChat | null>
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

const tedTexts = new Set([continueAfterPause, continueAfterRetry])

function tedWritten(message: RunMessage): boolean {
  return message.from === 'ted' || tedTexts.has(message.text.trim())
}

const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length)

function credentialFrom(account: string | undefined): Billing | undefined {
  if (account === undefined) return undefined
  if (/api key/i.test(account)) return 'api-key'
  if (/subscription/i.test(account)) return 'subscription'
  return undefined
}

interface Usage {
  tokens: number | undefined
  credential: Billing | undefined
  cost(model: string | undefined): number | undefined
}

interface FinishedUsage extends Usage {
  stamp: string
}

const finishedUsageKept = 2000

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

function mergeByTime(
  items: ChatItem[],
  extra: readonly (ChatItem & { at: string })[],
  timeOf: (item: ChatItem) => string | undefined = (item) => ('at' in item ? item.at : undefined),
): ChatItem[] {
  const merged = [...items]
  for (const item of extra) {
    const at = Date.parse(item.at)
    const after = merged.findLastIndex((other) => {
      if (other.kind === 'human' && other.queued === true) return false
      const time = timeOf(other)
      const when = time !== undefined ? Date.parse(time) : undefined
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

function withOutputNote(kept: OutputKept, items: ChatItem[]): ChatItem[] {
  if (kept === 'all') return items
  const after = items.findIndex((item) => item.kind !== 'instructions' && item.kind !== 'prompt')
  const at = after === -1 ? items.length : after
  const note: ChatItem =
    kept === 'none'
      ? {
          kind: 'ted',
          id: 'output-not-kept',
          title: 'Output no longer kept',
          text: 'TED no longer keeps this Run’s output, so its messages and tool calls can’t be shown.',
        }
      : {
          kind: 'ted',
          id: 'output-not-kept',
          title: 'Earlier output no longer kept',
          text: 'TED kept only the newest part of this Run’s output. Earlier messages and tool calls can’t be shown.',
        }
  return [...items.slice(0, at), note, ...items.slice(at)]
}

function takeDelivered(
  unmatched: RunMessage[],
  text: string,
  bundle: ((messages: readonly RunMessage[]) => string) | undefined,
): RunMessage[] {
  const wanted = text.trim()
  const one = unmatched.findIndex((m) => m.text.trim() === wanted)
  if (one !== -1) return unmatched.splice(one, 1)
  if (!bundle) return []
  for (let from = 0; from < unmatched.length; from++) {
    for (let to = from + 2; to <= unmatched.length; to++) {
      if (bundle(unmatched.slice(from, to)).trim() === wanted)
        return unmatched.splice(from, to - from)
    }
  }
  return []
}

export function chatItems(input: {
  run: Run
  entries: readonly AgentChatEntry[]
  messages: readonly RunMessage[]
  interrupts?: readonly { id: string; at: string }[]
  preamble: string
  promptFromHuman?: boolean
  tedHeading?: string
  promptParts?: readonly PromptPart[] | undefined
  bundle?: (messages: readonly RunMessage[]) => string
}): ChatItem[] {
  const { run, entries, messages, interrupts = [], preamble, promptFromHuman = false } = input
  const items: ChatItem[] = []
  const { instructions, rest: wholeRest } = splitPrompt(run.prompt, preamble)
  const tedAt = input.tedHeading === undefined ? -1 : wholeRest.indexOf(input.tedHeading)
  const rest = tedAt === -1 ? wholeRest : wholeRest.slice(0, tedAt).trim()
  const fromTed =
    tedAt === -1 ? '' : wholeRest.slice(tedAt + (input.tedHeading ?? '').length).trim()
  if (instructions !== undefined) {
    items.push({
      kind: 'instructions',
      id: 'instructions',
      text: instructions,
      lines: lineCount(instructions),
      at: run.startedAt,
    })
  }
  const fromTedItem = (id: string, text: string, at: string): ChatItem => ({
    kind: 'ted',
    id,
    title: titleOf(text),
    text,
    at,
  })
  const parts = input.promptParts ?? []
  for (const part of parts) {
    const text = run.prompt.slice(part.start, part.end)
    items.push(
      part.from === 'ted'
        ? fromTedItem(part.id, text, run.startedAt)
        : { kind: 'human', id: part.id, text, at: part.at, sent: true },
    )
  }
  if (parts.length === 0 && rest !== '') {
    items.push(
      promptFromHuman
        ? { kind: 'human', id: 'prompt', text: rest, at: run.startedAt, sent: true }
        : { kind: 'prompt', id: 'prompt', text: rest, lines: lineCount(rest), at: run.startedAt },
    )
  }
  if (parts.length === 0 && fromTed !== '') {
    items.push(fromTedItem('prompt-from-ted', fromTed, run.startedAt))
  }
  const deliveredAt = new Map<ChatItem, string>()
  const unmatched = messages.filter((m) => m.queued !== true)
  const waiting = messages.filter((m) => m.queued === true && m.from !== 'ted')
  let promptSeen = run.prompt === ''
  for (const entry of entries) {
    if (entry.kind === 'user') {
      if (!promptSeen && entry.text.trim() === run.prompt.trim()) {
        promptSeen = true
        continue
      }
      const delivered = takeDelivered(unmatched, entry.text, input.bundle)
      for (const message of delivered) {
        if (message.from === 'ted') {
          items.push(fromTedItem(message.id, message.text, entry.at ?? message.at))
          continue
        }
        const item: ChatItem = {
          kind: 'human',
          id: message.id,
          text: message.text,
          at: message.at,
          sent: true,
        }
        items.push(item)
        if (entry.at !== undefined) deliveredAt.set(item, entry.at)
      }
      if (delivered.length === 0) {
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
    if (message.from === 'ted') continue
    items.push({ kind: 'human', id: message.id, text: message.text, at: message.at, sent: false })
  }
  const lastAgent = items.at(-1)
  if (run.state === 'working' && lastAgent?.kind === 'agent') lastAgent.writing = true
  const merged = mergeByTime(
    items,
    interrupts.map((i) => ({ kind: 'interrupted', id: i.id, at: i.at })),
    (item) => deliveredAt.get(item) ?? ('at' in item ? item.at : undefined),
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

export function createConversations(options: {
  store: TedStore
  runs: RunManager
  agents: Agents
  health: AgentHealthMonitor
  disk: DiskWatch
  coordinators?: Coordinators
  steering: Steering
}): Conversations {
  const { store, runs, agents, health, disk } = options
  let preamble: Promise<string> | undefined
  let subPreamble: Promise<string> | undefined
  const restarting = new Set<string>()

  const finishedUsage = new Map<string, FinishedUsage>()

  const requireRun = (runId: string): Run => {
    const run = store.getRun(runId)
    if (!run) {
      finishedUsage.delete(runId)
      throw new RequestError(404, 'no such Run')
    }
    return run
  }

  const requireTask = (ref: string): Task => {
    const task = store.getTask(ref)
    if (!task) throw new RequestError(404, `no Task ${ref}`)
    return task
  }

  const isCurrentLead = (run: Run) =>
    run.taskId !== undefined && store.getTask(run.taskId)?.leadRunId === run.id

  const steering = options.steering

  // ADR 0126: a Run’s output is deleted a while after its Task is done, so what it used is
  // saved when it ends. After the commit that ended it, not inside it.
  const saveUse = (run: Run) => {
    try {
      const parsed = parsedOutput(runs.output, agents, run)
      const { input, output } = parsed.tokenUse()
      // A Run on the agent’s default model has no model of its own to price by.
      const model = run.usesDefaultModel ? undefined : run.model
      const cost = parsed.cost(model)
      if (input + output === 0 && cost === undefined) return
      store.recordRunUsage({
        runId: run.id,
        agent: run.agent,
        ...(model !== undefined && { model }),
        input,
        output,
        ...(cost !== undefined && { cost }),
      })
    } catch (error) {
      console.error(`couldn’t save what Run ${run.id} used:`, error)
    }
  }
  runs.observe({ finished: (run) => void setImmediate(() => saveUse(run)) })
  // Runs the daemon found finished while it was starting ended before anyone was listening.
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()
  setImmediate(() => {
    for (const run of store.listRuns()) {
      if (run.state === 'finished' && (run.ended?.at ?? '') >= startedAt) saveUse(run)
    }
  })

  const usageOf = (run: Run): Usage => {
    const read = () => parsedOutput(runs.output, agents, run)
    if (run.state !== 'finished') {
      finishedUsage.delete(run.id)
      const parsed = read()
      return { tokens: parsed.tokens(), credential: parsed.credential(), cost: parsed.cost }
    }
    const stamp = runs.output.stamp(run.id)
    const kept = finishedUsage.get(run.id)
    if (kept?.stamp === stamp) return kept
    const parsed = read()
    const costs = new Map<string | undefined, number | undefined>()
    const usage: FinishedUsage = {
      stamp,
      tokens: parsed.tokens(),
      credential: parsed.credential(),
      cost(model) {
        if (!costs.has(model)) costs.set(model, read().cost(model))
        return costs.get(model)
      },
    }
    finishedUsage.delete(run.id)
    finishedUsage.set(run.id, usage)
    for (const id of finishedUsage.keys()) {
      if (finishedUsage.size <= finishedUsageKept) break
      finishedUsage.delete(id)
    }
    return usage
  }

  const summary = (run: Run, leadRunId?: string): RunSummary => {
    const usage = usageOf(run)
    const tokens = usage.tokens
    const billing =
      usage.credential ?? credentialFrom(health.list().find((h) => h.agent === run.agent)?.account)
    const credential = billing === undefined ? undefined : billingNames[billing]
    const cost = billing === 'api-key' ? usage.cost(run.model) : undefined
    const subAgent = run.parentRunId !== undefined
    const paused = run.state === 'finished' ? undefined : store.agentPauses()[run.agent]
    return {
      id: run.id,
      ...(run.taskId !== undefined && { taskId: run.taskId }),
      ...(subAgent && { parentRunId: run.parentRunId }),
      name: run.name ?? (run.taskId !== undefined ? 'Task Lead' : 'Run'),
      role: store.sideChats.forRun(run.id)
        ? 'side-chat'
        : subAgent
          ? 'sub-agent'
          : run.taskId !== undefined
            ? 'lead'
            : 'run',
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
        run.taskId === undefined ||
        (leadRunId === undefined ? isCurrentLead(run) : leadRunId === run.id) ||
        (subAgent && run.state !== 'finished'),
    }
  }

  return {
    async chat(runId) {
      const run = requireRun(runId)
      const entries = parsedOutput(runs.output, agents, run).chat.entries()
      preamble ??= preambleText().catch(() => '')
      subPreamble ??= subAgentPreamble().catch(() => '')
      const coordinated = store.coordinators.forRun(runId) !== undefined
      const planned = store.plans.get(runId) !== undefined
      const openingText = coordinated ? coordinatorOpening : planOpening
      const opening = coordinated
        ? run.prompt.lastIndexOf(openingText)
        : run.prompt.indexOf(openingText)
      const firstPart = coordinated
        ? store.coordinators.forRun(runId)?.prompts?.[runId]?.[0]
        : undefined
      const planPreamble = firstPart
        ? run.prompt.slice(0, firstPart.start).trim()
        : (planned || coordinated) && opening !== -1
          ? run.prompt.slice(0, opening + openingText.length)
          : undefined
      const kept = runs.output.kept(runId)
      return {
        run: summary(run),
        items: withPermissions(
          withOutputNote(
            kept,
            chatItems({
              run,
              entries,
              messages: store.runMessages(runId),
              interrupts: store.runInterrupts(runId),
              preamble:
                planPreamble ??
                (run.parentRunId !== undefined ? await subPreamble : await preamble),
              promptFromHuman: planPreamble !== undefined,
              ...(coordinated && {
                tedHeading: coordinatorFromTed,
                promptParts: store.coordinators.forRun(runId)?.prompts?.[runId],
                bundle: coordinatorTurn,
              }),
            }),
          ),
          store.permissionComments(run.id),
        ),
      }
    },
    async coordinatorChat(factoryId) {
      const c = store.coordinators.get(factoryId)
      if (!c) return null
      const started = c.runIds.filter((id) => store.getRun(id) !== undefined)
      const last = started.at(-1)
      let items: ChatItem[] = []
      let run: RunSummary | undefined
      for (const id of c.runIds) {
        if (!started.includes(id)) {
          for (const message of store.runMessages(id)) {
            if (message.queued !== true || tedWritten(message)) continue
            const { text, at } = message
            items.push({ kind: 'human', id: message.id, text, at, sent: false, queued: true })
          }
          continue
        }
        const chat = await this.chat(id)
        if (id === last) run = chat.run
        if (id !== started[0]) {
          items.push({
            kind: 'ted',
            id: `${id}:new-run`,
            title: 'New Run',
            text: 'The earlier Run ended, so TED started a new one and gave it this conversation as context.',
            at: chat.run.startedAt,
          })
        }
        for (const item of chat.items) {
          if (id !== started[0] && item.kind === 'instructions') continue
          if (id !== last && item.kind === 'human' && !item.sent) continue
          items.push(id === last ? item : { ...item, id: `${id}:${item.id}` })
        }
      }
      items = mergeByTime(
        items,
        (c.unsentMessages ?? [])
          .filter((message) => !tedWritten(message))
          .map(({ id, text, at }) => ({
            kind: 'human',
            id,
            text,
            at,
            sent: false,
            unsent: true,
          })),
      )
      return {
        run: run ?? {
          id: c.runId,
          name: 'Coordinator',
          role: 'run',
          agent: c.lead.agent,
          ...(c.lead.model !== undefined && { model: c.lead.model }),
          ...(c.lead.effort !== undefined && { effort: c.lead.effort }),
          state: 'idle',
          startedAt: items.find((item) => 'at' in item && item.at !== undefined)?.at ?? '',
          current: true,
        },
        items,
      }
    },
    taskRuns(ref) {
      const task = requireTask(ref)
      return store.taskRunList(task.id).map((run) => summary(run, task.leadRunId ?? ''))
    },
    async send(runId, text, { interrupt = false } = {}) {
      if (store.sideChats.forRun(runId))
        throw new RequestError(409, 'Use the side-chat controls to queue or stop its reply')
      if (store.coordinators.forRun(runId) && options.coordinators)
        return options.coordinators.send(runId, text)
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
      if (store.sideChats.forRun(runId))
        throw new RequestError(409, 'Use the side-chat controls to queue or stop its reply')
      const c = store.coordinators.forRun(runId)
      if (c && options.coordinators) {
        await options.coordinators.stop(c.factoryId)
        return summary(requireRun(runId))
      }
      requireRun(runId)
      await steering.stopTurn(runId)
      return summary(requireRun(runId))
    },
    sendNow: (runId, messageId) => {
      if (store.sideChats.forRun(runId))
        throw new RequestError(409, 'Use the side-chat controls to queue or stop its reply')
      if (store.coordinators.forRun(runId))
        throw new RequestError(409, 'Coordinator messages wait for their queued turn')
      requireRun(runId)
      return steering.sendNow(runId, messageId)
    },
    deleteMessage(runId, messageId) {
      if (store.sideChats.forRun(runId))
        throw new RequestError(409, 'Use the side-chat controls to queue or stop its reply')
      const coordinator = store.coordinators.forRun(runId)
      if (coordinator && coordinator.runId !== runId)
        throw new RequestError(
          409,
          'This Coordinator Run was replaced; use Stop response in the current chat',
        )
      const removed = steering.remove(runId, messageId)
      options.coordinators?.messageRemoved(runId)
      return removed
    },
    async boundary(runId, caller) {
      if (caller.kind !== 'run' || caller.runId !== runId) {
        throw new RequestError(403, 'A Run can only report its own tool calls')
      }
      return steering.boundary(runId)
    },
    async restart(runId) {
      if (store.sideChats.forRun(runId))
        throw new RequestError(409, 'Use the side-chat controls to queue or stop its reply')
      if (store.coordinators.forRun(runId))
        throw new RequestError(409, 'Use Retry in Coordinator to continue through the Run queue')
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
      if (store.sideChats.forRun(runId))
        throw new RequestError(409, 'Use the side-chat controls to queue or stop its reply')
      const c = store.coordinators.forRun(runId)
      if (c && options.coordinators) {
        await options.coordinators.stop(c.factoryId)
        return summary(requireRun(runId))
      }
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
