import type { Factory, Plan } from '@ted/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { ChevronIcon } from '../components/icons.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { usePlans, useRunChat } from '../data.ts'
import { usePendingAction } from '../pending-action.ts'
import {
  chatActivity,
  planDetailLine,
  planEnded,
  planGroups,
  planStatusChip,
  planTasksLabel,
  startedDay,
} from '../plans.ts'
import { agentLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import boardStyles from './Board.module.css'
import styles from './PlansList.module.css'
import views from './views.module.css'

interface RowActions {
  onOpenPlan: (planId: string) => void
  onOpenTask: (ref: string) => void
  onPlanMore: (planId: string) => void
}

export function PlansList({
  factory,
  banners,
  onPlan,
  ...actions
}: RowActions & {
  factory: Factory
  banners?: ReactNode
  onPlan: () => void
}) {
  const plans = usePlans(factory.id)
  const { open, past } = planGroups(plans)
  const [pastOpen, setPastOpen] = useState(false)
  const title = `${factory.name} · Plans`
  const plan = (
    <Button variant="primary" disabled={!factory.cloned} onClick={onPlan}>
      Plan
    </Button>
  )
  return (
    <section className={views.pane} aria-label={title}>
      <header className={views.header}>
        <h1 className={views.title}>
          {factory.name}
          <span className={boardStyles.crumbSlash}>/</span>
          <span className={boardStyles.crumb}>Plans</span>
        </h1>
        <span className={views.headerSpacer} />
        {plan}
      </header>
      {banners}
      {plans.length === 0 ? (
        <EmptyState
          title="No planning chats yet"
          line="Plan a piece of work too big for one Task. You and an agent talk it through, then it proposes Tasks for you to approve."
        >
          {plan}
        </EmptyState>
      ) : (
        <div className={styles.scroll}>
          <Group label="Open" plans={open} expanded onToggle={undefined} actions={actions} />
          {past.length > 0 && (
            <Group
              label="Past"
              plans={past}
              expanded={pastOpen}
              onToggle={() => setPastOpen(!pastOpen)}
              actions={actions}
            />
          )}
        </div>
      )}
    </section>
  )
}

function Group({
  label,
  plans,
  expanded,
  onToggle,
  actions,
}: {
  label: string
  plans: readonly Plan[]
  expanded: boolean
  onToggle: (() => void) | undefined
  actions: RowActions
}) {
  const heading = (
    <>
      <span className={styles.groupLabel}>{label}</span>
      <span className={styles.groupCount}>{plans.length}</span>
    </>
  )
  return (
    <section className={styles.group} aria-label={`${label} planning chats`}>
      {onToggle ? (
        <ActionButton
          type="button"
          className={styles.groupHeading}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <ChevronIcon open={expanded} className={styles.chevron} />
          {heading}
        </ActionButton>
      ) : (
        <h2 className={styles.groupHeading}>{heading}</h2>
      )}
      {expanded && plans.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.titleColumn}>Title</th>
              <th className={styles.statusColumn}>Status</th>
              <th className={styles.startedColumn}>Started</th>
              <th className={styles.tasksColumn}>Tasks</th>
              <th className={styles.agentColumn}>Provider</th>
              <th className={styles.moreColumn}>
                <span className={styles.hidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <PlanRow key={plan.id} plan={plan} actions={actions} />
            ))}
          </tbody>
        </table>
      )}
      {expanded && plans.length === 0 && <p className={styles.none}>Nothing open.</p>}
    </section>
  )
}

function WorkingLine({ runId }: { runId: string }) {
  const chat = useRunChat(runId)
  const line = chat && chatActivity(chat.items)
  return line === undefined ? null : <span className={styles.detail}>{line}</span>
}

