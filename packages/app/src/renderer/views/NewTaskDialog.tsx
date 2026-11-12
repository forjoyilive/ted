import type {
  AgentHealth,
  AgentKind,
  ClarifyDepth,
  Effort,
  Factory,
  LinearLookup,
  NewTaskDraft,
  Priority,
  Task,
  TaskLead,
} from '@ted/protocol'
import { findLinearUrl } from '@ted/protocol/linear'
import { agentKinds } from '@ted/protocol/run'
import { clarifyDepths, efforts, priorities } from '@ted/protocol/task'
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { BlockerPicker } from '../components/BlockerPicker.tsx'
import { Button } from '../components/Button.tsx'
import { CommentFiles } from '../components/CommentFiles.tsx'
import { Help } from '../components/Help.tsx'
import { ChevronIcon, CloseIcon, PaperclipIcon } from '../components/icons.tsx'
import { Select } from '../components/Select.tsx'
import { setupNotice, setupNoticeText } from '../setup-notice.ts'
import { emptyTaskDraft, taskDraftSession } from '../task-draft.ts'
import {
  agentLabels,
  clarifyDepthLabels,
  formatSize,
  leadSummary,
  modelChoices,
  priorityLabels,
} from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from './NewTaskDialog.module.css'
import views from './views.module.css'

const maxAttachmentBytes = 25 * 1024 * 1024

interface NewTaskDialogProps {
  factories: readonly Factory[]
  tasks: readonly Task[]
  factoryId: string | undefined
  initialDescription?: string
  onClose: () => void
  onOpenTask?: (task: Task) => void
}

export function NewTaskDialog({
  factories,
  tasks,
  factoryId,
  initialDescription = '',
  onClose,
  onOpenTask,
}: NewTaskDialogProps) {
  const [seed, setSeed] = useState(initialDescription)
  const [factory, setFactory] = useState(
    () => factories.find((f) => f.id === factoryId)?.id ?? factories[0]?.id,
  )
  return (
    <NewTaskForm
      key={factory ?? ''}
      factories={factories}
      tasks={tasks}
      factoryId={factory}
      initialDescription={seed}
      onClose={onClose}
      {...(onOpenTask && { onOpenTask })}
      onFactory={(id) => {
        setSeed('')
        setFactory(id)
      }}
    />
  )
}

