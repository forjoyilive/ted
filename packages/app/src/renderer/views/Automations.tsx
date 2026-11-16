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
import { scheduledCheckPrompt } from '@ted/protocol/automation'
import { billingNames } from '@ted/protocol/health'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
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
import { ActionButton } from '../components/ActionButton.tsx'
import type { ShownApp } from '../components/AppsSection.tsx'
import dialogs from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import outputStyles from '../components/CheckOutputDialog.module.css'
import { CommentFiles } from '../components/CommentFiles.tsx'
import {
  buttonPosition,
  contextMenu,
  type MenuAction,
  type MenuPosition,
  useActionMenu,
} from '../components/ContextMenu.tsx'
import { CloseIcon, DotIcon } from '../components/icons.tsx'
import { Loading, LoadingError, Skeleton, SkeletonBar } from '../components/Loading.tsx'
import { QuestionChoices, type QuestionSelection } from '../components/QuestionChoices.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { RunAppLog, RunAppRows } from '../components/RunApps.tsx'
import { ChatBody, type ChatExtra, runMeta } from '../components/RunChat.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import grow from '../components/TextGrow.module.css'
import { sendOnEnter } from '../composer-keys.ts'
import {
  useAutomationState,
  useAutomationsState,
  useAutomationTemplates,
  useRunApps,
  useRunChatState,
} from '../data.ts'
import { usePendingAction } from '../pending-action.ts'
import { useNow } from '../requests.ts'
import { agentLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import type { TemplateChoice } from './AutomationDialog.tsx'
import styles from './Automations.module.css'
import { stageName } from './TaskViews.tsx'
import views from './views.module.css'

function act(request: () => Promise<unknown>, onError: (message: string) => void) {
  return request().catch((failure: unknown) => onError(readableError(failure)))
}

function Toggle({ automation, onError }: { automation: Automation; onError: (e: string) => void }) {
  const activity = usePendingAction(`automation:${automation.id}`)
  return (
    <ActionButton
      type="button"
      role="switch"
      aria-checked={automation.on}
      aria-label={`${automation.name} on`}
      className={styles.switch}
      disabled={activity.pending}
      pending={activity.pending && activity.label === 'toggle'}
      onClick={(event) => {
        event.stopPropagation()
        return activity.run(
          () => act(() => ted.setAutomationOn(automation.id, !automation.on), onError),
          'toggle',
        )
      }}
    >
      <span className={styles.knob} />
    </ActionButton>
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
          <ActionButton
            type="button"
            className={styles.taskLink}
            onClick={(event) => {
              event.stopPropagation()
              return onOpenTask(task.displayId)
            }}
          >
            {task.displayId}
          </ActionButton>
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
      <Button variant="primary" onClick={onNew}>
        New Automation…
      </Button>
    </header>
  )
}

function AutomationColumns() {
  return (
    <thead>
      <tr>
        <th className={styles.toggleCell}>
          <span className={styles.hidden}>On</span>
        </th>
        <th>Name and schedule</th>
        <th>Next firing</th>
        <th>Last result</th>
        <th>Now</th>
        <th>Provider · model</th>
      </tr>
    </thead>
  )
}

function HistoryColumns() {
  return (
    <thead>
      <tr>
        <th>Started</th>
        <th>Trigger</th>
        <th>Duration</th>
        <th>Result</th>
      </tr>
    </thead>
  )
}

function AutomationTableSkeleton() {
  return (
    <div role="status" aria-label="Loading Automations…">
      <table className={styles.table} aria-hidden>
        <AutomationColumns />
        <tbody>
          {['first', 'second', 'third'].map((row) => (
            <tr key={row}>
              <td className={styles.toggleCell}>
                <SkeletonBar width={28} height={16} />
              </td>
              <td>
                <div className={styles.loadingName}>
                  <SkeletonBar width="80%" height={14} />
                  <SkeletonBar width="60%" />
                </div>
              </td>
              <td>
                <SkeletonBar width="75%" />
              </td>
              <td>
                <SkeletonBar width="70%" />
              </td>
              <td>
                <SkeletonBar width="60%" />
              </td>
              <td>
                <SkeletonBar width="80%" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HistorySkeleton() {
  return (
    <div role="status" aria-label="Loading Automation…">
      <table className={`${styles.table} ${styles.history}`} aria-hidden>
        <HistoryColumns />
        <tbody>
          {['first', 'second', 'third'].map((row) => (
            <tr key={row}>
              <td>
                <SkeletonBar width="75%" />
              </td>
              <td>
                <SkeletonBar width="60%" />
              </td>
              <td>
                <SkeletonBar width="55%" />
              </td>
              <td>
                <SkeletonBar width="70%" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AutomationsPage({
  onEdit,
  factory,
  banners,
  onOpen,
  onNew,
  onOpenTask,
}: {
  onEdit?: (automation: Automation) => void
  factory: Factory | undefined
  banners: ReactNode
  onOpen: (automation: Automation) => void
  onNew: (template: TemplateChoice) => void
  onOpenTask: (ref: string) => void
}) {
  const resource = useAutomationsState(factory?.id)
  const automations = resource.value
  const menu = useAutomationMenu(onOpen, onEdit, undefined, automations)
  const templates = useAutomationTemplates()
  const now = useNow()
  const [error, setError] = useState<string>()
  return (
    <section className={views.pane} aria-label="Automations">
      {menu.menu}
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
            <AutomationTableSkeleton />
          )
        ) : automations.length === 0 ? (
          <AutomationsEmpty templates={templates} onNew={onNew} />
        ) : (
          <table className={styles.table}>
            <AutomationColumns />
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
                    data-nav-item
                    tabIndex={0}
                    {...contextMenu((at) => menu.open(at, automation))}
                    data-off={!automation.on}
                    onClick={() => onOpen(automation)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && event.target === event.currentTarget) {
                        event.preventDefault()
                        onOpen(automation)
                      }
                    }}
                  >
                    <td className={styles.toggleCell}>
                      <Toggle automation={automation} onError={setError} />
                    </td>
                    <td>
                      <ActionButton
                        type="button"
                        className={styles.name}
                        onClick={(event) => {
                          event.stopPropagation()
                          return onOpen(automation)
                        }}
                      >
                        {automation.name}
                      </ActionButton>
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
                                return act(() => ted.retryAutomationRun(runId), setError)
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
          <Button onClick={() => onNew('blank')}>Start blank</Button>
        </li>
      </ul>
    </div>
  )
}

function useAutomationMenu(
  onOpen: (automation: Automation) => void,
  onEdit: ((automation: Automation) => void) | undefined,
  onDeleted?: () => void,
  available?: readonly Automation[],
) {
  const actions = useActionMenu(
    JSON.stringify(
      available?.map((a) => [
        a.id,
        a.name,
        a.on,
        a.factoryKey,
        a.prompt,
        a.schedule,
        a.agent,
        a.model,
        a.effort,
      ]),
    ),
  )
  const [deleting, setDeleting] = useState<Automation>()
  return {
    isOpen: actions.isOpen,
    open: (at: MenuPosition, automation: Automation) => {
      const items: MenuAction[] = [
        { label: 'Open Automation', action: () => onOpen(automation) },
        { label: 'Edit…', disabled: !onEdit, action: () => onEdit?.(automation) },
        { label: 'Run now', action: () => ted.runAutomation(automation.id) },
        {
          label: automation.on ? 'Turn off' : 'Turn on',
          action: () => ted.setAutomationOn(automation.id, !automation.on),
        },
        {
          label: 'Duplicate',
          action: async () => onOpen(await ted.createAutomation(duplicateOf(automation))),
        },
        { label: 'Delete…', danger: true, action: () => setDeleting(automation) },
      ]
      actions.open(at, automation.name, items, `automation:${automation.id}`)
    },
    menu: (
      <>
        {actions.menu}
        {deleting && (
          <DeleteAutomationDialog
            automation={deleting}
            onClose={() => setDeleting(undefined)}
            onDeleted={() => {
              setDeleting(undefined)
              onDeleted?.()
            }}
          />
        )}
      </>
    ),
  }
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
                return ted.deleteAutomation(automation.id).then(onDeleted, (e: unknown) => {
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
    count('passed') > 0 ? `${count('passed')} passed` : undefined,
    count('check-failed') > 0 ? `${count('check-failed')} Check failures` : undefined,
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
  const activity = usePendingAction(`automation:${automationId}`)
  const detail = resource.value
  const now = useNow()
  const [error, setError] = useState<string>()
  const menu = useAutomationMenu(
    onOpenAutomation,
    onEdit,
    onBack,
    detail?.automation ? [detail.automation] : [],
  )
  const [promptOpen, setPromptOpen] = useState(false)
  const [output, setOutput] = useState<AutomationRun>()
  if (detail === undefined)
    return (
      <>
        <section className={views.pane} aria-label="Automation">
          <header className={styles.viewHeader}>
            <ActionButton type="button" className={styles.backLink} onClick={onBack}>
              ← Automations
            </ActionButton>
            {resource.error ? (
              <h1 className={styles.title}>Automation</h1>
            ) : (
              <>
                <div className={styles.titleRow}>
                  <SkeletonBar width={28} height={16} />
                  <h1 className={styles.title} aria-label="Automation">
                    <SkeletonBar width="min(220px, 25vw)" height={20} />
                  </h1>
                  <span className={views.headerSpacer} />
                  <SkeletonBar width={76} height={28} />
                  <SkeletonBar width={44} height={28} />
                  <SkeletonBar width={32} height={28} />
                </div>
                <p className={`${styles.line} ${styles.loadingLine}`}>
                  <SkeletonBar width="min(420px, 70%)" />
                </p>
              </>
            )}
          </header>
          <div className={views.body}>
            {resource.error ? (
              <LoadingError error={resource.error} retry={resource.retry} />
            ) : (
              <>
                <h2 className={styles.sectionTitle}>History</h2>
                <HistorySkeleton />
              </>
            )}
          </div>
        </section>
        {!resource.error && (
          <DetailsPane className={views.detailsPane} aria-label="Automation details">
            <div aria-hidden>
              {['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].map((row) => (
                <div className={styles.detail} key={row}>
                  <div className={styles.loadingName}>
                    <SkeletonBar width="40%" />
                    <SkeletonBar width="80%" />
                    <SkeletonBar width="60%" />
                  </div>
                </div>
              ))}
            </div>
          </DetailsPane>
        )}
      </>
    )
  if (detail === null) {
    return (
      <section className={views.pane} aria-label="Automation">
        <ActionButton type="button" className={views.back} onClick={onBack}>
          ← Automations
        </ActionButton>
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
    ...(automation.check
      ? ['Scheduled Check']
      : [agentLabels[automation.agent], automation.model, automation.effort]),
  ]
    .filter(Boolean)
    .join(' · ')
  const billing = settings?.billing[automation.agent]
  const [totals, totalsNote] = totalsLine(detail).split('\n')
  return (
    <>
      <section className={views.pane} aria-label="Automation">
        <header className={styles.viewHeader}>
          <ActionButton type="button" className={styles.backLink} onClick={onBack}>
            ← Automations
          </ActionButton>
          <div className={styles.titleRow} {...contextMenu((at) => menu.open(at, automation))}>
            <Toggle automation={automation} onError={setError} />
            <h1 className={styles.title} data-off={!automation.on}>
              {automation.name}
            </h1>
            <span className={views.headerSpacer} />
            <Button
              disabled={activity.pending}
              pending={activity.pending && activity.label === 'Run now'}
              onClick={() =>
                activity.run(() => act(() => ted.runAutomation(automation.id), setError), 'Run now')
              }
            >
              Run now
            </Button>
            <Button disabled={activity.pending} onClick={() => onEdit(automation)}>
              Edit…
            </Button>
            <Button
              aria-label="Automation actions"
              aria-expanded={menu.isOpen}
              aria-haspopup="menu"
              onClick={(event) => {
                event.stopPropagation()
                return menu.open(buttonPosition(event.currentTarget), automation)
              }}
            >
              ⋯
            </Button>
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
              <HistoryColumns />
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
                          <ActionButton
                            type="button"
                            className={styles.name}
                            onClick={(event) => {
                              event.stopPropagation()
                              return onOpenRun(runId)
                            }}
                          >
                            {firingDate(run.startedAt ?? run.at)}
                          </ActionButton>
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
                          {(run.result.kind === 'created' || run.result.kind === 'check-failed') &&
                            run.result.tasks.length > 0 && (
                              <>
                                {run.result.kind === 'check-failed' ? ' · created ' : ' '}
                                <TaskLinks tasks={run.result.tasks} onOpenTask={onOpenTask} />
                              </>
                            )}
                          {run.result.kind !== 'check-failed' &&
                            run.check &&
                            run.created &&
                            run.created.length > 0 && (
                              <>
                                {' · created '}
                                <TaskLinks tasks={run.created} onOpenTask={onOpenTask} />
                              </>
                            )}
                          {run.check?.updated && run.check.updated.length > 0 && (
                            <>
                              {' · updated '}
                              <TaskLinks tasks={run.check.updated} onOpenTask={onOpenTask} />
                            </>
                          )}
                          {run.check?.agent?.noted && (
                            <>
                              {' · noted '}
                              <TaskLinks tasks={run.check.agent.noted} onOpenTask={onOpenTask} />
                            </>
                          )}
                          {run.check?.agent?.started && (
                            <>
                              {' · started '}
                              <TaskLinks tasks={run.check.agent.started} onOpenTask={onOpenTask} />
                            </>
                          )}
                          {run.check && (
                            <Button
                              size="small"
                              className={styles.retry}
                              onClick={(event) => {
                                event.stopPropagation()
                                setOutput(run)
                              }}
                            >
                              Output
                            </Button>
                          )}
                          {canRetry === run.id && (
                            <Button
                              size="small"
                              className={styles.retry}
                              onClick={(event) => {
                                event.stopPropagation()
                                return act(() => ted.retryAutomationRun(run.id), setError)
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
        {menu.menu}
        {output && (
          <AutomationOutputDialog
            run={output}
            command={automation.check?.command}
            onClose={() => setOutput(undefined)}
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
        {automation.check ? (
          <Details title="Command">
            <pre className={styles.prompt} data-open>
              {automation.check.command}
            </pre>
            <p className={styles.detailNote}>
              Runs as a Check on the tip of the default branch, in TED’s sandbox · times out after{' '}
              {automation.check.timeout}
            </p>
            <p className={styles.detailNote}>
              {settings?.waitWhenBusy
                ? `Waits while the computer is busy, then runs anyway ${automation.check.runBy === undefined ? 'after 4 hours' : `at ${automation.check.runBy}`}`
                : 'Runs at once: “Wait to start new work when this computer is busy” is off'}
            </p>
          </Details>
        ) : null}
        {automation.check && (
          <Details title="Agent step">
            <p className={styles.detailText}>
              {automation.check.agentStep === 'never'
                ? 'Never · TED creates one Task per failing test file'
                : [
                    automation.check.agentStep === 'always'
                      ? 'After every run'
                      : 'When the Check fails',
                    agentLabels[automation.agent],
                    automation.model,
                    automation.effort,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </p>
            {automation.check.agentStep !== 'never' && (
              <p className={styles.detailNote}>
                {automation.check.startTasks
                  ? 'Starts the Tasks it creates'
                  : 'Leaves the Tasks it creates in Backlog'}
              </p>
            )}
          </Details>
        )}
        {automation.check && automation.check.agentStep !== 'never' && (
          <Details title="Prompt">
            <pre className={styles.prompt} data-open={promptOpen}>
              {automation.prompt.trim() === '' ? scheduledCheckPrompt : automation.prompt}
            </pre>
            <ActionButton
              type="button"
              className={styles.taskLink}
              onClick={() => setPromptOpen((o) => !o)}
            >
              {promptOpen ? 'Hide prompt' : 'Show prompt'}
            </ActionButton>
          </Details>
        )}
        {automation.check ? null : (
          <>
            <Details title="Provider">
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
              <ActionButton
                type="button"
                className={styles.taskLink}
                onClick={() => setPromptOpen((o) => !o)}
              >
                {promptOpen ? 'Hide prompt' : 'Show prompt'}
              </ActionButton>
            </Details>
          </>
        )}
        <Details title="Totals">
          <p className={styles.detailText}>{totals}</p>
          {totalsNote !== undefined && <p className={styles.detailNote}>{totalsNote}</p>}
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

function AutomationOutputDialog({
  run,
  command,
  onClose,
}: {
  run: AutomationRun
  command: string | undefined
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const [output, setOutput] = useState<{ text: string; log: string }>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    let current = true
    ted.automationRunOutput(run.id).then(
      (loaded) => {
        if (current) setOutput(loaded)
      },
      (failure: unknown) => {
        if (current) setError(readableError(failure))
      },
    )
    return () => {
      current = false
    }
  }, [run.id])
  return (
    <dialog
      ref={dialog}
      className={outputStyles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className={outputStyles.head}>
        <h2 id={headingId} className={outputStyles.heading}>
          Check output · {firingDate(run.startedAt ?? run.at)}
        </h2>
        <button type="button" className={outputStyles.close} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {command !== undefined && <code className={outputStyles.command}>{command}</code>}
      {run.check && run.check.failing.length > 0 && (
        <p className={outputStyles.log}>Failing: {run.check.failing.join(', ')}</p>
      )}
      {error !== undefined ? (
        <p className={outputStyles.error} role="alert">
          {error}
        </p>
      ) : (
        <pre
          className={`${outputStyles.output} ${output === undefined ? outputStyles.pending : ''}`}
        >
          {output === undefined ? (
            <Loading terminal label="Loading Check output…" />
          ) : output.text === '' ? (
            'No output.'
          ) : (
            output.text
          )}
        </pre>
      )}
      {output && <p className={outputStyles.log}>Full log: {output.log}</p>}
    </dialog>
  )
}

function runChip(run: RunSummary, waiting: boolean, simulatorWait = false): ReactNode {
  if (run.state === 'finished') return <StatusChip tone="neutral">Finished</StatusChip>
  if (simulatorWait && !waiting) {
    return (
      <StatusChip tone="waiting" glyph="waiting">
        Waiting for a simulator
      </StatusChip>
    )
  }
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
  const [selection, setSelection] = useState<QuestionSelection>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const answer = (input: { choice?: string; text?: string }) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    return ted.answerAutomationRequest(request.id, input).then(
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
  const hasChoices = (request.choices?.length ?? 0) > 0
  const selectedChoice = selection && 'choice' in selection ? selection.choice : undefined
  const other = selection && 'other' in selection
  const ready = hasChoices
    ? selectedChoice !== undefined || (other && text.trim() !== '')
    : text.trim() !== ''
  function sendAnswer() {
    if (!ready || busy) return
    return answer({
      ...(hasChoices && selectedChoice !== undefined && { choice: selectedChoice }),
      ...(text.trim() !== '' && { text }),
    })
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
      {hasChoices && (
        <QuestionChoices
          choices={request.choices ?? []}
          selection={selection}
          onSelect={setSelection}
          disabled={busy}
        />
      )}
      <textarea
        className={`${styles.answer} ${grow.text}`}
        aria-label="Your answer"
        placeholder={hasChoices && !other ? 'Add to this answer…' : 'Write your answer…'}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={sendOnEnter(sendAnswer, () => !!ready && !busy)}
      />
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.questionButtons}>
        <Button
          variant="primary"
          shortcut="↵"
          disabled={busy || !ready}
          pending={busy}
          onClick={sendAnswer}
        >
          Send
        </Button>
      </div>
    </section>
  )
}

function questionLine(request: AutomationRequest, finished: boolean): ChatExtra {
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
              ? finished
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
  const [shownApp, setShownApp] = useState<ShownApp>()
  const checkout = detail?.automation.checkout === true
  const apps = useRunApps(runId, checkout)
  const requests = detail?.requests.filter((r) => r.runId === runId) ?? []
  const open = requests.filter((r) => r.kind === 'question' && r.answer === undefined)
  const requestsShown = JSON.stringify(requests)
  const finished = chat?.run.state === 'finished'
  // biome-ignore lint/correctness/useExhaustiveDependencies: requests are compared by content, so a reload with the same ones keeps the chat rows
  const options = useMemo(
    () => ({
      bar: false,
      extra: requests.map((r) => questionLine(r, finished)),
      pinned:
        open.length > 0 && !finished ? (
          <div className={views.pinned}>
            {open.map((request) => (
              <QuestionCard key={request.id} request={request} />
            ))}
          </div>
        ) : undefined,
      placeholder: 'Message this Run…',
      help: 'Goes only to this Run, as the human’s message.',
    }),
    [requestsShown, finished],
  )
  if (detail === null) {
    return (
      <section className={views.pane} aria-label="Automation Run">
        <ActionButton type="button" className={views.back} onClick={onBack}>
          ← Automations
        </ActionButton>
        <p className={views.empty}>This Automation was deleted.</p>
      </section>
    )
  }
  if (!detail || !chat) {
    return (
      <section className={views.pane} aria-label="Automation Run">
        <header className={styles.viewHeader}>
          <ActionButton type="button" className={styles.backLink} onClick={onBack}>
            ← Automations
          </ActionButton>
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
  const run = chat.run
  const startedAt = row?.startedAt ?? run.startedAt
  const why = row ? trigger(row, history) : undefined
  const created = row?.created ?? []
  return (
    <>
      <section className={views.pane} aria-label="Automation Run">
        <header className={styles.viewHeader}>
          <ActionButton type="button" className={styles.backLink} onClick={onBack}>
            ← {automation.name}
          </ActionButton>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>
              {automation.name} · Run of {clockOf(startedAt)}
            </h1>
            {runChip(
              run,
              open.length > 0,
              apps.some((a) => a.state === 'waiting'),
            )}
            <span className={views.headerSpacer} />
            {run.state !== 'finished' && (
              <Button onClick={() => act(() => ted.stopRun(run.id), setError)}>Stop</Button>
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
        {shownApp ? (
          <RunAppLog
            runId={runId}
            apps={apps}
            shown={shownApp}
            onBack={() => setShownApp(undefined)}
          />
        ) : (
          <div className={styles.chat}>
            <ChatBody chat={chat} onStopTask={undefined} options={options} />
          </div>
        )}
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
                    <ActionButton
                      type="button"
                      className={styles.taskLink}
                      onClick={() => onOpenTask(link.displayId)}
                    >
                      {link.displayId}
                    </ActionButton>{' '}
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
        {checkout && (
          <Details title={`Apps · ${apps.filter((a) => a.state === 'running').length} running`}>
            {apps.length === 0 || run.state === 'finished' ? (
              <p className={styles.detailNote}>
                {run.state === 'finished'
                  ? 'TED stopped this Run’s Apps when it ended.'
                  : 'None started yet.'}
              </p>
            ) : (
              <RunAppRows runId={runId} apps={apps} shown={shownApp} onOpen={setShownApp} />
            )}
          </Details>
        )}
        {row?.screenshots && row.screenshots.length > 0 && (
          <Details title={`Screenshots · ${row.screenshots.length}`}>
            <CommentFiles files={row.screenshots} />
          </Details>
        )}
        {checkout && (
          <Details title="Checkout">
            <p className={styles.detailText}>A fresh copy of the default branch</p>
            <p className={styles.detailNote}>
              {run.state === 'finished'
                ? 'Removed when the Run ended.'
                : 'Removed when the Run ends.'}
            </p>
          </Details>
        )}
        <Details title="Run">
          <p className={styles.detailText}>{runMeta(run)}</p>
          {why && <p className={styles.detailNote}>{why.text}</p>}
        </Details>
        <Details title="Automation">
          <p className={styles.detailText}>
            <ActionButton type="button" className={styles.taskLink} onClick={onOpenAutomation}>
              {automation.name}
            </ActionButton>
          </p>
          <p className={styles.detailNote}>{scheduleDescription(automation)}</p>
        </Details>
      </DetailsPane>
    </>
  )
}
