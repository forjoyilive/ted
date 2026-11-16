import type {
  AgentKind,
  AnswerRequest,
  Coordinator,
  Effort,
  Factory,
  Plan,
  PlanDetail,
  PlanRequest,
  TaskLead,
} from '@ted/protocol'
import { efforts } from '@ted/protocol/task'
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { AgentAbout } from '../components/AgentAbout.tsx'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { Button } from '../components/Button.tsx'
import column from '../components/ChatColumn.module.css'
import { Help } from '../components/Help.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { ModelSelect } from '../components/ModelSelect.tsx'
import { ProposalAnswer, ProposalRows } from '../components/ProposalCard.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { RoundAnswers, RoundQuestions } from '../components/RoundCard.tsx'
import { type ChatExtra, RunChat, tokenCount } from '../components/RunChat.tsx'
import { agentNames, RunIcon } from '../components/RunIcon.tsx'
import type { ScrollReveal } from '../components/ScrollMemory.tsx'
import { Select } from '../components/Select.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import grow from '../components/TextGrow.module.css'
import { sendOnEnter } from '../composer-keys.ts'
import { usePlan, usePlanState, useRunChat } from '../data.ts'
import { InboxRequestsContext } from '../inbox-requests.ts'
import { useMessageDraft } from '../message-drafts.ts'
import {
  dotted,
  planEnded,
  planStartedLine,
  planStatusChip,
  requestHeading,
  requestState,
  when,
} from '../plans.ts'
import { ago, clockTime, useNow } from '../requests.ts'
import { useStages } from '../stages.tsx'
import { agentLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from './PlanChat.module.css'
import views from './views.module.css'

export function PlanChatView({
  factory,
  planId,
  revealRequest,
  from,
  switcher,
  onBack,
  backLabel,
  onOpenPlan,
  onPlanMore,
  onOpenTask,
  onDeleted,
}: {
  factory: Factory
  planId: string | undefined
  revealRequest?: ScrollReveal | undefined
  from?: string
  switcher?: ReactNode
  onBack?: (() => void) | undefined
  backLabel?: string
  onOpenPlan: (planId: string) => void
  onPlanMore: (planId: string) => void
  onOpenTask: (ref: string) => void
  onDeleted: () => void
}) {
  if (planId === undefined) {
    return (
      <NewPlanChat
        factory={factory}
        {...(from !== undefined && { from })}
        switcher={switcher}
        onBack={onBack}
        backLabel={backLabel}
        onStarted={onOpenPlan}
        onOpenPlan={onOpenPlan}
      />
    )
  }
  return (
    <PlanChat
      key={planId}
      planId={planId}
      revealRequest={revealRequest}
      onBack={onBack}
      {...(backLabel !== undefined && { backLabel })}
      onOpenTask={onOpenTask}
      onOpenPlan={onOpenPlan}
      onPlanMore={onPlanMore}
      onDeleted={onDeleted}
    />
  )
}

function FromPlan({
  plan,
  onOpenPlan,
}: {
  plan: Pick<Plan, 'fromPlan'>
  onOpenPlan: (planId: string) => void
}) {
  const from = plan.fromPlan
  if (!from) return null
  if (from.deleted) {
    return <p className={styles.paneText}>{`More from “${from.title}”, since deleted`}</p>
  }
  return (
    <p className={styles.paneText}>
      {'More from '}
      <ActionButton type="button" className={styles.link} onClick={() => onOpenPlan(from.id)}>
        {from.title}
      </ActionButton>
    </p>
  )
}

export function LeadSelects({
  lead,
  onChange,
}: {
  lead: TaskLead
  onChange: (lead: TaskLead) => void
}) {
  const set = (agent: AgentKind, model: string, effort: string) =>
    onChange({
      agent,
      ...(model !== '' && { model }),
      ...(effort !== '' && { effort: effort as Effort }),
    })
  return (
    <div className={styles.selects}>
      <Select
        aria-label="Provider"
        value={lead.agent}
        onChange={(event) => set(event.target.value as AgentKind, '', lead.effort ?? '')}
      >
        <AgentOptions current={lead.agent} />
      </Select>
      <ModelSelect
        aria-label="Model"
        agent={lead.agent}
        value={lead.model ?? ''}
        onChange={(model) => set(lead.agent, model, lead.effort ?? '')}
      />
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
      <Help>Provider, model and effort for this chat’s planner. They’re fixed once you send.</Help>
    </div>
  )
}

function leadLine(lead: TaskLead | undefined): string {
  return lead ? [agentNames[lead.agent], lead.model, lead.effort].filter(Boolean).join(' · ') : ''
}

function Back({ onBack, label }: { onBack: (() => void) | undefined; label?: string | undefined }) {
  if (!onBack || label === undefined) return null
  return (
    <ActionButton type="button" className={styles.back} onClick={onBack}>
      {label}
    </ActionButton>
  )
}

function NewPlanChat({
  factory,
  from,
  switcher,
  onBack,
  backLabel,
  onStarted,
  onOpenPlan,
}: {
  factory: Factory
  from?: string
  switcher?: ReactNode
  onBack?: (() => void) | undefined
  backLabel?: string | undefined
  onStarted: (planId: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const earlier = usePlan(from)?.plan
  const [lead, setLead] = useState<TaskLead>()
  const draft = useMessageDraft({ kind: 'new-plan', id: factory.id })
  const { text, setText } = draft
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const cloning = !factory.cloned

  useEffect(() => {
    let active = true
    ted.taskDefaults(factory.id).then(
      (defaults) => {
        if (active) setLead((current) => current ?? defaults.planner)
      },
      () => {
        if (active) setLead((current) => current ?? { agent: 'claude' })
      },
    )
    return () => {
      active = false
    }
  }, [factory.id])

  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    box.current?.focus()
  }, [])

  async function send() {
    if (text.trim() === '' || sending || cloning) return
    setSending(true)
    setError(undefined)
    try {
      const plan = await ted.startPlan({
        factory: factory.id,
        message: text,
        ...(from !== undefined && { from }),
        ...(lead && { agent: lead.agent }),
        ...(lead?.model !== undefined && { model: lead.model }),
        ...(lead?.effort !== undefined && { effort: lead.effort }),
      })
      draft.clear()
      onStarted(plan.id)
    } catch (failed) {
      setError(readableError(failed))
      setSending(false)
    }
  }

  return (
    <>
      <section className={views.pane} aria-label="New planning chat">
        <header className={styles.header}>
          <Back onBack={onBack} label={backLabel} />
          <div className={styles.titleRow}>
            <h1 className={`${styles.title} ${styles.placeholderTitle}`}>
              {switcher ? 'New chat' : 'New planning chat'}
            </h1>
            {switcher}
            <span className={styles.spacer} />
            {lead && <LeadSelects lead={lead} onChange={setLead} />}
          </div>
        </header>
        <div className={styles.intro}>
          <p>
            {`Describe the piece of work. The planner reads ${factory.name}’s repos, asks questions in rounds,`}
            <br />
            and ends by proposing Tasks, with which block which, for you to approve.
          </p>
          {earlier && (
            <p className={styles.notice}>
              {`Builds on “${earlier.title}”: the planner gets its rounds, answers, proposal and created Tasks.`}
            </p>
          )}
          {cloning && (
            <p className={styles.notice}>
              {`${factory.name} is still cloning. You can plan once it’s ready.`}
            </p>
          )}
        </div>
        <div className={`${styles.composer} ${column.composer}`}>
          <textarea
            className={`${styles.box} ${grow.text}`}
            aria-label="What do you want to plan?"
            placeholder="What do you want to plan?"
            ref={box}
            value={text}
            disabled={sending || cloning}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendOnEnter(() => send())}
          />
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.composerButtons}>
            <Button
              variant="primary"
              shortcut="↵"
              disabled={sending || cloning || text.trim() === ''}
              pending={sending}
              onClick={() => send()}
            >
              Send
            </Button>
          </div>
        </div>
      </section>
      <DetailsPane className={views.detailsPane} aria-label="Planning chat details">
        <Section title="Agent">
          <AgentAbout agent="Planner" provider={leadLine(lead)} />
        </Section>
        <Section title="Started from">
          {earlier ? (
            <FromPlan
              plan={{ fromPlan: { id: earlier.id, title: earlier.title } }}
              onOpenPlan={onOpenPlan}
            />
          ) : (
            <p className={styles.paneText}>Plan, by you</p>
          )}
        </Section>
        <Section title="Proposed Tasks">
          <p className={styles.paneMuted}>None yet.</p>
        </Section>
      </DetailsPane>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.paneSection} aria-label={title}>
      <h2 className={styles.paneHeading}>{title}</h2>
      {children}
    </section>
  )
}

