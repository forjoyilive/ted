import type {
  AgentKind,
  AgentSummary,
  AnswerRequest,
  ChatRequest,
  Effort,
  Factory,
  Plan,
  PlanDetail,
  PlanRequest,
  RunSummary,
  TaskLead,
} from '@ted/protocol'
import { efforts } from '@ted/protocol/task'
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { type ChatState, planChatState } from '../agent-chats.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { builtInPlanner } from '../components/AgentAbout.tsx'
import {
  AgentChat,
  AgentChatDetails,
  type ChatControls,
  DetailText,
  ReadOnlyNote,
} from '../components/AgentChat.tsx'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { Button } from '../components/Button.tsx'
import column from '../components/ChatColumn.module.css'
import { Help } from '../components/Help.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { ModelSelect } from '../components/ModelSelect.tsx'
import { ProposalAnswer, ProposalRows } from '../components/ProposalCard.tsx'
import { QuestionChoices, type QuestionSelection } from '../components/QuestionChoices.tsx'
import { RoundAnswers, RoundQuestions } from '../components/RoundCard.tsx'
import { type ChatExtra, RunChat, runMeta, tokenAmount } from '../components/RunChat.tsx'
import { agentNames } from '../components/RunIcon.tsx'
import type { ScrollReveal } from '../components/ScrollMemory.tsx'
import { Select } from '../components/Select.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import grow from '../components/TextGrow.module.css'
import { sendOnEnter } from '../composer-keys.ts'
import { usePlan, usePlanState, useRunChatState } from '../data.ts'
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
import { AgentDraftCard } from './AgentDraftCard.tsx'
import { OutsideCommandCard } from './OutsideCommandCard.tsx'
import styles from './PlanChat.module.css'
import views from './views.module.css'

