import type {
  ChatItem,
  Comment,
  ConversationEntry,
  Run,
  RunChat,
  RunMessage,
  RunSummary,
  Task,
} from '@ted/protocol'
import type { AgentChatEntry, Agents } from '../agents/index.ts'
import type { DiskWatch } from '../disk.ts'
import { RequestError } from '../errors.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { TedStore } from '../store/index.ts'
import { preambleText } from '../workflow/workflow.ts'
import type { RunManager } from './run-manager.ts'

export interface Conversations {
  chat(runId: string): Promise<RunChat>
  taskRuns(ref: string): RunSummary[]
  send(runId: string, text: string): Promise<RunMessage>
  restart(runId: string): Promise<RunSummary>
  stop(runId: string): Promise<RunSummary>
  openTab(ref: string, runId: string): Task
  closeTab(ref: string, runId: string): Task
}

const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length)

function credentialFrom(account: string | undefined): string | undefined {
  if (account === undefined) return undefined
  if (/api key/i.test(account)) return 'API key'
  if (/subscription/i.test(account)) return 'Subscription'
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

export function withPermissions(items: ChatItem[], requests: readonly Comment[]): ChatItem[] {
  const merged = [...items]
  for (const request of requests) {
    const at = Date.parse(request.createdAt)
    const after = merged.findLastIndex((item) => {
      const when = 'at' in item && item.at !== undefined ? Date.parse(item.at) : undefined
      return when === undefined || when <= at
    })
    merged.splice(after + 1, 0, {
      kind: 'permission',
      id: request.id,
      request,
      at: request.createdAt,
    })
  }
  return merged
}

export function chatItems(input: {
  run: Run
  entries: AgentChatEntry[]
  messages: readonly RunMessage[]
  preamble: string
}): ChatItem[] {
  const { run, entries, messages, preamble } = input
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
  const unmatched = [...messages]
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
      items.push({
        kind: 'tool',
        id: key,
        ...tool,
        status: tool.status === 'running' && run.state !== 'working' ? 'done' : tool.status,
      })
    }
  }
  for (const message of unmatched) {
    items.push({ kind: 'human', id: message.id, text: message.text, at: message.at, sent: false })
  }
  const last = items.at(-1)
  if (run.state === 'working' && last?.kind === 'agent') last.writing = true
  return items
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
  store: TedStore
  runs: RunManager
  agents: Agents
  health: AgentHealthMonitor
  disk: DiskWatch
}): Conversations {
  const { store, runs, agents, health, disk } = options
  let preamble: Promise<string> | undefined
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

  const summary = (run: Run, entries?: readonly ConversationEntry[]): RunSummary => {
    const tokens = tokensOf(agents, run, entries ?? store.conversation(run.id))
    const credential = credentialFrom(health.list().find((h) => h.agent === run.agent)?.account)
    return {
      id: run.id,
      ...(run.taskId !== undefined && { taskId: run.taskId }),
      name: run.taskId !== undefined ? 'Task Lead' : 'Run',
      role: run.taskId !== undefined ? 'lead' : 'run',
      agent: run.agent,
      ...(run.model !== undefined && { model: run.model }),
      ...(run.effort !== undefined && { effort: run.effort }),
      ...(credential !== undefined && { credential }),
      ...(tokens !== undefined && { tokens }),
      state: run.state,
      startedAt: run.startedAt,
      current: run.taskId === undefined || isCurrentLead(run),
    }
  }

  return {
    async chat(runId) {
      const run = requireRun(runId)
      const entries = store.conversation(runId)
      preamble ??= preambleText().catch(() => '')
      return {
        run: summary(run, entries),
        items: withPermissions(
          chatItems({
            run,
            entries: agents.get(run.agent).chat(entries, run.cwd),
            messages: store.runMessages(runId),
            preamble: await preamble,
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
    async send(runId, text) {
      const run = requireRun(runId)
      if (run.state === 'finished') {
        throw new RequestError(409, 'This Run has finished, so it can’t take messages')
      }
      if (restarting.has(runId)) {
        throw new RequestError(409, 'The Run is restarting. Send your message once it’s back.')
      }
      await runs.send(runId, text)
      return store.recordRunMessage({ runId, text, lead: isCurrentLead(run) })
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