function PlanRow({ plan, actions }: { plan: Plan; actions: RowActions }) {
  const chip = planStatusChip(plan)
  const detail = planDetailLine(plan)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string>()
  const [retrying, setRetrying] = useState(false)

  async function retry() {
    setRetrying(true)
    setError(undefined)
    try {
      await ted.resumePlan(plan.id)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <tr
      className={styles.row}
      onClick={(event) => {
        if (
          renaming ||
          (event.target as HTMLElement).closest(
            'button, input, [role="menu"], [role="alertdialog"]',
          )
        ) {
          return
        }
        return actions.onOpenPlan(plan.id)
      }}
    >
      <td className={styles.titleColumn}>
        {renaming ? (
          <RenameField plan={plan} onDone={() => setRenaming(false)} />
        ) : (
          <ActionButton
            type="button"
            data-nav-item
            className={styles.title}
            onClick={() => actions.onOpenPlan(plan.id)}
          >
            {plan.title}
          </ActionButton>
        )}
        {plan.fromTask && (
          <span className={styles.from}>
            {'from '}
            {plan.fromTask.gone === 'deleted' ? (
              plan.fromTask.displayId
            ) : (
              <ActionButton
                type="button"
                className={styles.link}
                onClick={() => plan.fromTask && actions.onOpenTask(plan.fromTask.id)}
              >
                {plan.fromTask.displayId}
              </ActionButton>
            )}
          </span>
        )}
      </td>
      <td className={styles.statusColumn}>
        <span className={styles.status}>
          <StatusChip tone={chip.tone} {...(chip.glyph && { glyph: chip.glyph })}>
            {chip.label}
          </StatusChip>
          {detail !== undefined && <span className={styles.detail}>{detail}</span>}
          {plan.status === 'working' && plan.runId !== undefined && (
            <WorkingLine runId={plan.runId} />
          )}
          {plan.canResume && (
            <Button size="small" disabled={retrying} onClick={() => retry()}>
              {plan.status === 'failed' ? 'Retry' : 'Resume'}
            </Button>
          )}
        </span>
        {error !== undefined && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </td>
      <td className={styles.muted}>{startedDay(plan.createdAt)}</td>
      <td className={styles.muted}>{planTasksLabel(plan)}</td>
      <td className={styles.muted}>{agentLabels[plan.agent]}</td>
      <td className={styles.moreColumn}>
        <RowMenu
          plan={plan}
          actions={actions}
          onRename={() => setRenaming(true)}
          onError={setError}
        />
      </td>
    </tr>
  )
}

function RenameField({ plan, onDone }: { plan: Plan; onDone: () => void }) {
  const [title, setTitle] = useState(plan.title)
  const [error, setError] = useState<string>()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.select()
  }, [])
  async function save() {
    if (title.trim() === plan.title) return onDone()
    try {
      await ted.renamePlan(plan.id, title)
      onDone()
    } catch (failed) {
      setError(readableError(failed))
    }
  }
  return (
    <span className={styles.rename}>
      <input
        ref={field}
        className={styles.renameInput}
        aria-label="Planning chat title"
        data-arrows
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') onDone()
        }}
        onBlur={() => save()}
      />
      {error !== undefined && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

function RowMenu({
  plan,
  actions,
  onRename,
  onError,
}: {
  plan: Plan
  actions: RowActions
  onRename: () => void
  onError: (error: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const ended = planEnded(plan)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        setOpen(false)
        setConfirming(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const activity = usePendingAction()
  const run = (action: () => Promise<unknown>) =>
    activity.run(action)?.then(
      () => {
        setOpen(false)
        setConfirming(false)
      },
      (failed: unknown) => onError(readableError(failed)),
    )
  const item = (label: string, onClick: () => void, danger = false) => (
    <ActionButton
      type="button"
      role="menuitem"
      className={`${styles.menuItem} ${danger ? styles.danger : ''}`}
      onClick={onClick}
    >
      {label}
    </ActionButton>
  )

  return (
    <span className={styles.more} ref={box}>
      <ActionButton
        type="button"
        className={styles.moreButton}
        aria-label={`Actions for ${plan.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          setConfirming(false)
        }}
      >
        ⋯
      </ActionButton>
      {open && !confirming && (
        <div className={styles.menu} role="menu">
          {item('Rename…', () => {
            setOpen(false)
            onRename()
          })}
          {ended &&
            item('Plan more from here…', () => {
              setOpen(false)
              actions.onPlanMore(plan.id)
            })}
          {plan.canResume &&
            item(plan.status === 'failed' ? 'Retry' : 'Resume', () =>
              run(() => ted.resumePlan(plan.id)),
            )}
          {(plan.status === 'stopped' || plan.status === 'failed') &&
            item('Mark finished', () => run(() => ted.markPlanFinished(plan.id)))}
          {!ended && item('Stop', () => run(() => ted.stopPlan(plan.id)))}
          {item('Delete…', () => setConfirming(true), true)}
        </div>
      )}
      {open && confirming && (
        <div className={styles.menu} role="alertdialog" aria-label="Delete this planning chat?">
          <p className={styles.confirmText}>
            {ended
              ? 'Delete this planning chat and its conversation? Tasks it created stay.'
              : 'Stop the planner and delete this chat and its conversation? Tasks it created stay.'}
          </p>
          <div className={styles.confirmButtons}>
            <Button
              onClick={() => {
                setConfirming(false)
                setOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={() => run(() => ted.deletePlan(plan.id))}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </span>
  )
}