export function TitleEditor({
  current,
  renameSignal = 0,
  onRename,
}: {
  current: string
  renameSignal?: number
  onRename: (title: string) => Promise<Coordinator | Plan>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const title = useRef(current)
  title.current = current

  useEffect(() => {
    if (renameSignal === 0) return
    setValue(title.current)
    setEditing(true)
  }, [renameSignal])

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  async function save() {
    const title = value.trim()
    if (title === '' || title === current) {
      setEditing(false)
      setValue(current)
      return
    }
    try {
      await onRename(title)
      setEditing(false)
      setError(undefined)
    } catch (failed) {
      setError(readableError(failed))
    }
  }

  if (!editing) {
    return (
      <h1 className={styles.title}>
        <ActionButton
          type="button"
          className={styles.titleButton}
          title="Rename"
          onClick={() => {
            setValue(current)
            setEditing(true)
          }}
        >
          {current}
        </ActionButton>
      </h1>
    )
  }
  return (
    <span className={styles.titleEdit}>
      <input
        ref={input}
        className={styles.titleInput}
        aria-label="Title"
        data-arrows
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => save()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') {
            setEditing(false)
            setValue(current)
          }
        }}
      />
      {error !== undefined && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

function MoreMenu({
  plan,
  onRename,
  onPlanMore,
  onDeleted,
}: {
  plan: Plan
  onRename: () => void
  onPlanMore: (planId: string) => void
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string>()

  async function remove() {
    try {
      await ted.deletePlan(plan.id)
      onDeleted()
    } catch (failed) {
      setError(readableError(failed))
    }
  }

  return (
    <span className={styles.more}>
      <Button aria-label="More" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </Button>
      {open && !confirming && (
        <div className={styles.menu} role="menu">
          <ActionButton
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false)
              return onRename()
            }}
          >
            Rename…
          </ActionButton>
          {planEnded(plan) && (
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false)
                onPlanMore(plan.id)
              }}
            >
              Plan more from here…
            </ActionButton>
          )}
          <ActionButton
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.danger}`}
            onClick={() => setConfirming(true)}
          >
            Delete…
          </ActionButton>
        </div>
      )}
      {open && confirming && (
        <div className={styles.menu} role="alertdialog" aria-label="Delete this planning chat?">
          <p className={styles.confirmText}>
            {planEnded(plan)
              ? 'Delete this planning chat and its conversation? Tasks it created stay.'
              : 'Stop the planner and delete this chat and its conversation? Tasks it created stay.'}
          </p>
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.confirmButtons}>
            <Button
              onClick={() => {
                setConfirming(false)
                setOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={() => remove()}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </span>
  )
}

function StartedLine({ plan, onOpenTask }: { plan: Plan; onOpenTask: (ref: string) => void }) {
  const from = plan.fromTask
  if (!from || planEnded(plan)) return <>{planStartedLine(plan)}</>
  return (
    <>
      {'Planning chat · started from '}
      {from.gone === 'deleted' ? (
        from.displayId
      ) : (
        <ActionButton type="button" className={styles.link} onClick={() => onOpenTask(from.id)}>
          {from.displayId}
        </ActionButton>
      )}
      {` ${when(plan.createdAt)}`}
    </>
  )
}

function PlanHeader({
  plan,
  onBack,
  backLabel,
  onPlanMore,
  onDeleted,
  onOpenTask,
}: {
  plan: Plan
  onBack?: (() => void) | undefined
  backLabel?: string
  onPlanMore: (planId: string) => void
  onDeleted: () => void
  onOpenTask: (ref: string) => void
}) {
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()
  const [renameSignal, setRenameSignal] = useState(0)
  const chip = planStatusChip(plan)
  const ended = planEnded(plan)

  async function stop() {
    setStopping(true)
    setError(undefined)
    try {
      await ted.stopPlan(plan.id)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setStopping(false)
    }
  }

  return (
    <header className={styles.header}>
      <Back onBack={onBack} {...(backLabel !== undefined && { label: backLabel })} />
      <div className={styles.titleRow}>
        <TitleEditor
          current={plan.title}
          renameSignal={renameSignal}
          onRename={(title) => ted.renamePlan(plan.id, title)}
        />
        <StatusChip tone={chip.tone} {...(chip.glyph && { glyph: chip.glyph })}>
          {chip.label}
        </StatusChip>
        <span className={styles.spacer} />
        <RunIcon
          agent={plan.agent}
          state={
            plan.status === 'working' || plan.status === 'waiting' || plan.status === 'paused'
              ? plan.status
              : plan.status === 'failed'
                ? 'failed'
                : 'idle'
          }
        />
        <span className={styles.leadText}>
          {[agentLabels[plan.agent], plan.model, plan.effort].filter(Boolean).join(' · ')}
        </span>
        {!ended && (
          <Button disabled={stopping} onClick={() => stop()}>
            Stop
          </Button>
        )}
        <MoreMenu
          plan={plan}
          onRename={() => setRenameSignal((n) => n + 1)}
          onPlanMore={onPlanMore}
          onDeleted={onDeleted}
        />
      </div>
      <p className={styles.startedLine}>
        <StartedLine plan={plan} onOpenTask={onOpenTask} />
        {plan.status === 'failed' && plan.error !== undefined && ` · ${plan.error}`}
      </p>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </header>
  )
}

function OneLiner({
  request,
  latest,
  onOpenTask,
}: {
  request: PlanRequest
  latest: boolean
  onOpenTask: (ref: string) => void
}) {
  const [open, setOpen] = useState(false)
  const { kind, detail } = requestHeading(request)
  const state = requestState(request, latest)
  const pending = request.answer === undefined
  const approved = request.answer?.kind === 'approved' ? request.answer : undefined
  if (approved && request.proposal) {
    return (
      <div className={`${styles.card} ${styles.approved}`}>
        <div className={styles.cardHead}>
          <span className={styles.approvedKind}>{kind}</span>
          <span>{dotted(detail, state)}</span>
        </div>
        {request.title !== undefined && <p className={styles.cardTitle}>{request.title}</p>}
        <ProposalRows
          proposal={request.proposal}
          skip={approved.created?.skipped ?? []}
          created={approved.created}
          disabled
          onOpenTask={onOpenTask}
        />
      </div>
    )
  }
  const showLabel = request.kind === 'round' ? 'Show answers' : 'Show'
  const canShow =
    !pending &&
    ((request.kind === 'round' && request.answer?.kind === 'answered') ||
      request.kind === 'proposal')
  return (
    <div className={pending ? `${styles.line} ${styles.pending}` : styles.line}>
      <div className={styles.lineHead}>
        <span className={styles.lineKind}>{kind}</span>
        <span className={styles.lineText}>{` · ${dotted(detail, state)}`}</span>
        <span className={styles.spacer} />
        {canShow && (
          <ActionButton type="button" className={styles.link} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : showLabel}
          </ActionButton>
        )}
      </div>
      {open && request.kind === 'round' && request.answer?.kind === 'answered' && (
        <RoundAnswers request={request} answers={request.answer.answers ?? []} />
      )}
      {open && request.kind === 'proposal' && request.proposal && (
        <ProposalRows proposal={request.proposal} skip={[]} disabled />
      )}
      {open && request.answer?.kind === 'changes-requested' && (
        <p className={styles.changes}>{`You asked for changes: ${request.answer.text}`}</p>
      )}
    </div>
  )
}

function EventLine({ text, at, good }: { text: string; at: string; good?: boolean }) {
  return (
    <p className={styles.event}>
      <span className={good ? `${styles.dot} ${styles.goodDot}` : styles.dot} aria-hidden />
      <span className={styles.eventText}>{text}</span>
      <span className={styles.eventTime}>{clockTime(at)}</span>
    </p>
  )
}

function PlanRequestCard({ request }: { request: PlanRequest }) {
  const now = useNow()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const { kind, detail } = requestHeading(request)

  async function send(answer: AnswerRequest) {
    setSending(true)
    setError(undefined)
    try {
      await ted.answerPlanRequest(request.id, answer)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <section
      className={styles.request}
      aria-label={`${kind} from the planner`}
      data-request={request.id}
    >
      <div className={styles.cardHead}>
        <span className={styles.pendingKind}>{kind}</span>
        <span>{`· ${dotted(detail, 'from the planner', ago(request.createdAt, now))}`}</span>
      </div>
      {request.title !== undefined && request.title !== '' && (
        <p className={styles.cardTitle}>{request.title}</p>
      )}
      {request.body !== '' && <Markdown className={styles.summary} text={request.body} />}
      {request.round && (
        <>
          <RoundQuestions
            round={request.round}
            readOnly={false}
            sending={sending}
            talking={false}
            onTalk={undefined}
            box={{ kind: 'plan-request', id: request.id }}
            onSend={(answer) => send(answer)}
          />
          <p className={styles.talkHint}>Typing below talks it through with the planner.</p>
        </>
      )}
      {request.proposal && (
        <ProposalAnswer
          proposal={request.proposal}
          readOnly={false}
          sending={sending}
          box={{ kind: 'plan-request', id: request.id }}
          onSend={(answer) => send(answer)}
        />
      )}
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function extraItems(detail: PlanDetail, onOpenTask: (ref: string) => void): ChatExtra[] {
  const { plan, requests } = detail
  const latestProposal = requests.findLast((r) => r.kind === 'proposal')
  const extra: ChatExtra[] = requests.map((request) =>
    request.kind === 'note'
      ? {
          id: request.id,
          at: request.createdAt,
          node: (
            <EventLine
              text={`Ted ${request.body.charAt(0).toLowerCase()}${request.body.slice(1)}`}
              at={request.createdAt}
              good
            />
          ),
        }
      : {
          id: request.id,
          at: request.createdAt,
          node:
            request.answer === undefined ? (
              <PlanRequestCard request={request} />
            ) : (
              <OneLiner
                request={request}
                latest={request.id === latestProposal?.id}
                onOpenTask={onOpenTask}
              />
            ),
        },
  )
  if (plan.finishedAt !== undefined && planEnded(plan)) {
    const text =
      plan.status === 'finished'
        ? 'Planning Run finished'
        : plan.status === 'failed'
          ? `Planning Run failed${plan.error !== undefined ? `: ${plan.error}` : ''}`
          : 'Planning Run stopped'
    extra.push({
      id: 'ended',
      at: plan.finishedAt,
      node: <EventLine text={text} at={plan.finishedAt} />,
    })
  }
  return extra
}

function EndedBar({ plan, onPlanMore }: { plan: Plan; onPlanMore: (planId: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (failed) {
      setError(readableError(failed))
      setBusy(false)
    }
  }
  const failed = plan.status === 'failed'
  const open = failed || plan.status === 'stopped'
  const line = failed
    ? plan.canResume
      ? 'This planning chat failed. Retry resumes the planner where it stopped.'
      : 'This planning chat failed before the planner started a session, so it can’t resume. Plan more from here starts a new chat from it.'
    : plan.status === 'stopped'
      ? plan.canResume
        ? 'This planning chat stopped. Resume carries on where it left off.'
        : 'The planner stopped before it started a session, so this chat can’t resume. Plan more from here starts a new chat from it.'
      : 'This planning chat is finished. It stays as history.'
  return (
    <div className={`${styles.endedBar} ${styles.endedRow}`}>
      <span className={styles.spacer}>{line}</span>
      {error !== undefined && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
      {open && (
        <Button disabled={busy} onClick={() => act(() => ted.markPlanFinished(plan.id))}>
          Mark finished
        </Button>
      )}
      {plan.canResume ? (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => act(() => ted.resumePlan(plan.id))}
        >
          {failed ? 'Retry' : 'Resume'}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => onPlanMore(plan.id)}>
          Plan more from here…
        </Button>
      )}
    </div>
  )
}

function PlanChat({
  planId,
  revealRequest,
  onBack,
  backLabel,
  onOpenTask,
  onOpenPlan,
  onPlanMore,
  onDeleted,
}: {
  planId: string
  revealRequest?: ScrollReveal | undefined
  onBack?: (() => void) | undefined
  backLabel?: string
  onOpenTask: (ref: string) => void
  onOpenPlan: (planId: string) => void
  onPlanMore: (planId: string) => void
  onDeleted: () => void
}) {
  const inbox = useContext(InboxRequestsContext)
  const resource = usePlanState(planId)
  const detail = resource.value
  if (!detail) {
    return (
      <section className={views.pane} aria-label="Planning chat">
        <div className={views.empty}>
          {resource.error ? (
            <LoadingError error={resource.error} retry={resource.retry} />
          ) : (
            <Skeleton shape="history" label="Loading the planning chat…" />
          )}
        </div>
      </section>
    )
  }
  const { plan } = detail
  const requests = detail.requests.filter((request) => !inbox?.resolved.has(request.id))
  const open = requests.filter((request) => request.kind !== 'note' && request.answer === undefined)
  const ended = planEnded(plan)
  return (
    <>
      <section className={views.pane} aria-label="Planning chat">
        <PlanHeader
          plan={plan}
          {...(backLabel !== undefined && { backLabel })}
          onBack={onBack}
          onPlanMore={onPlanMore}
          onDeleted={onDeleted}
          onOpenTask={onOpenTask}
        />
        {plan.runId !== undefined ? (
          <RunChat
            runId={plan.runId}
            bar={false}
            extra={extraItems({ ...detail, requests }, onOpenTask)}
            requests={open.map((request) => ({
              id: request.id,
              label: requestHeading(request).kind,
              title: request.title ?? request.body,
            }))}
            revealRequest={revealRequest}
            onJumpRequest={(id) => inbox?.select(id)}
            placeholder="Message the planner…"
            help="Goes to the planner. While a round is open, this talks it through."
            {...(ended &&
              (plan.canResume
                ? {
                    pinned: <EndedBar plan={plan} onPlanMore={onPlanMore} />,
                    live: true,
                    working: false,
                    interrupt: false,
                    help: 'Sending resumes the planner and gives it your message.',
                    send: (text: string) => ted.resumePlan(plan.id, { message: text }),
                  }
                : { readOnly: <EndedBar plan={plan} onPlanMore={onPlanMore} /> }))}
          />
        ) : (
          <>
            <QueuedChat plan={plan} />
            {ended && <EndedBar plan={plan} onPlanMore={onPlanMore} />}
          </>
        )}
      </section>
      <PlanPane detail={{ ...detail, requests }} onOpenTask={onOpenTask} onOpenPlan={onOpenPlan} />
    </>
  )
}

function QueuedChat({ plan }: { plan: Plan }) {
  return (
    <div className={styles.queued}>
      <div className={styles.queuedBody}>
        <div className={styles.bubble}>
          <span className={styles.bubbleHead}>{`You · ${clockTime(plan.createdAt)}`}</span>
          <p className={styles.bubbleText}>{plan.message}</p>
        </div>
        <p className={styles.waitNote}>
          {plan.status === 'queued'
            ? (plan.paused ?? 'Your message is kept. The planner is starting.')
            : plan.status === 'paused'
              ? `The planner is paused: ${plan.paused ?? 'usage limit'}.`
              : 'The planner didn’t start.'}
        </p>
      </div>
    </div>
  )
}

function PlanPane({
  detail,
  onOpenTask,
  onOpenPlan,
}: {
  detail: PlanDetail
  onOpenTask: (ref: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const { plan, requests, tasks } = detail
  const proposal = requests.findLast((r) => r.kind === 'proposal')
  const stages = useStages()
  return (
    <DetailsPane className={views.detailsPane} aria-label="Planning chat details">
      <Section title="Agent">
        <AgentAbout agent="Planner" provider={leadLine(plan)} />
      </Section>
      <Section title="Started from">
        {plan.fromPlan ? (
          <FromPlan plan={plan} onOpenPlan={onOpenPlan} />
        ) : (
          <StartedFrom plan={plan} onOpenTask={onOpenTask} />
        )}
      </Section>
      {tasks.length > 0 ? (
        <Section title={`Created Tasks · ${tasks.length}`}>
          <ul className={styles.paneList}>
            {tasks.map((task) => (
              <li key={task.id}>
                <ActionButton
                  type="button"
                  className={styles.paneTask}
                  onClick={() => onOpenTask(task.id)}
                >
                  <span className={styles.paneId}>{task.displayId}</span>
                  {task.title}
                </ActionButton>
                <span className={styles.paneMuted}>
                  {[
                    stages.name(task.stage, plan.factoryId),
                    ...(task.blockedBy.length > 0
                      ? [`Blocked by ${task.blockedBy.join(', ')}`]
                      : []),
                  ].join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <Section title="Proposed Tasks">
          {proposal?.proposal ? (
            <ol className={styles.paneList}>
              {proposal.proposal.rows.map((row, i) => (
                <li key={`${row.title}-${row.scope}`} className={styles.paneText}>
                  {`${i + 1}. ${row.title}`}
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.paneMuted}>
              {planEnded(plan) ? 'None.' : 'None yet. The planner proposes Tasks after the rounds.'}
            </p>
          )}
        </Section>
      )}
      {plan.runId !== undefined && <RunsSection plan={plan} runId={plan.runId} />}
    </DetailsPane>
  )
}

function StartedFrom({ plan, onOpenTask }: { plan: Plan; onOpenTask: (ref: string) => void }) {
  const stages = useStages()
  const from = plan.fromTask
  if (!from) return <p className={styles.paneText}>Plan, by you</p>
  const state =
    from.gone === 'deleted'
      ? ['Deleted']
      : from.gone === 'archived'
        ? ['Archived']
        : [
            ...(from.stage !== undefined ? [stages.name(from.stage, plan.factoryId)] : []),
            ...(from.status !== undefined
              ? [statusLabel(from.status)]
              : from.activity !== undefined
                ? [from.activity]
                : []),
          ]
  return (
    <div className={styles.paneFrom}>
      {from.gone === 'deleted' ? (
        <span className={styles.paneText}>
          <span className={styles.paneId}>{from.displayId}</span>
          {from.title}
        </span>
      ) : (
        <ActionButton type="button" className={styles.paneTask} onClick={() => onOpenTask(from.id)}>
          <span className={styles.paneId}>{from.displayId}</span>
          {from.title}
        </ActionButton>
      )}
      {state.length > 0 && <span className={styles.paneMuted}>{state.join(' · ')}</span>}
    </div>
  )
}

function RunsSection({ plan, runId }: { plan: Plan; runId: string }) {
  const chat = useRunChat(runId)
  const run = chat?.run
  return (
    <>
      <Section title="Runs">
        <div className={styles.paneRun}>
          <RunIcon
            agent={plan.agent}
            state={
              run?.state === 'working' || run?.state === 'waiting'
                ? run.state
                : plan.status === 'failed'
                  ? 'failed'
                  : 'idle'
            }
          />
          <span className={styles.paneRunText}>
            <span className={styles.paneText}>Planner</span>
            <span className={styles.paneMuted}>
              {[
                agentLabels[plan.agent],
                run?.model ?? plan.model,
                run?.effort ?? plan.effort,
                run?.state,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </div>
      </Section>
      {run?.tokens !== undefined && (
        <Section title="Tokens">
          <p className={styles.paneText}>
            {[run.credential, tokenCount(run.tokens)].filter(Boolean).join(' · ')}
          </p>
        </Section>
      )}
    </>
  )
}
