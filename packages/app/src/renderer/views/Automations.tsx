import type {
  Automation,
  AutomationDetail,
  AutomationRequest,
  AutomationRun,
  AutomationTaskLink,
  AutomationTemplate,
  Factory,
  MachineSettings,
  RunSummary,
  Task,
} from '@ted/protocol'
import { billingNames } from '@ted/protocol/health'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  agentModel,
  clockOf,
  duplicateOf,
  duration,
  firingDate,
  historyResult,
  lastResult,
  nextFiring,
  nowChip,
  retryable,
  scheduleDescription,
  templateScheduleText,
  trigger,
} from '../automations.ts'
import dialogs from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import { DotIcon } from '../components/icons.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { ChatBody, type ChatExtra, runMeta } from '../components/RunChat.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import { sendOnEnter } from '../composer-keys.ts'
import {
  useAutomationState,
  useAutomationsState,
  useAutomationTemplates,
  useRunChatState,
} from '../data.ts'
import { useNow } from '../requests.ts'
import { agentLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import type { TemplateChoice } from './AutomationDialog.tsx'
import styles from './Automations.module.css'
import { stageName } from './TaskViews.tsx'
import views from './views.module.css'

function act(request: () => Promise<unknown>, onError: (message: string) => void) {
  request().catch((failure: unknown) => onError(readableError(failure)))
}

function Toggle({ automation, onError }: { automation: Automation; onError: (e: string) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={automation.on}
      aria-label={`${automation.name} on`}
      className={styles.switch}
      onClick={(event) => {
        event.stopPropagation()
        act(() => ted.setAutomationOn(automation.id, !automation.on), onError)
      }}
    >
      <span className={styles.knob} />
    </button>
  )
}

function TaskLinks({
  tasks,
  onOpenTask,
}: {
  tasks: readonly Pick<AutomationTaskLink, 'displayId'>[]
  onOpenTask: (ref: string) => void
}) {
  return (
    <>
      {tasks.map((task, index) => (
        <span key={task.displayId}>
          <button
            type="button"
            className={styles.taskLink}
            onClick={(event) => {
              event.stopPropagation()
              onOpenTask(task.displayId)
            }}
          >
            {task.displayId}
          </button>
          {index < tasks.length - 1 && ', '}
        </span>
      ))}
    </>
  )
}

function NowChip({ automation }: { automation: Automation }) {
  const chip = nowChip(automation.now)
  if (!chip) return null
  const glyph =
    automation.now?.kind === 'waiting'
      ? 'waiting'
      : automation.now?.kind === 'queued'
        ? 'queued'
        : automation.now?.kind === 'paused'
          ? 'paused'
          : 'working'
  return (
    <StatusChip tone={chip.tone} glyph={glyph}>
      {chip.text}
    </StatusChip>
  )
}

function Breadcrumb({
  factory,
  count,
  onNew,
}: {
  factory: Factory | undefined
  count: number | undefined
  onNew: () => void
}) {
  return (
    <header className={views.header}>
      <h1 className={styles.crumbs}>
        <span className={styles.crumbFactory}>{factory?.name ?? 'Factory'}</span>
        <span className={styles.crumbSlash} aria-hidden>
          /
        </span>
        <span>Automations</span>
        {count !== undefined && count > 0 && <span className={styles.crumbCount}>{count}</span>}
      </h1>
      <span className={views.headerSpacer} />
      <Button variant="primary" size="small" onClick={onNew}>
        New Automation
      </Button>
    </header>
  )
}

export function AutomationsPage({
  factory,
  banners,
  onOpen,
  onNew,
  onOpenTask,
}: {
  factory: Factory | undefined
  banners: ReactNode
  onOpen: (automation: Automation) => void
  onNew: (template: TemplateChoice) => void
  onOpenTask: (ref: string) => void
}) {
  const resource = useAutomationsState(factory?.id)
  const automations = resource.value
  const templates = useAutomationTemplates()
  const now = useNow()
  const [error, setError] = useState<string>()
  return (
    <section className={views.pane} aria-label="Automations">
      <Breadcrumb factory={factory} count={automations?.length} onNew={() => onNew('blank')} />
      {banners}
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={views.body}>
        {automations === undefined ? (
          resource.error ? (
            <LoadingError error={resource.error} retry={resource.retry} />
          ) : (
            <Skeleton shape="settings" label="Loading Automations…" />
          )
        ) : automations.length === 0 ? (
          <AutomationsEmpty templates={templates} onNew={onNew} />
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.toggleCell}>
                  <span className={styles.hidden}>On</span>
                </th>
                <th>Name and schedule</th>
                <th>Next firing</th>
                <th>Last result</th>
                <th>Now</th>
                <th>Agent · model</th>
              </tr>
            </thead>
            <tbody>
              {automations.map((automation) => {
                const last = lastResult(automation.last, now)
                const canRetry =
                  automation.last?.result.kind === 'failed' &&
                  automation.last.retriedAt === undefined
                return (
                  <tr
                    key={automation.id}
                    className={styles.row}
                    data-off={!automation.on}
                    onClick={() => onOpen(automation)}
                  >
                    <td className={styles.toggleCell}>
                      <Toggle automation={automation} onError={setError} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.name}
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpen(automation)
                        }}
                      >
                        {automation.name}
                      </button>
                      <span className={styles.sub}>{scheduleDescription(automation)}</span>
                    </td>
                    <td className={styles.muted}>{nextFiring(automation, now)}</td>
                    <td>
                      {last && (
                        <span className={styles.result} data-failed={last.failed === true}>
                          {last.failed && <DotIcon className={styles.failedDot} />}
                          {last.text}
                          {last.tasks && (
                            <>
                              {' '}
                              <TaskLinks
                                tasks={last.tasks.map((displayId) => ({ displayId }))}
                                onOpenTask={onOpenTask}
                              />
                            </>
                          )}
                          {last.age !== undefined && ` · ${last.age}`}
                          {canRetry && automation.last && (
                            <Button
                              size="small"
                              className={styles.retry}
                              onClick={(event) => {
                                event.stopPropagation()
                                const runId = automation.last?.id ?? ''
                                act(() => ted.retryAutomationRun(runId), setError)
                              }}
                            >
                              Retry
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                    <td>
                      <NowChip automation={automation} />
                    </td>
                    <td className={styles.muted}>{agentModel(automation)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

export function AutomationsEmpty({
  templates,
  onNew,
}: {
  templates: readonly AutomationTemplate[]
  onNew: (template: TemplateChoice) => void
}) {
  return (
    <div className={styles.empty}>
      <h2 className={styles.emptyTitle}>No Automations yet</h2>
      <p className={styles.emptyLine}>
        An Automation starts a Run on a schedule, usually to bring new work in as Tasks. Start from
        a template or a blank one.
      </p>
      <ul className={styles.cards}>
        {templates.map((template) => (
          <li key={template.id} className={styles.card}>
            <h3 className={styles.cardTitle}>{template.name}</h3>
            <p className={styles.cardText}>{template.summary}</p>
            <span className={styles.cardSchedule}>{templateScheduleText(template.schedule)}</span>
            <Button
              size="small"
              aria-label={`Use template: ${template.name}`}
              onClick={() => onNew(template.id)}
            >
              Use template
            </Button>
          </li>
        ))}
        <li className={styles.card}>
          <h3 className={styles.cardTitle}>Blank</h3>
          <p className={styles.cardText}>Write your own prompt and schedule.</p>
          <span className={styles.cardSchedule}>Pick a schedule</span>
          <Button size="small" onClick={() => onNew('blank')}>
            Start blank
          </Button>
        </li>
      </ul>
    </div>
  )
}

function MoreMenu({
  automation,
  onDuplicated,
  onDelete,
  onError,
}: {
  automation: Automation
  onDuplicated: (copy: Automation) => void
  onDelete: () => void
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onEscape)
    }
  }, [open])
  return (
    <div ref={ref} className={styles.anchor}>
      <Button
        size="small"
        aria-label="Automation actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </Button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Automation actions">
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false)
              ted
                .createAutomation(duplicateOf(automation))
                .then(onDuplicated, (e: unknown) => onError(readableError(e)))
            }}
          >
            Duplicate
            <span className={styles.menuNote}>The copy starts turned off</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.danger}`}
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Delete…
          </button>
        </div>
      )}
    </div>
  )
}

function DeleteAutomationDialog({
  automation,
  onClose,
  onDeleted,
}: {
  automation: Automation
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <Dialog onClose={onClose}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={dialogs.heading}>
            {`Delete “${automation.name}”?`}
          </h2>
          <p className={dialogs.body}>
            Its history goes with it, and an open Run stops. Tasks it created stay.
          </p>
          {error !== undefined && (
            <p className={dialogs.error} role="alert">
              {error}
            </p>
          )}
          <div className={dialogs.buttons}>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                ted.deleteAutomation(automation.id).then(onDeleted, (e: unknown) => {
                  setError(readableError(e))
                  setBusy(false)
                })
              }}
            >
              Delete
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

function totalsLine(detail: AutomationDetail): string {
  const { history, automation } = detail
  const count = (kind: AutomationRun['result']['kind']) =>
    history.filter((r) => r.result.kind === kind).length
  const parts = [
    count('failed') > 0 ? `${count('failed')} failed` : undefined,
    count('skipped') > 0 ? `${count('skipped')} skipped` : undefined,
    count('stopped') > 0 ? `${count('stopped')} stopped` : undefined,
  ].filter((p) => p !== undefined)
  const runs = `${automation.totals.runs} ${automation.totals.runs === 1 ? 'Run' : 'Runs'}`
  const tasks = `${automation.totals.tasksCreated} ${automation.totals.tasksCreated === 1 ? 'Task' : 'Tasks'} created`
  return [`${runs} · ${tasks}`, parts.join(' · ')].filter((p) => p !== '').join('\n')
}

function Details({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.detail}>
      <h2 className={styles.detailTitle}>{title}</h2>
      {children}
    </section>
  )
}

export function AutomationView({
  automationId,
  banners,
  settings,
  onBack,
  onOpenRun,
  onEdit,
  onOpenAutomation,
  onOpenTask,
}: {
  automationId: string
  banners: ReactNode
  settings: MachineSettings | undefined
  onBack: () => void
  onOpenRun: (runId: string) => void
  onEdit: (automation: Automation) => void
  onOpenAutomation: (automation: Automation) => void
  onOpenTask: (ref: string) => void
}) {
  const resource = useAutomationState(automationId)
  const detail = resource.value
  const now = useNow()
  const [error, setError] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  if (detail === undefined)
    return (
      <section className={views.pane} aria-label="Automation">
        <header className={styles.viewHeader}>
          <button type="button" className={styles.backLink} onClick={onBack}>
            ← Automations
          </button>
          <h1 className={styles.title}>Automation</h1>
        </header>
        <div className={views.body}>
          {resource.error ? (
            <LoadingError error={resource.error} retry={resource.retry} />
          ) : (
            <Skeleton shape="history" label="Loading Automation…" />
          )}
        </div>
      </section>
    )
  if (detail === null) {
    return (
      <section className={views.pane} aria-label="Automation">
        <button type="button" className={views.back} onClick={onBack}>
          ← Automations
        </button>
        <p className={views.empty}>This Automation was deleted.</p>
      </section>
    )
  }
  const { automation, history } = detail
  const zone = automation.timeZone
  const canRetry = retryable(history)
  const line = [
    scheduleDescription(automation),
    automation.on && automation.nextFirings[0] !== undefined
      ? `next ${firingDate(automation.nextFirings[0])}`
      : 'Off',
    agentLabels[automation.agent],
    automation.model,
    automation.effort,
  ]
    .filter(Boolean)
    .join(' · ')
  const billing = settings?.billing[automation.agent]
  return (
    <>
      <section className={views.pane} aria-label="Automation">
        <header className={styles.viewHeader}>
          <button type="button" className={styles.backLink} onClick={onBack}>
            ← Automations
          </button>
          <div className={styles.titleRow}>
            <Toggle automation={automation} onError={setError} />
            <h1 className={styles.title} data-off={!automation.on}>
              {automation.name}
            </h1>
            <span className={views.headerSpacer} />
            <Button
              size="small"
              onClick={() => act(() => ted.runAutomation(automation.id), setError)}
            >
              Run now
            </Button>
            <Button size="small" onClick={() => onEdit(automation)}>
              Edit
            </Button>
            <MoreMenu
              automation={automation}
              onDuplicated={onOpenAutomation}
              onDelete={() => setDeleting(true)}
              onError={setError}
            />
          </div>
          <p className={styles.line}>{line}</p>
        </header>
        {banners}
        {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
        {error !== undefined && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={views.body}>
          <h2 className={styles.sectionTitle}>History</h2>
          {history.length === 0 ? (
            <p className={styles.none}>No Runs yet. Run now starts one.</p>
          ) : (
            <table className={`${styles.table} ${styles.history}`}>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Trigger</th>
                  <th>Duration</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {history.map((run) => {
                  const why = trigger(run, history)
                  const result = historyResult(run)
                  const runId = run.runId
                  return (
                    <tr
                      key={run.id}
                      className={styles.row}
                      data-openable={runId !== undefined}
                      onClick={() => runId !== undefined && onOpenRun(runId)}
                    >
                      <td>
                        {runId !== undefined ? (
                          <button
                            type="button"
                            className={styles.name}
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenRun(runId)
                            }}
                          >
                            {firingDate(run.startedAt ?? run.at)}
                          </button>
                        ) : (
                          firingDate(run.startedAt ?? run.at)
                        )}
                      </td>
                      <td>
                        {why.text}
                        {why.under !== undefined && <span className={styles.sub}>{why.under}</span>}
                      </td>
                      <td className={styles.muted}>{duration(run, now)}</td>
                      <td>
                        <span className={styles.result} data-failed={result.failed === true}>
                          {result.failed && <DotIcon className={styles.failedDot} />}
                          {result.text}
                          {run.result.kind === 'created' && (
                            <>
                              {' '}
                              <TaskLinks tasks={run.result.tasks} onOpenTask={onOpenTask} />
                            </>
                          )}
                          {canRetry === run.id && (
                            <Button
                              size="small"
                              className={styles.retry}
                              onClick={(event) => {
                                event.stopPropagation()
                                act(() => ted.retryAutomationRun(run.id), setError)
                              }}
                            >
                              Retry
                            </Button>
                          )}
                        </span>
                        {result.under !== undefined && (
                          <span className={styles.sub}>{result.under}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        {deleting && (
          <DeleteAutomationDialog
            automation={automation}
            onClose={() => setDeleting(false)}
            onDeleted={() => {
              setDeleting(false)
              onBack()
            }}
          />
        )}
      </section>
      <DetailsPane className={views.detailsPane} aria-label="Automation details">
        <Details title="Schedule">
          <p className={styles.detailText}>
            {scheduleDescription(automation).replace(/ · [^·]+$/, '')}
          </p>
          <p className={styles.detailNote}>{zone}</p>
        </Details>
        <Details title="Next firings">
          {automation.nextFirings.length === 0 ? (
            <p className={styles.detailNote}>Off. Fires only when you choose Run now.</p>
          ) : (
            automation.nextFirings.map((at) => (
              <p key={at} className={styles.detailText}>
                {firingDate(at)}
              </p>
            ))
          )}
        </Details>
        <Details title="Agent">
          <p className={styles.detailText}>
            {[agentLabels[automation.agent], automation.model, automation.effort]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {billing && <p className={styles.detailNote}>{billingNames[billing]}</p>}
        </Details>
        <Details title="Prompt">
          <pre className={styles.prompt} data-open={promptOpen}>
            {automation.prompt}
          </pre>
          <button
            type="button"
            className={styles.taskLink}
            onClick={() => setPromptOpen((o) => !o)}
          >
            {promptOpen ? 'Hide prompt' : 'Show prompt'}
          </button>
        </Details>
        <Details title="Totals">
          <p className={styles.detailText}>{totalsLine(detail).split('\n')[0]}</p>
          {totalsLine(detail).split('\n')[1] !== undefined && (
            <p className={styles.detailNote}>{totalsLine(detail).split('\n')[1]}</p>
          )}
        </Details>
        <Details title="Created">
          <p className={styles.detailNote}>
            {formatDate(automation.createdAt, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}{' '}
            by you
          </p>
        </Details>
      </DetailsPane>
    </>
  )
}

function runChip(run: RunSummary, waiting: boolean): ReactNode {
  if (run.state === 'finished') return <StatusChip tone="neutral">Finished</StatusChip>
  if (waiting || run.state === 'waiting') {
    return (
      <StatusChip tone="waiting" glyph="waiting">
        Waiting on you
      </StatusChip>
    )
  }
  if (run.state === 'working') {
    return (
      <StatusChip tone="working" glyph="working">
        Working
      </StatusChip>
    )
  }
  return <StatusChip tone="neutral">Idle</StatusChip>
}

export function QuestionCard({
  request,
  onAnswered,
}: {
  request: AutomationRequest
  onAnswered?: () => void
}) {
  const now = useNow()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const answer = (input: { choice?: string; text?: string }) => {
    setBusy(true)
    setError(undefined)
    ted.answerAutomationRequest(request.id, input).then(
      () => {
        setBusy(false)
        setText('')
        onAnswered?.()
      },
      (failure: unknown) => {
        setError(readableError(failure))
        setBusy(false)
      },
    )
  }
  const minutes = Math.max(Math.round((now - Date.parse(request.createdAt)) / 60_000), 0)
  const age =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes}m ago`
        : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
  return (
    <section className={styles.question} aria-label="Question from this Run">
      <p className={styles.questionHead}>
        <span className={styles.questionKind}>Question</span>
        {` · from ${request.automationName} · ${age}`}
      </p>
      <p className={styles.questionBody}>{request.body}</p>
      {request.choices?.map((choice) => (
        <button
          key={choice}
          type="button"
          className={styles.choice}
          disabled={busy}
          onClick={() => answer({ choice })}
        >
          {choice}
        </button>
      ))}
      <textarea
        className={styles.answer}
        aria-label="Your answer"
        placeholder={request.choices ? 'Or write your own answer…' : 'Write your answer…'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={sendOnEnter(() => {
          if (!busy) answer({ text })
        })}
      />
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.questionButtons}>
        <Button
          variant="primary"
          size="small"
          shortcut="↵"
          disabled={busy || text.trim() === ''}
          onClick={() => answer({ text })}
        >
          Send
        </Button>
      </div>
    </section>
  )
}

function questionLine(request: AutomationRequest, run: RunSummary): ChatExtra {
  const open = request.answer === undefined
  return {
    id: request.id,
    at: request.createdAt,
    node: (
      <div className={styles.questionLine} data-open={open}>
        <span className={styles.questionKind}>
          {request.kind === 'question' ? 'Question' : 'Note'}
        </span>
        <span className={styles.questionText}>
          {request.body.split('\n')[0]}
          {request.kind === 'question' &&
            (open
              ? run.state === 'finished'
                ? ' · not answered'
                : ' · answer below'
              : ` · answered: ${request.answer?.text.split('\n')[0] ?? ''}`)}
        </span>
        <span className={styles.questionAt}>{clockOf(request.createdAt)}</span>
      </div>
    ),
  }
}

export function AutomationRunView({
  automationId,
  runId,
  tasks,
  onBack,
  onOpenTask,
  onOpenAutomation,
}: {
  automationId: string
  runId: string
  tasks: readonly Task[]
  onBack: () => void
  onOpenTask: (ref: string) => void
  onOpenAutomation: () => void
}) {
  const resource = useAutomationState(automationId)
  const detail = resource.value
  const chatResource = useRunChatState(runId)
  const chat = chatResource.value
  const loadError = resource.error ?? chatResource.error
  const retry = () => {
    resource.retry()
    chatResource.retry()
  }
  const [error, setError] = useState<string>()
  if (detail === null) {
    return (
      <section className={views.pane} aria-label="Automation Run">
        <button type="button" className={views.back} onClick={onBack}>
          ← Automations
        </button>
        <p className={views.empty}>This Automation was deleted.</p>
      </section>
    )
  }
  if (!detail || !chat) {
    return (
      <section className={views.pane} aria-label="Automation Run">
        <header className={styles.viewHeader}>
          <button type="button" className={styles.backLink} onClick={onBack}>
            ← Automations
          </button>
          <h1 className={styles.title}>Automation Run</h1>
        </header>
        <div className={views.empty}>
          {loadError ? (
            <LoadingError error={loadError} retry={retry} />
          ) : (
            <Skeleton shape="history" label="Loading the Run…" />
          )}
        </div>
      </section>
    )
  }
  const { automation, history } = detail
  const row = history.find((r) => r.id === runId)
  const requests = detail.requests.filter((r) => r.runId === runId)
  const open = requests.filter((r) => r.kind === 'question' && r.answer === undefined)
  const run = chat.run
  const startedAt = row?.startedAt ?? run.startedAt
  const why = row ? trigger(row, history) : undefined
  const created = row?.created ?? []
  return (
    <>
      <section className={views.pane} aria-label="Automation Run">
        <header className={styles.viewHeader}>
          <button type="button" className={styles.backLink} onClick={onBack}>
            ← {automation.name}
          </button>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>
              {automation.name} · Run of {clockOf(startedAt)}
            </h1>
            {runChip(run, open.length > 0)}
            <span className={views.headerSpacer} />
            {run.state !== 'finished' && (
              <Button size="small" onClick={() => act(() => ted.stopRun(run.id), setError)}>
                Stop
              </Button>
            )}
          </div>
          <p className={styles.line}>
            {[why?.text, firingDate(startedAt), agentLabels[run.agent], run.model, run.effort]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </header>
        {loadError && <LoadingError error={loadError} retry={retry} />}
        {error !== undefined && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.chat}>
          <ChatBody
            chat={chat}
            onStopTask={undefined}
            options={{
              bar: false,
              extra: requests.map((r) => questionLine(r, run)),
              pinned:
                open.length > 0 && run.state !== 'finished' ? (
                  <div className={views.pinned}>
                    {open.map((request) => (
                      <QuestionCard key={request.id} request={request} />
                    ))}
                  </div>
                ) : undefined,
              placeholder: 'Message this Run…',
              help: 'Goes only to this Run, as the human’s message.',
            }}
          />
        </div>
      </section>
      <DetailsPane className={views.detailsPane} aria-label="Run details">
        <Details title={`Tasks created · ${created.length}`}>
          {created.length === 0 ? (
            <p className={styles.detailNote}>None yet.</p>
          ) : (
            created.map((link) => {
              const task = tasks.find((t) => t.id === link.id)
              return (
                <div key={link.id} className={styles.createdTask}>
                  <p className={styles.detailText}>
                    <button
                      type="button"
                      className={styles.taskLink}
                      onClick={() => onOpenTask(link.displayId)}
                    >
                      {link.displayId}
                    </button>{' '}
                    {task?.title ?? link.title}
                  </p>
                  <p className={styles.detailNote}>
                    {[
                      stageName(task?.stage ?? link.stage),
                      task?.status && statusLabel(task.status),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              )
            })
          )}
        </Details>
        <Details title="Run">
          <p className={styles.detailText}>{runMeta(run)}</p>
          {why && <p className={styles.detailNote}>{why.text}</p>}
        </Details>
        <Details title="Automation">
          <p className={styles.detailText}>
            <button type="button" className={styles.taskLink} onClick={onOpenAutomation}>
              {automation.name}
            </button>
          </p>
          <p className={styles.detailNote}>{scheduleDescription(automation)}</p>
        </Details>
      </DetailsPane>
    </>
  )
}
