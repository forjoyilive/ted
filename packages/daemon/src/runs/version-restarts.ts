import { readFile, rename, writeFile } from 'node:fs/promises'
import type { AgentKind, Run } from '@ted/protocol'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { TedStore } from '../store/index.ts'
import type { Conversations } from './conversations.ts'

export interface VersionRestarts {
  close(): void
}

export async function restartOnNewVersions(options: {
  store: TedStore
  health: Pick<AgentHealthMonitor, 'onVersion'>
  conversations: Pick<Conversations, 'restart'>
  versionsFile: string
}): Promise<VersionRestarts> {
  const { store, conversations, versionsFile } = options
  const seen = await readVersions(versionsFile)
  const pending = new Set<string>()
  let closed = false
  let saving = Promise.resolve()

  const save = () => {
    const text = JSON.stringify(seen)
    saving = saving
      .then(async () => {
        const tmp = `${versionsFile}.${process.pid}.tmp`
        await writeFile(tmp, text, { mode: 0o600 })
        await rename(tmp, versionsFile)
      })
      .catch((error: unknown) => console.error('couldn’t record agent versions:', error))
  }

  const tryRestart = (run: Run) => {
    if (closed || !pending.has(run.id)) return
    if (store.sideChats.forRun(run.id)) return void pending.delete(run.id)
    if (run.state === 'finished' || run.asleep) return void pending.delete(run.id)
    if (run.state !== 'idle' || !store.settings().restartIdleRuns) return
    pending.delete(run.id)
    conversations
      .restart(run.id)
      .catch((error: unknown) =>
        console.error(`couldn’t restart Run ${run.id} onto the new agent version:`, error),
      )
  }

  options.health.onVersion((kind: AgentKind, version: string) => {
    const before = seen[kind]
    if (before === version) return
    seen[kind] = version
    save()
    if (before === undefined || closed) return
    if (!store.settings().restartIdleRuns) return
    for (const run of store.listRuns()) {
      if (run.agent !== kind || run.state === 'finished') continue
      pending.add(run.id)
      tryRestart(run)
    }
  })

  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'run-updated') tryRestart(event.run)
  })

  return {
    close() {
      closed = true
      pending.clear()
      unsubscribe()
    },
  }
}

async function readVersions(file: string): Promise<Partial<Record<AgentKind, string>>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'string'),
    ) as Partial<Record<AgentKind, string>>
  } catch {
    return {}
  }
}
