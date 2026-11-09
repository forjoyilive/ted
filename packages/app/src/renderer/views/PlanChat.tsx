import type {
  AgentKind,
  AnswerRequest,
  Effort,
  Factory,
  Plan,
  PlanDetail,
  PlanRequest,
  TaskLead,
} from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { efforts } from '@ted/protocol/task'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { ProposalAnswer, ProposalRows } from '../components/ProposalCard.tsx'
import { RoundAnswers, RoundQuestions } from '../components/RoundCard.tsx'
import { type ChatExtra, RunChat, tokenCount } from '../components/RunChat.tsx'
import { RunIcon } from '../components/RunIcon.tsx'
import { Select } from '../components/Select.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { usePlan, useRunChat } from '../data.ts'
import {
  planEnded,
  planStartedLine,
  planStatusChip,
  requestHeading,
  requestState,
  timeOf,
} from '../plans.ts'
import { ago, useNow } from '../requests.ts'
import { agentLabels, modelChoices } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from './PlanChat.module.css'
import views from './views.module.css'

export function PlanChatView({
  factory,
  planId,
  onBack,
  onOpenPlan,
  onOpenTask,
  onDeleted,
}: {
  factory: Factory
  planId: string | undefined
  onBack: () => void
  onOpenPlan: (planId: string) => void
  onOpenTask: (ref: string) => void
  onDeleted: () => void
}) {
  if (planId === undefined) {
    return <NewPlanChat factory={factory} onBack={onBack} onStarted={onOpenPlan} />
  }
  return (
    <PlanChat
      key={planId}
      planId={planId}
      onBack={onBack}
      onOpenTask={onOpenTask}
      onDeleted={onDeleted}
    />
  )
}

function LeadSelects({ lead, onChange }: { lead: TaskLead; onChange: (lead: TaskLead) => void }) {
  const models = [...new Set([...modelChoices[lead.agent], ...(lead.model ? [lead.model] : [])])]
  const set = (agent: AgentKind, model: string, effort: string) =>
    onChange({
      agent,
      ...(model !== '' && { model }),
      ...(effort !== '' && { effort: effort as Effort }),
    })
  return (
    <div className={styles.selects}>
      <Select
        aria-label="Agent"
        value={lead.agent}
        onChange={(event) => set(event.target.value as AgentKind, '', lead.effort ?? '')}
      >
        {agentKinds.map((agent) => (
          <option key={agent} value={agent}>
            {agentLabels[agent]}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Model"
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
      <Help>Agent, model and effort for this chat’s planner. They’re fixed once you send.</Help>
    </div>
  )
}

function Back({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className={styles.back} onClick={onBack}>
      ← Plans
    </button>
  )
}

function NewPlanChat({
  factory,
  onBack,
  onStarted,
}: {
  factory: Factory
  onBack: () => void
  onStarted: (planId: string) => void
}) {
  const [lead, setLead] = useState<TaskLead>()
  const [text, setText] = useState('')
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
        ...(lead && { agent: lead.agent }),
        ...(lead?.model !== undefined && { model: lead.model }),
        ...(lead?.effort !== undefined && { effort: lead.effort }),
      })
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
          <Back onBack={onBack} />
          <div className={styles.titleRow}>
            <h1 className={`${styles.title} ${styles.placeholderTitle}`}>New planning chat</h1>
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
          {cloning && (
            <p className={styles.notice}>
              {`${factory.name} is still cloning. You can plan once it’s ready.`}
            </p>
          )}
        </div>
        <div className={styles.composer}>
          <textarea
            className={styles.box}
            aria-label="What do you want to plan?"
            placeholder="What do you want to plan?"
            ref={box}
            value={text}
            disabled={sending || cloning}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              void send()
            }}
          />
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.composerButtons}>
            <Button
              variant="primary"
              size="small"
              shortcut="↵"
              disabled={sending || cloning || text.trim() === ''}
              onClick={() => void send()}
            >
              Send
            </Button>
          </div>
        </div>
      </section>
      <aside className={views.detailsPane} aria-label="Planning chat details">
        <Section title="Started from">
          <p className={styles.paneText}>Plan, by you</p>
        </Section>
        <Section title="Proposed Tasks">
          <p className={styles.paneMuted}>None yet.</p>
        </Section>
      </aside>
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