export function PlanChatView({
  factory,
  planId,
  revealRequest,
  from,
  switcher,
  agent,
  controls,
  onOpenPlan,
  onOpenTask,
}: {
  factory: Factory
  planId: string | undefined
  revealRequest?: ScrollReveal | undefined
  from?: string
  switcher?: ReactNode
  agent?: AgentSummary | undefined
  controls: (state: ChatState) => ChatControls
  onOpenPlan: (planId: string) => void
  onOpenTask: (ref: string) => void
}) {
  if (planId === undefined) {
    return (
      <NewPlanChat
        factory={factory}
        {...(from !== undefined && { from })}
        switcher={switcher}
        agent={agent ?? builtInPlanner}
        onStarted={onOpenPlan}
        onOpenPlan={onOpenPlan}
      />
    )
  }
  return (
    <PlanChat
      key={planId}
      planId={planId}
      factoryName={factory.name}
      revealRequest={revealRequest}
      controls={controls}
      onOpenTask={onOpenTask}
      onOpenPlan={onOpenPlan}
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

function NewPlanChat({
  factory,
  from,
  switcher,
  agent,
  onStarted,
  onOpenPlan,
}: {
  factory: Factory
  from?: string
  switcher?: ReactNode
  agent: AgentSummary
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
  const agentKind = agent.agent
  const agentModel = agent.model

  useEffect(() => {
    if (agentKind !== undefined) {
      setLead({ agent: agentKind, ...(agentModel !== undefined && { model: agentModel }) })
      return
    }
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
  }, [factory.id, agentKind, agentModel])

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
      <AgentChatDetails
        label="Planning chat details"
        agent={agent}
        factoryId={factory.id}
        provider={leadLine(lead)}
        startedFrom={
          earlier ? (
            <FromPlan
              plan={{ fromPlan: { id: earlier.id, title: earlier.title } }}
              onOpenPlan={onOpenPlan}
            />
          ) : (
            <DetailText>Plan, by you</DetailText>
          )
        }
        tasks={{ title: 'Proposed Tasks', body: <DetailText muted>None yet.</DetailText> }}
      />
    </>
  )
}

function OneLiner({
  request,
  latest,
  onOpenTask,
}: {
  request: PlanRequest | ChatRequest
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
  const showLabel =
    request.kind === 'proposal' || request.kind === 'agent' ? 'Show' : 'Show answers'
  const answered = request.answer?.kind === 'answered' ? request.answer : undefined
  const saved = request.kind === 'agent' ? approved?.text : undefined
  const canShow =
    !pending &&
    (((request.kind === 'round' || request.kind === 'question') && answered !== undefined) ||
      request.kind === 'proposal' ||
      saved !== undefined)
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
      {open && request.kind === 'round' && answered && (
        <RoundAnswers request={request} answers={answered.answers ?? []} />
      )}
      {open && request.kind === 'question' && answered && (
        <div className={styles.changes}>
          <Markdown text={request.body} />
          <p>
            {[
              ...(answered.choices ?? (answered.choice !== undefined ? [answered.choice] : [])),
              ...(answered.text !== undefined ? [answered.text] : []),
            ].join(' · ')}
          </p>
        </div>
      )}
      {open && saved !== undefined && (
        <div className={styles.changes}>
          {request.title !== undefined && <p>{request.title}</p>}
          <Markdown text={saved} />
        </div>
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

function ChatRequestCard({
  chatId,
  request,
  agentName,
}: {
  chatId: string
  request: ChatRequest
  agentName: string
}) {
  const now = useNow()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const { kind, detail } = requestHeading(request)
  const box = { kind: 'coordinator-request' as const, id: request.id }

  async function send(answer: AnswerRequest) {
    setSending(true)
    setError(undefined)
    try {
      await ted.answerChatRequest(chatId, request.id, answer)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <section
      className={styles.request}
      aria-label={`${kind} from ${agentName}`}
      data-request={request.id}
    >
      <div className={styles.cardHead}>
        <span className={styles.pendingKind}>{kind}</span>
        <span>{`· ${dotted(detail, `from ${agentName}`, ago(request.createdAt, now))}`}</span>
      </div>
      {request.title !== undefined && request.title !== '' && (
        <p className={styles.cardTitle}>{request.title}</p>
      )}
      {request.body !== '' && <Markdown className={styles.summary} text={request.body} />}
      {request.kind === 'question' && (
        <QuestionAnswer request={request} sending={sending} box={box} onSend={send} />
      )}
      {request.round && (
        <RoundQuestions
          round={request.round}
          readOnly={false}
          sending={sending}
          talking={false}
          onTalk={undefined}
          box={box}
          onSend={(answer) => send(answer)}
        />
      )}
      {request.proposal && (
        <ProposalAnswer
          proposal={request.proposal}
          readOnly={false}
          sending={sending}
          box={box}
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

function QuestionAnswer({
  request,
  sending,
  box,
  onSend,
}: {
  request: ChatRequest
  sending: boolean
  box: { kind: 'coordinator-request'; id: string }
  onSend: (answer: AnswerRequest) => void
}) {
  const { text, setText } = useMessageDraft(box)
  const [selection, setSelection] = useState<QuestionSelection>()
  const choices = request.choices ?? []
  const multiple = request.multiple === true
  const picks =
    selection === undefined
      ? []
      : 'picks' in selection
        ? selection.picks
        : 'choice' in selection
          ? [selection.choice]
          : []
  const written = text.trim()
  const ready = picks.length > 0 || written !== ''
  function answer() {
    if (!ready || sending) return
    onSend({
      action: 'answer',
      ...(multiple
        ? picks.length > 0 && { choices: picks }
        : picks[0] !== undefined && { choice: picks[0] }),
      ...(written !== '' && { text: written }),
    })
  }
  return (
    <>
      {choices.length > 0 && (
        <QuestionChoices
          choices={choices}
          selection={selection}
          onSelect={setSelection}
          multiple={multiple}
          disabled={sending}
        />
      )}
      <textarea
        className={`${styles.box} ${grow.text}`}
        aria-label="Your answer"
        placeholder={choices.length > 0 ? 'Add to this answer…' : 'Write your answer…'}
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={sendOnEnter(answer, () => ready && !sending)}
      />
      <div className={styles.composerButtons}>
        <Button
          variant="primary"
          shortcut="↵"
          disabled={sending || !ready}
          pending={sending}
          onClick={answer}
        >
          Send
        </Button>
      </div>
    </>
  )
}

export function chatRequestItems(
  chatId: string,
  requests: readonly ChatRequest[],
  agentName: string,
  onOpenTask: (ref: string) => void,
  answerable = true,
): ChatExtra[] {
  const latestProposal = requests.findLast((r) => r.kind === 'proposal')
  return requests.map((request) => ({
    id: request.id,
    at: request.createdAt,
    node:
      request.answer === undefined && answerable ? (
        request.kind === 'agent' ? (
          <AgentDraftCard chatId={chatId} request={request} agentName={agentName} />
        ) : request.kind === 'outside-command' ? (
          <OutsideCommandCard chatId={chatId} request={request} agentName={agentName} />
        ) : (
          <ChatRequestCard chatId={chatId} request={request} agentName={agentName} />
        )
      ) : (
        <OneLiner
          request={request}
          latest={request.id === latestProposal?.id}
          onOpenTask={onOpenTask}
        />
      ),
  }))
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
              text={`TED ${request.body.charAt(0).toLowerCase()}${request.body.slice(1)}`}
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

function PlanChat({
  planId,
  factoryName,
  revealRequest,
  controls,
  onOpenTask,
  onOpenPlan,
}: {
  planId: string
  factoryName: string
  revealRequest?: ScrollReveal | undefined
  controls: (state: ChatState) => ChatControls
  onOpenTask: (ref: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const inbox = useContext(InboxRequestsContext)
  const resource = usePlanState(planId)
  const detail = resource.value
  const run = useRunChatState(detail?.plan.runId).value?.run
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
  const state = planChatState(plan)
  const readOnly = (
    <ReadOnlyNote>
      {state.archived
        ? 'Read only. Unarchive this chat to send a message.'
        : 'Read only. Plan more from here to carry on.'}
    </ReadOnlyNote>
  )
  return (
    <AgentChat
      label="Planning chat"
      title={plan.title}
      onRename={(title) => ted.renamePlan(plan.id, title)}
      chip={state.archived ? { tone: 'neutral', label: 'Archived' } : planStatusChip(plan)}
      meta={
        <>
          {`${factoryName} · `}
          <StartedLine plan={plan} onOpenTask={onOpenTask} />
          {run && ` · ${runMeta(run)}`}
        </>
      }
      alert={plan.status === 'failed' ? plan.error : undefined}
      banner={endedLine(plan)}
      controls={controls(state)}
      details={
        <PlanPane
          detail={{ ...detail, requests }}
          run={run}
          onOpenTask={onOpenTask}
          onOpenPlan={onOpenPlan}
        />
      }
    >
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
          {...(state.archived
            ? { readOnly }
            : ended &&
              (plan.canResume
                ? {
                    live: true,
                    working: false,
                    interrupt: false,
                    help: 'Sending resumes the planner and gives it your message.',
                    send: (text: string) => ted.resumePlan(plan.id, { message: text }),
                  }
                : { readOnly }))}
        />
      ) : (
        <QueuedChat plan={plan} />
      )}
    </AgentChat>
  )
}

function endedLine(plan: Plan): string | undefined {
  if (plan.archivedAt !== undefined)
    return 'This chat is archived. Unarchive it to write to it again.'
  if (plan.status === 'failed')
    return 'This planning chat failed. Retry resumes the planner where it stopped.'
  if (plan.status === 'stopped')
    return 'This planning chat stopped. Resume carries on where it left off.'
  if (plan.status === 'finished')
    return 'This planning chat finished. Write to it to carry on, or archive it.'
  return undefined
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
  run,
  onOpenTask,
  onOpenPlan,
}: {
  detail: PlanDetail
  run: RunSummary | undefined
  onOpenTask: (ref: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const { plan, requests, tasks } = detail
  const proposal = requests.findLast((r) => r.kind === 'proposal')
  const stages = useStages()
  return (
    <AgentChatDetails
      label="Planning chat details"
      agent={plan.chatAgent}
      removed={plan.chatAgent.removed}
      factoryId={plan.factoryId}
      provider={leadLine(plan)}
      startedFrom={
        plan.fromPlan ? (
          <FromPlan plan={plan} onOpenPlan={onOpenPlan} />
        ) : (
          <StartedFrom plan={plan} onOpenTask={onOpenTask} />
        )
      }
      tasks={
        tasks.length > 0
          ? {
              title: `Created Tasks · ${tasks.length}`,
              body: (
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
              ),
            }
          : {
              title: 'Proposed Tasks',
              body: proposal?.proposal ? (
                <ol className={styles.paneList}>
                  {proposal.proposal.rows.map((row, i) => (
                    <li key={`${row.title}-${row.scope}`} className={styles.paneText}>
                      {`${i + 1}. ${row.title}`}
                    </li>
                  ))}
                </ol>
              ) : (
                <DetailText muted>
                  {planEnded(plan)
                    ? 'None.'
                    : 'None yet. The planner proposes Tasks after the rounds.'}
                </DetailText>
              ),
            }
      }
      run={
        plan.runId === undefined
          ? undefined
          : {
              agent: plan.agent,
              state:
                run?.state === 'working' || run?.state === 'waiting'
                  ? run.state
                  : plan.status === 'failed'
                    ? 'failed'
                    : 'idle',
              name: 'Planner',
              line: [
                agentLabels[plan.agent],
                run?.model ?? plan.model,
                run?.effort ?? plan.effort,
                run?.state,
              ]
                .filter(Boolean)
                .join(' · '),
            }
      }
      tokens={
        run?.tokens === undefined
          ? undefined
          : [run.credential, tokenAmount(run.tokens)].filter(Boolean).join(' · ')
      }
    />
  )
}

function StartedLine({ plan, onOpenTask }: { plan: Plan; onOpenTask: (ref: string) => void }) {
  const from = plan.fromTask
  if (!from || planEnded(plan)) return <>{planStartedLine(plan)}</>
  return (
    <>
      {'Started from '}
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