function NewTaskForm({
  factories,
  tasks,
  factoryId: factory,
  initialDescription = '',
  onClose,
  onOpenTask,
  onFactory,
}: NewTaskDialogProps & { onFactory: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const [draft, showDraft] = useState(emptyTaskDraft)
  const [ready, setReady] = useState(false)
  const [heldFiles, setHeldFiles] = useState<File[]>([])
  const [draftError, setDraftError] = useState<string>()
  const [session] = useState(() =>
    taskDraftSession(factory ?? '', {
      storage: localStorage,
      read: () =>
        factory === undefined ? Promise.resolve({ draft: null }) : ted.taskDraft(factory),
      save: async (next) => {
        const state =
          factory === undefined ? { draft: null } : await ted.saveTaskDraft(factory, next)
        setDraftError(undefined)
        return state
      },
      changed: showDraft,
      failed: (failure) => setDraftError(`Couldn’t save the draft: ${readableError(failure)}`),
    }),
  )
  const { title, description, priority, blockedBy, attachments, start, moreOpen, dismissed } = draft
  const [defaultLead, setDefaultLead] = useState<TaskLead>()
  const [defaultDepth, setDefaultDepth] = useState<ClarifyDepth>('auto')
  const [defaultsReady, setDefaultsReady] = useState(false)
  const [health, setHealth] = useState<AgentHealth[]>()
  const [leadNotice, setLeadNotice] = useState<string>()
  const clarifyDepth = draft.clarifyDepth ?? defaultDepth
  const lead = draft.lead ?? defaultLead
  const field =
    <K extends keyof NewTaskDraft>(key: K) =>
    (next: NewTaskDraft[K] | ((current: NewTaskDraft[K]) => NewTaskDraft[K])) => {
      session.update((current) => ({
        lead: current.lead ?? defaultLead,
        clarifyDepth: current.clarifyDepth ?? defaultDepth,
        [key]: typeof next === 'function' ? next(current[key]) : next,
      }))
    }
  const setTitle = field('title')
  const setDescription = field('description')
  const setPriority = field('priority')
  const setBlockedBy = field('blockedBy')
  const setAttachments = field('attachments')
  const setStart = field('start')
  const setMoreOpen = field('moreOpen')
  const setClarifyDepth = field('clarifyDepth')
  const setLead = field('lead')
  const setDismissed = field('dismissed')
  const setup = setupNotice(
    factories.find((f) => f.id === factory),
    tasks,
  )
  const [uploading, setUploading] = useState(0)
  const uploads = useRef(new Set<Promise<void>>())
  const [busy, setBusy] = useState(false)
  const [creatingMore, setCreatingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [source, setSource] = useState<Source>()
  const lookups = useRef(0)
  const mounted = useRef(false)
  const submitting = useRef(false)
  const deferredLookup = useRef<{ url: string; identifier: string } | undefined>(undefined)

  const lookUp = useCallback(
    (url: string, identifier: string) => {
      if (!mounted.current) return
      if (submitting.current) {
        deferredLookup.current = { url, identifier }
        return
      }
      const ticket = ++lookups.current
      session.update({ source: url })
      setSource({ url, identifier, lookup: undefined })
      ted.lookupLinear(url).then(
        (lookup) => {
          if (ticket !== lookups.current) return
          setSource({ url, identifier, lookup })
          if (lookup.state !== 'found') return
          const { issue } = lookup
          session.update((current) => ({
            title:
              current.title.trim() === '' || current.title === current.filled.title
                ? issue.title
                : current.title,
            priority:
              current.priority === 'none' || current.priority === current.filled.priority
                ? issue.priority
                : current.priority,
            filled: { title: issue.title, priority: issue.priority },
          }))
        },
        (failure: unknown) => {
          if (ticket !== lookups.current) return
          setSource({
            url,
            identifier,
            lookup: {
              state: 'failed',
              error: `Couldn’t fetch from Linear: ${readableError(failure)}. The Task will be created with the link only.`,
            },
          })
        },
      )
    },
    [session],
  )

  useEffect(() => {
    let active = true
    mounted.current = true
    session.load().then(
      () => {
        if (!active) return
        if (initialDescription) {
          const text = session.get().description
          session.update({
            description: text ? `${text}\n\n${initialDescription}` : initialDescription,
          })
        }
        setReady(true)
        const restored = session.get()
        const link = restored.source
          ? findLinearUrl(restored.source)
          : findLinearUrl(restored.description)
        if (link && !restored.dismissed.includes(link.url)) lookUp(link.url, link.identifier)
      },
      (failure: unknown) => {
        if (active) setDraftError(`Couldn’t load the draft: ${readableError(failure)}`)
      },
    )
    return () => {
      active = false
      mounted.current = false
      lookups.current++
    }
  }, [session, initialDescription, lookUp])

  useEffect(() => {
    dialog.current?.showModal()
    descriptionField.current?.focus()
  }, [])

  useEffect(() => {
    if (factory === undefined || !ready) return
    let current = true
    Promise.all([ted.taskDefaults(factory), ted.checkAgentHealth(), ted.getSettings()]).then(
      ([defaults, health, settings]) => {
        if (!current) return
        setHealth(health)
        const fallback = health.find(
          (entry) =>
            settings.enabledAgents.includes(entry.agent) && entry.state !== 'not-installed',
        )
        const availableDefault: TaskLead =
          !settings.enabledAgents.includes(defaults.lead.agent) ||
          health.some(
            (entry) => entry.agent === defaults.lead.agent && entry.state !== 'not-installed',
          )
            ? defaults.lead
            : fallback
              ? { agent: fallback.agent, effortMode: 'stage' }
              : defaults.lead
        setDefaultLead(availableDefault)
        setDefaultDepth(defaults.clarifyDepth)
        const restored = session.get()
        let restoredLead = restored.lead
        if (
          restoredLead &&
          settings.enabledAgents.includes(restoredLead.agent) &&
          health.some(
            (entry) => entry.agent === restoredLead?.agent && entry.state === 'not-installed',
          )
        ) {
          const available = health.find(
            (entry) => entry.agent === availableDefault.agent && entry.state !== 'not-installed',
          )
          if (available) {
            setLeadNotice(
              `${agentLabels[restoredLead.agent]} isn’t installed. Task Lead changed to ${agentLabels[available.agent]}.`,
            )
            restoredLead = availableDefault
          }
        }
        if (
          restored.lead !== restoredLead ||
          restored.lead === undefined ||
          restored.clarifyDepth === undefined
        ) {
          session.update({
            lead: restoredLead ?? availableDefault,
            clarifyDepth: restored.clarifyDepth ?? defaults.clarifyDepth,
          })
        }
        setDefaultsReady(true)
      },
      (failure: unknown) => {
        if (current) {
          setError(`Couldn’t check Task Lead availability: ${readableError(failure)}`)
          setDefaultLead(undefined)
          setDefaultsReady(true)
        }
      },
    )
    return () => {
      current = false
    }
  }, [factory, ready, session])

  useEffect(() => {
    if (ready && defaultsReady && !busy) descriptionField.current?.focus()
  }, [ready, defaultsReady, busy])

  const chosenFactory = factories.find((f) => f.id === factory)
  const fetching = source !== undefined && source.lookup === undefined
  const canCreate =
    ready &&
    defaultsReady &&
    health !== undefined &&
    agentKinds.every((agent) => health.some((entry) => entry.agent === agent)) &&
    !health.some((entry) => entry.agent === lead?.agent && entry.state === 'not-installed') &&
    chosenFactory !== undefined &&
    description.trim() !== '' &&
    uploading === 0 &&
    !busy &&
    !fetching

  function changeDescription(text: string) {
    setDescription(text)
    const link = findLinearUrl(text)
    if (!link) {
      if (source) {
        lookups.current++
        setSource(undefined)
        session.update({ source: undefined })
      }
      return
    }
    if (link.url === source?.url || dismissed.includes(link.url)) return
    lookUp(link.url, link.identifier)
  }

  function removeSource() {
    if (!source) return
    lookups.current++
    setDismissed((current) => [...current, source.url])
    setSource(undefined)
    session.update({ source: undefined })
  }

  function clear() {
    lookups.current++
    setSource(undefined)
    setError(undefined)
    descriptionField.current?.focus()
  }

  async function close(next = onClose) {
    if (busy) return
    try {
      await Promise.all([...uploads.current])
      await session.flush()
      setDraftError(undefined)
      next()
    } catch (failure) {
      setDraftError(`Couldn’t save the draft: ${readableError(failure)}`)
    }
  }

  async function create(more: boolean) {
    if (!canCreate || submitting.current) return
    submitting.current = true
    setCreatingMore(more)
    lookups.current++
    let created = false
    setBusy(true)
    setError(undefined)
    try {
      await session.flush()
      const revision = session.get().revision
      await ted.createTask({
        draftRevision: revision,
        factory: chosenFactory.key,
        title: title.trim(),
        description,
        priority,
        clarifyDepth,
        ...(lead && { lead }),
        blockedBy: blockedBy.filter((id) => tasks.some((t) => t.id === id)),
        attachments: attachments.map(({ hash, name, mediaType }) => ({ hash, name, mediaType })),
        ...(source && { source: source.url }),
        start,
      })
      created = true
      session.consumed(revision)
      if (more) clear()
      else onClose()
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      submitting.current = false
      setBusy(false)
      const pending = deferredLookup.current
      deferredLookup.current = undefined
      const current = session.get()
      if (
        !created &&
        pending &&
        current.source === pending.url &&
        !current.dismissed.includes(pending.url)
      ) {
        lookUp(pending.url, pending.identifier)
      }
    }
  }

  function attach(files: readonly File[]) {
    if (busy) return Promise.resolve()
    if (!ready) {
      setHeldFiles((held) => [...held, ...files])
      return Promise.resolve()
    }
    const pending = upload(files)
    uploads.current.add(pending)
    void pending.finally(() => uploads.current.delete(pending))
    return pending
  }

  async function upload(files: readonly File[]) {
    const tooBig = files.find((file) => file.size > maxAttachmentBytes)
    if (tooBig) {
      setError(`${tooBig.name} is over 25 MB.`)
      return
    }
    setUploading((n) => n + files.length)
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const added = await ted.uploadAttachment({ name: file.name, mediaType: file.type }, bytes)
        setAttachments((current) =>
          current.some((a) => a.hash === added.hash && a.name === added.name)
            ? current
            : [...current, added],
        )
      } catch (failure) {
        setError(`Couldn’t attach ${file.name}: ${readableError(failure)}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  useEffect(() => {
    if (!ready || heldFiles.length === 0) return
    setHeldFiles([])
    void attach(heldFiles)
  })

  function onDrop(event: DragEvent) {
    event.preventDefault()
    void attach([...event.dataTransfer.files])
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void create(false)
    }
  }

  const blockers = blockedBy
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t) => t !== undefined)
  const note =
    start && blockers.length > 0
      ? `Waits as Blocked until ${joinIds(blockers.map((t) => t.displayId))} ${blockers.length === 1 ? 'merges' : 'merge'}`
      : start
        ? 'Unchecked puts it in Backlog'
        : 'Waits in Backlog until you start it'
  const summary = `Clarify depth ${clarifyDepthLabels[clarifyDepth]}${lead ? ` · Task Lead ${leadSummary(lead)}` : ''}`

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        return close()
      }}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          onClose()
        }
      }}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          New Task
        </h2>
        <span className={styles.in}>in</span>
        <Select
          aria-label="Factory"
          value={factory ?? ''}
          disabled={factories.length === 0 || !ready || busy || uploading > 0}
          onChange={(event) => {
            const next = event.target.value
            return close(() => onFactory(next))
          }}
        >
          {factories.length === 0 && <option value="">No Factories yet</option>}
          {factories.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
        <ActionButton
          type="button"
          className={styles.close}
          aria-label="Close"
          onClick={() => close()}
        >
          <CloseIcon />
        </ActionButton>
      </header>

      <fieldset disabled={!ready || !defaultsReady || busy} className={styles.fields}>
        <input
          className={styles.title}
          aria-label="Title"
          placeholder="Title (optional). Blank uses the first line of the description."
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className={styles.descriptionBox}>
          <textarea
            ref={descriptionField}
            className={styles.description}
            aria-label="Description"
            placeholder="Describe what you want done, or paste a Linear issue URL."
            rows={3}
            value={description}
            onChange={(event) => changeDescription(event.target.value)}
          />
          {source && (
            <SourceCard
              source={source}
              onRemove={removeSource}
              onKeySaved={() => {
                const current = session.get()
                if (current.source !== source.url || current.dismissed.includes(source.url)) return
                lookUp(source.url, source.identifier)
              }}
            />
          )}
        </div>

        <fieldset
          className={styles.attachments}
          aria-label="Attachments"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <PaperclipIcon className={styles.clip} />
          {attachments.map((a) => (
            <span key={`${a.hash}:${a.name}`} className={styles.chip}>
              {a.name}
              <span className={styles.chipMeta}>{formatSize(a.size)}</span>
              <ActionButton
                type="button"
                className={styles.chipRemove}
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments((current) => current.filter((c) => c !== a))}
              >
                <CloseIcon size={11} />
              </ActionButton>
            </span>
          ))}
          {(uploading > 0 || heldFiles.length > 0) && (
            <span className={styles.chipMeta}>Attaching…</span>
          )}
          <ActionButton
            type="button"
            className={styles.attach}
            pending={uploading > 0}
            onClick={() => fileInput.current?.click()}
          >
            Drop files here, or click to attach
          </ActionButton>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="Attach files"
            onChange={(event) => {
              attach([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
        </fieldset>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${headingId}-priority`}>
              Priority
            </label>
            <Select
              id={`${headingId}-priority`}
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
            >
              {[...priorities].reverse().map((p) => (
                <option key={p} value={p}>
                  {priorityLabels[p]}
                </option>
              ))}
            </Select>
          </div>
          <BlockedBy
            tasks={tasks}
            blockers={blockers}
            onAdd={(id) => setBlockedBy((current) => [...current, id])}
            onRemove={(id) => setBlockedBy((current) => current.filter((c) => c !== id))}
          />
        </div>

        <section className={styles.more}>
          <ActionButton
            type="button"
            className={styles.moreToggle}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <ChevronIcon open={moreOpen} className={styles.moreChevron} />
            <span className={styles.moreLabel}>More</span>
            {!moreOpen && <span className={styles.moreSummary}>{summary}</span>}
          </ActionButton>
          {moreOpen && (
            <div className={styles.moreBody}>
              <div className={styles.field}>
                <span className={styles.labelRow}>
                  <span className={styles.label} id={`${headingId}-depth`}>
                    Clarify depth
                  </span>
                  <Help>
                    How hard Clarify questions you before work starts. Auto lets the Task Lead
                    choose; Grill asks until nothing is left open.
                  </Help>
                </span>
                <div
                  className={views.segmented}
                  role="radiogroup"
                  aria-labelledby={`${headingId}-depth`}
                >
                  {clarifyDepths.map((depth) => (
                    <label key={depth} className={views.segment}>
                      <input
                        type="radio"
                        name={`${headingId}-depth`}
                        className={views.radio}
                        checked={clarifyDepth === depth}
                        onChange={() => setClarifyDepth(depth)}
                      />
                      {clarifyDepthLabels[depth]}
                    </label>
                  ))}
                </div>
              </div>
              {lead && (
                <LeadFields
                  stageEffort
                  id={headingId}
                  lead={lead}
                  factoryLead={defaultLead}
                  onChange={setLead}
                />
              )}
            </div>
          )}
        </section>

        {(leadNotice ||
          health?.some(
            (entry) => entry.agent === lead?.agent && entry.state === 'not-installed',
          )) && (
          <p className={styles.setupNotice} role="status">
            {health?.some((entry) => entry.agent === lead?.agent && entry.state === 'not-installed')
              ? `${lead ? agentLabels[lead.agent] : 'The Task Lead'} isn’t installed. Install it or choose another Task Lead in More.`
              : leadNotice}
          </p>
        )}
        {setup && (
          <p className={styles.setupNotice} role="note">
            <span>{setupNoticeText(setup)}</span>
            {onOpenTask && setup.kind === 'open' && (
              <ActionButton
                type="button"
                className={styles.setupLink}
                onClick={() => {
                  return close(() => {
                    onClose()
                    onOpenTask(setup.task)
                  })
                }}
              >
                Open setup Task
              </ActionButton>
            )}
          </p>
        )}
        <footer className={styles.footer}>
          <div className={styles.start}>
            <input
              id={`${headingId}-start`}
              type="checkbox"
              className={styles.checkbox}
              checked={start}
              onChange={(event) => setStart(event.target.checked)}
            />
            <span className={styles.startText}>
              <span className={styles.labelRow}>
                <label className={styles.startLabel} htmlFor={`${headingId}-start`}>
                  Start now
                </label>
                <Help>
                  Checked, the Task goes to Intake as soon as a slot is free. Unchecked, it waits in
                  Backlog until you start it.
                </Help>
              </span>
              <span className={styles.note}>{note}</span>
            </span>
          </div>
          <span className={styles.spacer} />
          <Button disabled={!canCreate} pending={busy && creatingMore} onClick={() => create(true)}>
            Create more
          </Button>
          <Button
            variant="primary"
            shortcut="⌘↵"
            aria-keyshortcuts="Meta+Enter"
            disabled={!canCreate}
            pending={busy && !creatingMore}
            onClick={() => create(false)}
          >
            Create
          </Button>
        </footer>
      </fieldset>
      {(error !== undefined || draftError !== undefined || factories.length === 0) && (
        <p className={styles.error} role="alert">
          {error ?? draftError ?? 'Add a Factory before you create a Task.'}
        </p>
      )}
    </dialog>
  )
}

interface Source {
  url: string
  identifier: string
  lookup: LinearLookup | undefined
}

function SourceCard({
  source,
  onRemove,
  onKeySaved,
}: {
  source: Source
  onRemove: () => void
  onKeySaved: () => void
}) {
  const { lookup } = source
  const [showing, setShowing] = useState(false)
  const linearDescription = lookup?.state === 'found' ? lookup.issue.description : undefined
  const linearFiles = lookup?.state === 'found' ? (lookup.issue.files ?? []) : []
  const unfetched = lookup?.state === 'found' ? (lookup.issue.unfetched ?? []) : []
  const heading =
    lookup?.state === 'found'
      ? `${lookup.issue.identifier} · ${lookup.issue.title}`
      : source.identifier
  return (
    <>
      <fieldset className={styles.source} aria-label="Source">
        <span className={styles.sourceKind}>Linear</span>
        <span className={styles.sourceText}>
          <span className={styles.sourceTitle}>{heading}</span>
          <span className={styles.sourceNote}>
            {lookup === undefined ? (
              'Fetching from Linear…'
            ) : lookup.state === 'found' ? (
              <>
                Source set.
                <Help>
                  TED copied the title, Priority and branch name from Linear. The issue’s
                  description goes to the Task Lead as context, and its images and uploaded files
                  come with the Task.
                </Help>
                {linearDescription !== undefined && (
                  <ActionButton
                    type="button"
                    className={styles.keyLink}
                    aria-expanded={showing}
                    onClick={() => setShowing((open) => !open)}
                  >
                    {showing ? 'Hide Linear’s description' : 'Show Linear’s description'}
                  </ActionButton>
                )}
              </>
            ) : (
              'Source set. The Task links to this issue.'
            )}
          </span>
        </span>
        <ActionButton
          type="button"
          className={styles.chipRemove}
          aria-label="Remove source"
          onClick={onRemove}
        >
          <CloseIcon size={11} />
        </ActionButton>
      </fieldset>
      {linearFiles.length > 0 && (
        <section className={styles.sourceFiles} aria-label="Files from Linear">
          <CommentFiles files={linearFiles} />
        </section>
      )}
      {unfetched.length > 0 && (
        <p className={styles.sourceProblem} role="status">
          {`Couldn’t fetch ${unfetched.map((f) => f.name).join(', ')} from Linear. The Task keeps ${unfetched.length === 1 ? 'its link' : 'their links'}.`}
        </p>
      )}
      {showing && linearDescription !== undefined && (
        <section aria-label="Linear’s description">
          <pre className={styles.sourceDescription}>{linearDescription}</pre>
        </section>
      )}
      {lookup?.state === 'failed' && (
        <p className={styles.sourceProblem} role="status">
          {lookup.error}
        </p>
      )}
      {lookup?.state === 'no-key' && <AddLinearKey onSaved={onKeySaved} />}
    </>
  )
}

function AddLinearKey({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function save() {
    if (key.trim() === '' || saving) return
    setSaving(true)
    setProblem(undefined)
    try {
      const status = await ted.saveLinearKey({ key })
      if (!mounted.current) return
      if (status.storedIn !== undefined) {
        onSaved()
        return
      }
      setProblem(
        status.state === 'locked'
          ? 'Keyring is locked. Unlock it and save again.'
          : 'No keyring found on this computer. Save the key in Settings → Integrations.',
      )
    } catch (failure) {
      if (mounted.current) setProblem(readableError(failure))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <div className={styles.keyNote}>
      <p className={styles.keyText}>
        Add a Linear API key to fill in the title, Priority and branch from Linear.
      </p>
      <div className={styles.keyRow}>
        <input
          className={styles.keyField}
          aria-label="Linear API key"
          type="password"
          spellCheck={false}
          autoComplete="off"
          placeholder="lin_api_…"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault()
              save()
            }
          }}
        />
        <Button size="small" disabled={key.trim() === '' || saving} onClick={() => save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <ActionButton
          type="button"
          className={styles.keyLink}
          onClick={() => ted.openLinearKeyPage()}
        >
          Create a key ↗
        </ActionButton>
      </div>
      {problem !== undefined && (
        <p className={styles.sourceProblem} role="status">
          {problem}
        </p>
      )}
    </div>
  )
}

function BlockedBy({
  tasks,
  blockers,
  onAdd,
  onRemove,
}: {
  tasks: readonly Task[]
  blockers: readonly Task[]
  onAdd: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className={`${styles.field} ${styles.grow}`}>
      <span className={styles.labelRow}>
        <span className={styles.label}>Blocked by</span>
        <span className={styles.hint}>any Factory</span>
      </span>
      <BlockerPicker tasks={tasks} blockers={blockers} onAdd={onAdd} onRemove={onRemove} />
    </div>
  )
}

export function LeadFields({
  id,
  lead,
  factoryLead,
  onChange,
  stageEffort = false,
  label = 'Task Lead',
  help = 'The agent that carries this Task through its Stages. Filled from the Factory’s lead.',
}: {
  id: string
  lead: TaskLead
  factoryLead: TaskLead | undefined
  onChange: (lead: TaskLead) => void
  stageEffort?: boolean
  label?: string
  help?: string
}) {
  const models = [
    ...new Set([
      ...modelChoices[lead.agent],
      ...(factoryLead?.agent === lead.agent && factoryLead.model ? [factoryLead.model] : []),
      ...(lead.model ? [lead.model] : []),
    ]),
  ]
  const set = (agent: AgentKind, model: string, effort: string) =>
    onChange({
      agent,
      ...(model !== '' && { model }),
      ...(effort === 'stage'
        ? {
            effortMode: 'stage' as const,
            ...(lead.effort !== undefined && { effort: lead.effort }),
          }
        : effort !== ''
          ? { effort: effort as Effort }
          : {}),
    })

  return (
    <div className={styles.field}>
      <span className={styles.labelRow}>
        <span className={styles.label}>{label}</span>
        <Help>{help}</Help>
      </span>
      <div className={styles.leadRow}>
        <Select
          aria-label="Agent"
          value={lead.agent}
          onChange={(event) => {
            const agent = event.target.value as AgentKind
            const same = factoryLead?.agent === agent ? factoryLead : undefined
            set(
              agent,
              same?.model ?? '',
              lead.effortMode === 'stage' ? 'stage' : (lead.effort ?? ''),
            )
          }}
        >
          <AgentOptions current={lead.agent} />
        </Select>
        <Select
          aria-label="Model"
          id={`${id}-model`}
          value={lead.model ?? ''}
          onChange={(event) =>
            set(
              lead.agent,
              event.target.value,
              lead.effortMode === 'stage' ? 'stage' : (lead.effort ?? ''),
            )
          }
        >
          <option value="">Default model</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Effort"
          value={lead.effortMode === 'stage' ? 'stage' : (lead.effort ?? '')}
          onChange={(event) => set(lead.agent, lead.model ?? '', event.target.value)}
        >
          {stageEffort && <option value="stage">Follow Stage settings</option>}
          <option value="">{stageEffort ? 'CLI default · for this Task' : 'Default effort'}</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </Select>
      </div>
    </div>
  )
}

function joinIds(ids: readonly string[]): string {
  if (ids.length <= 1) return ids.join('')
  return `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`
}
