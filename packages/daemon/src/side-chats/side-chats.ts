import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { RunChat, SideChat } from '@ted/protocol'
import { chatToolPolicy } from '@ted/protocol/run'
import { AgentDisabledError, agentStartHold } from '../agent-eligibility.ts'
import type { Agents } from '../agents/index.ts'
import { RequestError } from '../errors.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { IdleTimer } from '../idle.ts'
import { redactSecrets } from '../redact.ts'
import { chatItems } from '../runs/conversations.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { TedStore } from '../store/index.ts'
import type { StoredSideChat } from '../store/side-chats.ts'
import type { QueueSource } from '../tasks/queue.ts'
import type { Tasks } from '../tasks/tasks.ts'
import {
  boundSnapshot,
  questionMarker,
  readSnapshot,
  sideFolder,
  sideInstructions,
  writeSnapshot,
} from './context.ts'

export type SideChats = ReturnType<typeof createSideChats>

export function createSideChats(options: {
  home: string
  store: TedStore
  runs: RunManager
  agents: Agents
  health: AgentHealthMonitor
  tasks: Pick<Tasks, 'addQueueSource'>
  idle?: IdleTimer
}) {
  const { home, store, runs, agents, health } = options
  const saved = store.sideChats
  const starts = new Map<string, Promise<void>>()
  const stops = new Map<string, Promise<void>>()
  const opens = new Map<string, Promise<SideChat>>()
  let closed = false
  let release: (() => void) | undefined
  const pending = (c: StoredSideChat) => store.runMessages(c.id).find((m) => m.id === c.messageId)
  const paused = (c: StoredSideChat) =>
    agentStartHold(store, c.lead.agent, c.id) ?? store.agentPauses()[c.lead.agent]
  const changed = () => {
    const busy =
      saved.list().some((c) => c.state === 'queued' || c.state === 'working') ||
      starts.size > 0 ||
      stops.size > 0
    if (busy && !release) release = options.idle?.hold()
    if (!busy) {
      release?.()
      release = undefined
    }
    pump()
  }
  function find(sourceId: string) {
    const source = store.getRun(sourceId)
    const task = source?.taskId === undefined ? undefined : store.getTask(source.taskId)
    if (!source) throw new RequestError(404, 'No such Run')
    if (!task) throw new RequestError(400, 'Side chats are available for Task Lead Runs only')
    if (
      source.parentRunId !== undefined ||
      !store.taskRunList(task.id).some((r) => r.id === source.id && r.parentRunId === undefined)
    )
      throw new RequestError(400, 'Side chats are available for Task Lead Runs only')
    return { source, task }
  }
  function requireChat(id: string) {
    find(id)
    const c = saved.get(id)
    if (!c) throw new RequestError(404, 'Open a side chat first')
    return c
  }
  function conversation(c: StoredSideChat): RunChat {
    const run = store.getRun(c.id)
    const summary = {
      id: c.id,
      name: 'Side chat',
      role: 'side-chat' as const,
      agent: c.lead.agent,
      ...('model' in c.lead && { model: c.lead.model }),
      ...('effort' in c.lead && { effort: c.lead.effort }),
      state: run?.state ?? 'idle',
      current: false,
      startedAt: c.snapshotAt,
    }
    if (!run) return { run: summary, items: [] }
    const entries = agents
      .get(run.agent)
      .chat(runs.output.entries(c.id), run.cwd)
      .map((e) => {
        if (e.kind !== 'user' || !e.text.startsWith(sideInstructions)) return e
        const at = e.text.indexOf(questionMarker)
        return at < 0 ? e : { ...e, text: e.text.slice(at + questionMarker.length) }
      })
    return {
      run: summary,
      items: chatItems({ run, entries, messages: store.runMessages(c.id), preamble: '' }),
    }
  }
  async function view(c: StoredSideChat): Promise<SideChat> {
    const available = await readSnapshot(home, c.id).then(
      () => true,
      () => false,
    )
    return {
      id: c.id,
      sourceRunId: c.sourceRunId,
      snapshotAt: c.snapshotAt,
      truncated: c.truncated,
      state: c.state,
      available,
      ...(paused(c) && { paused: paused(c) }),
      ...(c.error && { error: c.error }),
      chat: conversation(c),
    }
  }
  function save(c: StoredSideChat) {
    saved.save(c)
    changed()
  }
  function stopRun(c: StoredSideChat): Promise<void> {
    const existing = stops.get(c.id)
    if (existing) return existing
    const work = (async () => {
      if (starts.has(c.id)) await starts.get(c.id)
      if (store.getRun(c.id)?.state !== 'finished' && store.getRun(c.id)) await runs.stop(c.id)
    })()
    stops.set(c.id, work)
    void work
      .finally(() => {
        stops.delete(c.id)
        if (!closed) changed()
      })
      .catch(() => undefined)
    return work
  }
  function fail(c: StoredSideChat, error: string) {
    const current = saved.get(c.sourceRunId)
    if (closed || !current || current.state === 'failed') return
    saved.save({ ...current, state: 'failed', error: redactSecrets(error).slice(0, 500) })
    void stopRun(current).catch(() => undefined)
    changed()
  }
  function reconcile(c: StoredSideChat) {
    if (!c.messageId || !pending(c)?.queued || !runs.acceptedInputs(c.id).includes(c.messageId))
      return c
    store.deliverRunMessages(c.id, [c.messageId], false)
    const next = { ...c, contextSent: true }
    saved.save(next)
    return next
  }
  function settle(id: string) {
    let c = saved.forRun(id)
    if (closed || !c || c.state !== 'working' || starts.has(id) || stops.has(id)) return
    const run = store.getRun(id)
    if (!run || paused(c)) return
    c = reconcile(c)
    const entries = runs.output.entries(id).filter((e) => e.offset >= c.outputAfter)
    const agent = agents.get(run.agent)
    if (
      (chatToolPolicy(run.agent) === 'none' &&
        agent.chat(entries, run.cwd).some((e) => e.kind === 'tool')) ||
      run.state === 'waiting'
    ) {
      fail(c, 'The side chat attempted to use a tool. Its reply was stopped.')
      return
    }
    if (run.state === 'finished') {
      fail(c, 'The reply was interrupted. Retry to continue.')
      return
    }
    if (run.problem || run.failure) {
      fail(c, 'The reply could not complete. Retry to continue.')
      return
    }
    if (run.state === 'idle' && entries.some((e) => agent.turnFrom(e.line) === 'completed')) {
      const answer = agent.chat(entries, run.cwd).findLast((e) => e.kind === 'agent')
      if (answer?.kind !== 'agent' || !answer.done || !answer.text.trim()) {
        fail(c, 'The agent returned an empty or incomplete reply. Retry to continue.')
        return
      }
      const completed = c
      void stopRun(c)
        .then(() => {
          const current = saved.get(completed.sourceRunId)
          if (!closed && current?.state === 'working' && current.messageId === completed.messageId)
            save({ ...current, state: 'ready', messageId: undefined, error: undefined })
        })
        .catch((error) => fail(completed, String(error)))
    }
  }
  async function launch(sourceId: string) {
    let c = requireChat(sourceId)
    if (c.state !== 'queued' || paused(c) || store.newWorkHold()) return
    await health.check([c.lead.agent])
    c = requireChat(sourceId)
    if (closed || c.state !== 'queued' || paused(c) || store.newWorkHold()) return
    const context = await readSnapshot(home, c.id)
    if (createHash('sha256').update(context).digest('hex') !== c.digest)
      throw new Error('The side-chat snapshot changed')
    c = reconcile(c)
    const message = pending(c)
    if (!message) throw new Error('The saved question is missing')
    const already = runs.acceptedInputs(c.id).includes(message.id)
    const run = store.getRun(c.id)
    save({ ...c, state: 'working', error: undefined })
    await store.persisted()
    if (closed || saved.get(sourceId)?.state !== 'working') return
    const text = c.contextSent
      ? message.text
      : `${sideInstructions}\n\n${JSON.stringify({ conversation: context })}${questionMarker}${message.text}`
    if (!run) {
      await runs.start({
        id: c.id,
        ...c.lead,
        name: 'Side chat',
        cwd: path.join(await sideFolder(home, c.id), 'cwd'),
        permissions: 'auto',
        prompt: '',
      })
    } else if (run.state === 'finished') {
      if (already)
        throw new Error(
          'The reply was interrupted after its question was accepted. Send a new question to continue.',
        )
      await runs.revive(c.id, { prompt: text, messageIds: [message.id] })
      return
    }
    if (!already) {
      await runs.dispatch(
        c.id,
        [{ id: message.id, text }],
        false,
        () => !closed && saved.get(sourceId)?.state === 'working',
      )
      const latest = saved.get(sourceId)
      if (latest) reconcile(latest)
    }
  }
  const source: QueueSource = {
    starting: () => [...starts.keys()],
    queued: () =>
      saved
        .list()
        .filter((c) => c.state === 'queued' && !starts.has(c.id) && !stops.has(c.id))
        .map((c) => ({
          id: c.sourceRunId,
          kind: 'side-chat' as const,
          factoryId: c.factoryId,
          rank: Date.parse(pending(c)?.at ?? c.snapshotAt),
        })),
    runnable: (id) => {
      const c = saved.get(id)
      return (
        !closed &&
        !!c &&
        !agentStartHold(store, c.lead.agent, c.id) &&
        !paused(c) &&
        !!store.getTask(c.taskId)
      )
    },
    begin(id) {
      const c = saved.get(id)
      if (!c || starts.has(c.id)) return
      const work = launch(id)
        .catch((error) => {
          if (error instanceof AgentDisabledError) save({ ...requireChat(id), state: 'queued' })
          else fail(c, String(error))
        })
        .finally(() => {
          starts.delete(c.id)
          if (!closed) {
            settle(c.id)
            changed()
          }
        })
      starts.set(c.id, work)
    },
    holders: () =>
      saved
        .list()
        .filter(
          (c) =>
            starts.has(c.id) ||
            stops.has(c.id) ||
            ((c.state === 'working' ||
              ['working', 'waiting'].includes(store.getRun(c.id)?.state ?? '')) &&
              !paused(c)),
        )
        .map((c) => ({
          kind: 'side-chat' as const,
          runId: c.id,
          name: 'Side chat',
          factoryId: c.factoryId,
          runs: 1,
        })),
    describe: (id, place) => {
      const c = saved.get(id)
      return (
        c && { kind: 'side-chat', place, runId: c.id, name: 'Side chat', factoryId: c.factoryId }
      )
    },
  }
  const pump = options.tasks.addQueueSource(source)
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'run-updated' || event.type === 'run-output') {
      const id = event.type === 'run-updated' ? event.run.id : event.runId
      if (saved.forRun(id)) setImmediate(() => settle(id))
    }
    if (event.type === 'task-deleted')
      void removeTask(event.taskId).catch((error) =>
        console.error(redactSecrets(`Couldn’t stop deleted Task’s side chat: ${String(error)}`)),
      )
    if (event.type === 'agent-health-changed' || event.type === 'settings-changed') changed()
  })
  health.onReady(() => {
    if (!closed) changed()
  })
  async function removeTask(taskId: string) {
    for (const c of saved.list().filter((c) => c.taskId === taskId)) {
      saved.save({ ...c, state: 'failed', error: 'The Task was deleted.' })
      await stopRun(c)
      saved.remove(c.sourceRunId)
    }
  }
  for (const c of saved.list()) {
    if (!store.getTask(c.taskId)) {
      void removeTask(c.taskId).catch((error) => console.error(redactSecrets(String(error))))
      continue
    }
    if (c.state === 'working') {
      const current = reconcile(c)
      const run = store.getRun(c.id)
      if (run && run.state !== 'finished') setImmediate(() => settle(c.id))
      else
        saved.save({
          ...current,
          state: 'failed',
          error: 'TED restarted before the reply completed. Retry to continue.',
        })
    }
  }
  return {
    async get(id: string): Promise<SideChat | null> {
      find(id)
      const c = saved.get(id)
      return c ? view(c) : null
    },
    async open(id: string): Promise<SideChat> {
      const previous = saved.get(id)
      if (previous) {
        find(id)
        return view(previous)
      }
      const existing = opens.get(id)
      if (existing) return existing
      const work = (async () => {
        const { source, task } = find(id)
        if (runs.output.kept(id) === 'none')
          throw new RequestError(
            410,
            'This Run’s output is no longer kept, so a side chat can’t be started.',
          )
        const entries = agents.get(source.agent).chat(runs.output.entries(id), source.cwd)
        const snapshot = boundSnapshot(
          redactSecrets(source.prompt),
          redactSecrets(
            entries
              .map((e) =>
                e.kind === 'tool'
                  ? `${e.tool}: ${e.title}\n${e.output ?? ''}`
                  : `${e.kind}: ${e.text}`,
              )
              .join('\n\n'),
          ),
        )
        const chatId = randomUUID()
        await writeSnapshot(home, chatId, snapshot.text)
        const c: StoredSideChat = {
          id: chatId,
          sourceRunId: id,
          taskId: task.id,
          factoryId: task.factoryId,
          lead: {
            agent: source.agent,
            ...(source.model && { model: source.model }),
            ...(source.effort && { effort: source.effort }),
          },
          snapshotAt: new Date().toISOString(),
          truncated: snapshot.truncated || runs.output.kept(id) === 'tail',
          digest: createHash('sha256').update(snapshot.text).digest('hex'),
          state: 'ready',
          contextSent: false,
          outputAfter: 0,
        }
        find(id)
        saved.save(c)
        await store.persisted()
        return view(c)
      })().finally(() => opens.delete(id))
      opens.set(id, work)
      return work
    },
    async send(id: string, text: string): Promise<SideChat> {
      let c = requireChat(id)
      if (c.state === 'queued' || c.state === 'working' || starts.has(c.id) || stops.has(c.id))
        throw new RequestError(409, 'Wait for the side-chat reply to finish first')
      await readSnapshot(home, c.id).catch(() => {
        throw new RequestError(410, 'The side-chat snapshot is no longer kept.')
      })
      c = requireChat(id)
      if (c.state === 'queued' || c.state === 'working' || starts.has(c.id) || stops.has(c.id))
        throw new RequestError(409, 'Wait for the side-chat reply to finish first')
      const message = store.queueRunMessage({ runId: c.id, text })
      save({
        ...c,
        state: 'queued',
        messageId: message.id,
        outputAfter: store.runReadOffset(c.id),
        error: undefined,
      })
      return view(saved.get(id) ?? c)
    },
    async stop(id: string): Promise<SideChat> {
      const c = requireChat(id)
      fail(c, 'The reply was stopped. Your question is saved.')
      await stopRun(c)
      return view(requireChat(id))
    },
    async retry(id: string): Promise<SideChat> {
      let c = requireChat(id)
      if (c.state !== 'failed' || !c.messageId)
        throw new RequestError(409, 'There is no interrupted question to retry')
      await stopRun(c)
      await readSnapshot(home, c.id)
      c = requireChat(id)
      if (c.state !== 'failed' || !c.messageId)
        throw new RequestError(409, 'The side chat is no longer waiting for Retry')
      c = reconcile(c)
      if (runs.acceptedInputs(c.id).includes(c.messageId ?? '')) {
        const old = pending(c)
        if (!old) throw new RequestError(409, 'The saved question is missing')
        const message = store.queueRunMessage({ runId: c.id, text: old.text })
        c = { ...c, messageId: message.id }
      }
      save({ ...c, state: 'queued', outputAfter: store.runReadOffset(c.id), error: undefined })
      return view(requireChat(id))
    },
    async removeFactory(factoryId: string) {
      for (const c of saved.list().filter((c) => c.factoryId === factoryId))
        await removeTask(c.taskId)
    },
    async close() {
      closed = true
      unsubscribe()
      await Promise.allSettled([...starts.values(), ...stops.values()])
      release?.()
      release = undefined
    },
  }
}
