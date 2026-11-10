import type { NewTaskDraft, TaskDraftState } from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { clarifyDepths, efforts, priorities } from '@ted/protocol/task'

export function emptyTaskDraft(): NewTaskDraft {
  return {
    revision: crypto.randomUUID(),
    title: '',
    description: '',
    priority: 'none',
    blockedBy: [],
    attachments: [],
    start: true,
    moreOpen: false,
    dismissed: [],
    filled: {},
  }
}

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function taskDraftSession(
  factoryId: string,
  options: {
    storage: DraftStorage
    read(): Promise<TaskDraftState>
    save(draft: NewTaskDraft): Promise<TaskDraftState>
    changed(draft: NewTaskDraft): void
    failed(error: unknown): void
  },
) {
  const key = `ted.newTaskDraft.v1.${factoryId}`
  let current = emptyTaskDraft()
  let pending: NewTaskDraft | undefined
  let saving: Promise<void> | undefined
  let loaded = false

  function remember(draft: NewTaskDraft) {
    options.storage.setItem(key, JSON.stringify(draft))
  }

  function forget(revision: string) {
    try {
      const stored = options.storage.getItem(key)
      if (stored && (JSON.parse(stored) as NewTaskDraft).revision === revision)
        options.storage.removeItem(key)
    } catch (error) {
      options.failed(error)
    }
  }

  async function drain() {
    while (pending) {
      const draft = pending
      pending = undefined
      try {
        await options.save(draft)
        forget(draft.revision)
      } catch (error) {
        pending ??= draft
        throw error
      }
    }
  }

  function persist() {
    if (!saving) {
      saving = drain().finally(() => {
        saving = undefined
      })
      void saving.catch(options.failed)
    }
    return saving
  }

  return {
    async load() {
      const state = await options.read()
      let recovery: NewTaskDraft | undefined
      try {
        const text = options.storage.getItem(key)
        if (text) {
          recovery = recoveryDraft(JSON.parse(text))
        }
      } catch (error) {
        options.failed(error)
      }
      if (
        recovery &&
        (recovery.revision === state.clearedRevision ||
          state.clearedRevisions?.includes(recovery.revision))
      ) {
        forget(recovery.revision)
        recovery = undefined
      }
      current = recovery ?? state.draft ?? emptyTaskDraft()
      loaded = true
      options.changed(current)
      if (recovery) {
        pending = recovery
        void persist()
      }
      return current
    },
    get() {
      return current
    },
    update(change: Partial<NewTaskDraft> | ((draft: NewTaskDraft) => Partial<NewTaskDraft>)) {
      if (!loaded) return
      current = {
        ...current,
        ...(typeof change === 'function' ? change(current) : change),
        revision: crypto.randomUUID(),
      }
      options.changed(current)
      try {
        remember(current)
      } catch (error) {
        options.failed(error)
      }
      pending = current
      void persist()
    },
    async flush() {
      if (saving) await saving
      if (pending) await persist()
    },
    consumed(revision: string) {
      forget(revision)
      if (current.revision === revision) {
        current = emptyTaskDraft()
        options.changed(current)
      }
    },
  }
}

function recoveryDraft(value: unknown): NewTaskDraft | undefined {
  const record = (given: unknown): given is Record<string, unknown> =>
    given !== null && typeof given === 'object' && !Array.isArray(given)
  const strings = (given: unknown) =>
    Array.isArray(given) && given.every((v) => typeof v === 'string')
  if (
    !record(value) ||
    typeof value.revision !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.start !== 'boolean' ||
    typeof value.moreOpen !== 'boolean' ||
    !priorities.some((p) => p === value.priority) ||
    !strings(value.blockedBy) ||
    !strings(value.dismissed) ||
    !record(value.filled) ||
    (value.source !== undefined && typeof value.source !== 'string') ||
    (value.clarifyDepth !== undefined && !clarifyDepths.some((d) => d === value.clarifyDepth)) ||
    !Array.isArray(value.attachments) ||
    value.attachments.some(
      (file) =>
        !record(file) ||
        typeof file.hash !== 'string' ||
        typeof file.name !== 'string' ||
        typeof file.mediaType !== 'string' ||
        typeof file.size !== 'number',
    )
  )
    return undefined
  const lead = value.lead
  if (
    lead !== undefined &&
    (!record(lead) ||
      !agentKinds.some((a) => a === lead.agent) ||
      (lead.model !== undefined && typeof lead.model !== 'string') ||
      (lead.effortMode !== undefined && lead.effortMode !== 'stage') ||
      (lead.effort !== undefined && !efforts.some((e) => e === lead.effort)))
  )
    return undefined
  return value as unknown as NewTaskDraft
}
