import type {
  AgentKind,
  Attachment,
  ClarifyDepth,
  Effort,
  Factory,
  LinearLookup,
  Priority,
  Task,
  TaskLead,
} from '@ted/protocol'
import { findLinearUrl } from '@ted/protocol/linear'
import { agentKinds } from '@ted/protocol/run'
import { clarifyDepths, efforts, priorities } from '@ted/protocol/task'
import { type DragEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { ChevronIcon, CloseIcon, PaperclipIcon, PlusIcon } from '../components/icons.tsx'
import { Select } from '../components/Select.tsx'
import {
  agentLabels,
  clarifyDepthLabels,
  formatSize,
  leadSummary,
  modelChoices,
  priorityLabels,
} from '../task-fields.ts'
import { ted } from '../ted.ts'
import styles from './NewTaskDialog.module.css'
import views from './views.module.css'

const maxAttachmentBytes = 25 * 1024 * 1024

interface NewTaskDialogProps {
  factories: readonly Factory[]
  tasks: readonly Task[]
  factoryId: string | undefined
  onClose: () => void
}

export function NewTaskDialog({ factories, tasks, factoryId, onClose }: NewTaskDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const headingId = useId()

  const [factory, setFactory] = useState(
    () => factories.find((f) => f.id === factoryId)?.id ?? factories[0]?.id,
  )
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Priority>('none')
  const [blockedBy, setBlockedBy] = useState<string[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [start, setStart] = useState(true)
  const [moreOpen, setMoreOpen] = useState(false)
  const [clarifyDepth, setClarifyDepth] = useState<ClarifyDepth>('auto')
  const [lead, setLead] = useState<TaskLead>()
  const [defaultLead, setDefaultLead] = useState<TaskLead>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [source, setSource] = useState<Source>()
  const [dismissed, setDismissed] = useState<readonly string[]>([])
  const filled = useRef<{ title?: string; priority?: Priority }>({})
  const lookups = useRef(0)

  useEffect(() => {
    dialog.current?.showModal()
    descriptionField.current?.focus()
  }, [])

  useEffect(() => {
    if (factory === undefined) return
    let current = true
    ted.taskDefaults(factory).then(
      (defaults) => {
        if (!current) return
        setDefaultLead(defaults.lead)
        setLead(defaults.lead)
        setClarifyDepth(defaults.clarifyDepth)
      },
      () => {
        if (current) setDefaultLead(undefined)
      },
    )
    return () => {
      current = false
    }
  }, [factory])

  const chosenFactory = factories.find((f) => f.id === factory)
  const canCreate =
    chosenFactory !== undefined && description.trim() !== '' && uploading === 0 && !busy

  function lookUp(url: string, identifier: string) {
    const ticket = ++lookups.current
    setSource({ url, identifier, lookup: undefined })
    ted.lookupLinear(url).then(
      (lookup) => {
        if (ticket !== lookups.current) return
        setSource({ url, identifier, lookup })
        if (lookup.state !== 'found') return
        const { issue } = lookup
        setTitle((current) =>
          current.trim() === '' || current === filled.current.title ? issue.title : current,
        )
        setPriority((current) =>
          current === 'none' || current === filled.current.priority ? issue.priority : current,
        )
        filled.current = { title: issue.title, priority: issue.priority }
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
  }

  function changeDescription(text: string) {
    setDescription(text)
    const link = findLinearUrl(text)
    if (!link) {
      if (source) {
        lookups.current++
        setSource(undefined)
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
  }

  function clear() {
    setTitle('')
    setDescription('')
    lookups.current++
    setSource(undefined)
    setDismissed([])
    filled.current = {}
    setPriority('none')
    setBlockedBy([])
    setAttachments([])
    setStart(true)
    if (defaultLead) setLead(defaultLead)
    setError(undefined)
    descriptionField.current?.focus()
  }

  async function create(more: boolean) {
    if (!canCreate) return
    setBusy(true)
    setError(undefined)
    try {
      await ted.createTask({
        factory: chosenFactory.key,
        title: title.trim(),
        description,
        priority,
        clarifyDepth,
        ...(lead && { lead }),
        blockedBy,
        attachments: attachments.map(({ hash, name, mediaType }) => ({ hash, name, mediaType })),
        ...(source && { source: source.url }),
        start,
      })
      if (more) clear()
      else onClose()
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }

  async function attach(files: readonly File[]) {
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
        onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          New Task
        </h2>
        <span className={styles.in}>in</span>
        <Select
          aria-label="Factory"
          value={factory ?? ''}
          disabled={factories.length === 0}
          onChange={(event) => setFactory(event.target.value)}
        >
          {factories.length === 0 && <option value="">No Factories yet</option>}
          {factories.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

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
            onKeySaved={() => lookUp(source.url, source.identifier)}
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
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={`Remove ${a.name}`}
              onClick={() => setAttachments((current) => current.filter((c) => c !== a))}
            >
              <CloseIcon size={11} />
            </button>
          </span>
        ))}
        {uploading > 0 && <span className={styles.chipMeta}>Attaching…</span>}
        <button type="button" className={styles.attach} onClick={() => fileInput.current?.click()}>
          Drop files here, or click to attach
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(event) => {
            void attach([...(event.target.files ?? [])])
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
        <button
          type="button"
          className={styles.moreToggle}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <ChevronIcon open={moreOpen} className={styles.moreChevron} />
          <span className={styles.moreLabel}>More</span>
          {!moreOpen && <span className={styles.moreSummary}>{summary}</span>}
        </button>
        {moreOpen && (
          <div className={styles.moreBody}>
            <div className={styles.field}>
              <span className={styles.labelRow}>
                <span className={styles.label} id={`${headingId}-depth`}>
                  Clarify depth
                </span>
                <Help>
                  How hard Clarify questions you before work starts. Auto lets the Task Lead choose;
                  Grill asks until nothing is left open.
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
              <LeadFields id={headingId} lead={lead} factoryLead={defaultLead} onChange={setLead} />
            )}
          </div>
        )}
      </section>

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
        <Button disabled={!canCreate} onClick={() => void create(true)}>
          Create more
        </Button>
        <Button
          variant="primary"
          shortcut="⌘↵"
          aria-keyshortcuts="Meta+Enter"
          disabled={!canCreate}
          onClick={() => void create(false)}
        >
          Create
        </Button>
      </footer>
      {(error !== undefined || factories.length === 0) && (
        <p className={styles.error} role="alert">
          {error ?? 'Add a Factory before you create a Task.'}
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
                  description goes to the Task Lead as context.
                </Help>
              </>
            ) : (
              'Source set. The Task links to this issue.'
            )}
          </span>
        </span>
        <button
          type="button"
          className={styles.chipRemove}
          aria-label="Remove source"
          onClick={onRemove}
        >
          <CloseIcon size={11} />
        </button>
      </fieldset>
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

  async function save() {
    if (key.trim() === '' || saving) return
    setSaving(true)
    setProblem(undefined)
    try {
      const status = await ted.saveLinearKey(key)
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
      setProblem(readableError(failure))
    } finally {
      setSaving(false)
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
              void save()
            }
          }}
        />
        <Button size="small" disabled={key.trim() === '' || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <button
          type="button"
          className={styles.keyLink}
          onClick={() => void ted.openLinearKeyPage()}
        >
          Create a key ↗
        </button>
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
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const searchField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searching) searchField.current?.focus()
  }, [searching])
  const listId = useId()
  const needle = query.trim().toLowerCase()
  const matches = tasks
    .filter((t) => t.stage !== 'done' && !blockers.includes(t))
    .filter(
      (t) =>
        needle === '' ||
        t.displayId.toLowerCase().includes(needle) ||
        t.title.toLowerCase().includes(needle),
    )
    .slice(0, 8)

  function choose(task: Task) {
    onAdd(task.id)
    setQuery('')
    setSearching(false)
  }

  return (
    <div className={`${styles.field} ${styles.grow}`}>
      <span className={styles.labelRow}>
        <span className={styles.label}>Blocked by</span>
        <span className={styles.hint}>any Factory</span>
      </span>
      <div className={styles.blockers}>
        {blockers.map((task) => (
          <span key={task.id} className={styles.blocker}>
            <span className={styles.blockerId}>{task.displayId}</span>
            <span className={styles.blockerTitle}>{task.title}</span>
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={`Remove ${task.displayId}`}
              onClick={() => onRemove(task.id)}
            >
              <CloseIcon size={11} />
            </button>
          </span>
        ))}
        {searching ? (
          <span className={styles.search}>
            <input
              className={styles.searchInput}
              aria-label="Find a Task"
              placeholder="Find a Task"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              ref={searchField}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setSearching(false)
                } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault()
                  const [first] = matches
                  if (first) choose(first)
                }
              }}
            />
            <div className={styles.options} id={listId} role="listbox" aria-label="Tasks">
              {matches.length === 0 && <p className={styles.noMatch}>No matching Tasks</p>}
              {matches.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className={styles.option}
                  onClick={() => choose(task)}
                >
                  <span className={styles.blockerId}>{task.displayId}</span>
                  <span className={styles.blockerTitle}>{task.title}</span>
                </button>
              ))}
            </div>
          </span>
        ) : (
          <Button size="small" onClick={() => setSearching(true)}>
            <PlusIcon />
            {blockers.length === 0 ? 'Add blocker' : 'Add'}
          </Button>
        )}
      </div>
    </div>
  )
}