function TitleEditor({ plan, renameSignal }: { plan: Plan; renameSignal: number }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(plan.title)
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const title = useRef(plan.title)
  title.current = plan.title

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
    if (title === '' || title === plan.title) {
      setEditing(false)
      setValue(plan.title)
      return
    }
    try {
      await ted.renamePlan(plan.id, title)
      setEditing(false)
      setError(undefined)
    } catch (failed) {
      setError(readableError(failed))
    }
  }

  if (!editing) {
    return (
      <h1 className={styles.title}>
        <button
          type="button"
          className={styles.titleButton}
          title="Rename"
          onClick={() => {
            setValue(plan.title)
            setEditing(true)
          }}
        >
          {plan.title}
        </button>
      </h1>
    )
  }
  return (
    <span className={styles.titleEdit}>
      <input
        ref={input}
        className={styles.titleInput}
        aria-label="Title"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save()
          if (event.key === 'Escape') {
            setEditing(false)
            setValue(plan.title)
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
  onDeleted,
}: {
  plan: Plan
  onRename: () => void
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
      <Button size="small" aria-label="More" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </Button>
      {open && !confirming && (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false)
              onRename()
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.danger}`}
            onClick={() => setConfirming(true)}
          >
            Delete…
          </button>
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
              size="small"
              onClick={() => {
                setConfirming(false)
                setOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button size="small" variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </span>
  )
}

function PlanHeader({
  plan,
  onBack,
  onDeleted,
}: {
  plan: Plan
  onBack: () => void
  onDeleted: () => void
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
      <Back onBack={onBack} />
      <div className={styles.titleRow}>
        <TitleEditor plan={plan} renameSignal={renameSignal} />
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
          <Button size="small" disabled={stopping} onClick={() => void stop()}>
            Stop
          </Button>
        )}
        <MoreMenu
          plan={plan}
          onRename={() => setRenameSignal((n) => n + 1)}
          onDeleted={onDeleted}
        />
      </div>
      <p className={styles.startedLine}>
        {planStartedLine(plan)}
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
          <span>{`${detail} · ${state}`}</span>
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
        <span className={styles.lineText}>{` · ${detail} · ${state}`}</span>
        <span className={styles.spacer} />
        {canShow && (
          <button type="button" className={styles.link} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : showLabel}
          </button>
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
      <span className={styles.eventTime}>{timeOf(at)}</span>
    </p>
  )
}

function PinnedCard({ request, onAnswered }: { request: PlanRequest; onAnswered: () => void }) {
  const now = useNow()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const { kind, detail } = requestHeading(request)

  async function send(answer: AnswerRequest) {
    setSending(true)
    setError(undefined)
    try {
      await ted.answerPlanRequest(request.id, answer)
      onAnswered()
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className={styles.pinned} aria-label={`${kind} from the planner`}>
      <div className={styles.cardHead}>
        <span className={styles.pendingKind}>{kind}</span>
        <span>{`· ${detail} · from the planner · ${ago(request.createdAt, now)}`}</span>
      </div>
      {request.title !== undefined && request.title !== '' && (
        <p className={styles.cardTitle}>{request.title}</p>
      )}
      {request.body !== '' && <p className={styles.summary}>{request.body}</p>}
      {request.round && (
        <>
          <RoundQuestions
            round={request.round}
            readOnly={false}
            sending={sending}
            talk={false}
            onSend={(answer) => void send(answer)}
          />
          <p className={styles.talkHint}>Typing below talks it through with the planner.</p>
        </>
      )}
      {request.proposal && (
        <ProposalAnswer
          proposal={request.proposal}
          readOnly={false}
          sending={sending}
          onSend={(answer) => void send(answer)}
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
          key: request.id,
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
          key: request.id,
          at: request.createdAt,
          node: (
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
          : 'Planning Run stopped by you. No Tasks were created.'
    extra.push({
      key: 'ended',
      at: plan.finishedAt,
      node: <EventLine text={text} at={plan.finishedAt} />,
    })
  }
  return extra
}

function PlanChat({
  planId,
  onBack,
  onOpenTask,
  onDeleted,
}: {
  planId: string
  onBack: () => void
  onOpenTask: (ref: string) => void
  onDeleted: () => void
}) {
  const detail = usePlan(planId)
  const [, setAnswered] = useState(0)
  if (!detail) {
    return (
      <section className={views.pane} aria-label="Planning chat">
        <p className={views.empty}>Loading the planning chat…</p>
      </section>
    )
  }
  const { plan } = detail
  const open = detail.requests.findLast((r) => r.kind !== 'note' && r.answer === undefined)
  const ended = planEnded(plan)
  return (
    <>
      <section className={views.pane} aria-label="Planning chat">
        <PlanHeader plan={plan} onBack={onBack} onDeleted={onDeleted} />
        {plan.runId !== undefined ? (
          <RunChat
            runId={plan.runId}
            options={{
              bar: false,
              extra: extraItems(detail, onOpenTask),
              ...(open && {
                pinned: <PinnedCard request={open} onAnswered={() => setAnswered((n) => n + 1)} />,
              }),
              placeholder: 'Message the planner…',
              help: 'Goes to the planner. While a round is open, this talks it through.',
              ...(ended && {
                readOnly: (
                  <div className={styles.endedBar}>
                    {plan.status === 'failed'
                      ? 'This planning chat failed. It stays as history.'
                      : 'This planning chat is finished. It stays as history.'}
                  </div>
                ),
              }),
            }}
          />
        ) : (
          <QueuedChat plan={plan} />
        )}
      </section>
      <PlanPane detail={detail} onOpenTask={onOpenTask} />
    </>
  )
}

function QueuedChat({ plan }: { plan: Plan }) {
  return (
    <div className={styles.queued}>
      <div className={styles.queuedBody}>
        <div className={styles.bubble}>
          <span className={styles.bubbleHead}>{`You · ${timeOf(plan.createdAt)}`}</span>
          <p className={styles.bubbleText}>{plan.message}</p>
        </div>
        <p className={styles.waitNote}>
          {plan.status === 'queued'
            ? 'Your message is kept. The planner starts when a working slot frees up.'
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
}: {
  detail: PlanDetail
  onOpenTask: (ref: string) => void
}) {
  const { plan, requests, tasks } = detail
  const proposal = requests.findLast((r) => r.kind === 'proposal')
  return (
    <aside className={views.detailsPane} aria-label="Planning chat details">
      <Section title="Started from">
        <p className={styles.paneText}>Plan, by you</p>
      </Section>
      {tasks.length > 0 ? (
        <Section title={`Created Tasks · ${tasks.length}`}>
          <ul className={styles.paneList}>
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={styles.paneTask}
                  onClick={() => onOpenTask(task.id)}
                >
                  <span className={styles.paneId}>{task.displayId}</span>
                  {task.title}
                </button>
                <span className={styles.paneMuted}>
                  {[
                    task.stage.charAt(0).toUpperCase() + task.stage.slice(1),
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
    </aside>
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