function LeadFields({
  id,
  lead,
  factoryLead,
  onChange,
}: {
  id: string
  lead: TaskLead
  factoryLead: TaskLead | undefined
  onChange: (lead: TaskLead) => void
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
      ...(effort !== '' && { effort: effort as Effort }),
    })

  return (
    <div className={styles.field}>
      <span className={styles.labelRow}>
        <span className={styles.label}>Task Lead</span>
        <Help>
          The agent that carries this Task through its Stages. Filled from the Factory’s lead.
        </Help>
      </span>
      <div className={styles.leadRow}>
        <Select
          aria-label="Agent"
          value={lead.agent}
          onChange={(event) => {
            const agent = event.target.value as AgentKind
            const same = factoryLead?.agent === agent ? factoryLead : undefined
            set(agent, same?.model ?? '', lead.effort ?? '')
          }}
        >
          {agentKinds.map((agent) => (
            <option key={agent} value={agent}>
              {agentLabels[agent]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Model"
          id={`${id}-model`}
          value={lead.model ?? ''}
          onChange={(event) => set(lead.agent, event.target.value, lead.effort ?? '')}
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
          value={lead.effort ?? ''}
          onChange={(event) => set(lead.agent, lead.model ?? '', event.target.value)}
        >
          <option value="">Default effort</option>
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

function readableError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
