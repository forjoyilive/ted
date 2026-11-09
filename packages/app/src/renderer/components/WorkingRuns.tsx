import type { Factory, FactorySlots, RunSlots, SlotHolder } from '@ted/protocol'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { slotCount } from '../slots.ts'
import { priorityLabels } from '../task-fields.ts'
import { Help } from './Help.tsx'
import { ordinal } from './TaskStatus.tsx'
import styles from './WorkingRuns.module.css'

const machine = navigator.userAgent.includes('Mac') ? 'this Mac' : 'this computer'

function Group({
  label,
  count,
  help,
  children,
}: {
  label: string
  count?: number
  help?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className={styles.group} aria-labelledby={id}>
      <div className={styles.groupHeader}>
        <h3 className={styles.groupLabel} id={id}>
          {label}
        </h3>
        {help !== undefined && <Help>{help}</Help>}
        <span className={styles.spacer} />
        {count !== undefined && <span className={styles.groupCount}>{count}</span>}
      </div>
      <ul className={styles.rows}>{children}</ul>
    </section>
  )
}

function Row({
  lead,
  place,
  title,
  detail,
  trailing,
}: {
  lead: string
  place?: boolean
  title: string
  detail: string
  trailing?: string
}) {
  return (
    <li className={styles.row}>
      <span className={place ? styles.place : styles.lead}>{lead}</span>
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        <span className={styles.detail}>{detail}</span>
      </span>
      {trailing !== undefined && <span className={styles.trailing}>{trailing}</span>}
    </li>
  )
}

function holderRuns(holder: SlotHolder): string {
  if (holder.runs === 0 && holder.settingUp) return 'Setting up the worktree'
  const subs = holder.subAgents
  if (subs === 0) return 'Task Lead'
  const named = subs === 1 ? '1 sub-agent' : `${subs} sub-agents`
  return holder.runs > subs ? `Task Lead and ${named}` : named
}

export function WorkingRunsPopover({
  slots,
  factories,
  onOpenList,
  onClose,
}: {
  slots: RunSlots
  factories: readonly Factory[]
  onOpenList: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [onClose])

  const name = (factoryId: string) =>
    factories.find((f) => f.id === factoryId)?.name ?? 'No Factory'
  const cap = (factoryId: string): FactorySlots | undefined =>
    slots.factories.find((f) => f.factoryId === factoryId)
  const factoryLabel = (factoryId: string) => {
    const own = cap(factoryId)
    return own ? `${name(factoryId)} ${own.working} of ${own.cap}` : name(factoryId)
  }
  const empty = slots.holders.length === 0 && slots.queue.length === 0

  return (
    <div ref={ref} className={styles.popover} role="dialog" aria-labelledby={titleId}>
      <div className={styles.header}>
        <h2 className={styles.heading} id={titleId}>
          Working Runs
        </h2>
        <span className={styles.spacer} />
        <span
          className={styles.slots}
        >{`${slots.working} of ${slots.limit} slots on ${machine}`}</span>
      </div>
      {empty ? (
        <p className={styles.empty}>No Runs working. Nothing queued.</p>
      ) : (
        <div className={styles.body}>
          {slots.holders.length > 0 && (
            <Group label="Working">
              {slots.holders.map((holder) => (
                <Row
                  key={holder.taskId}
                  lead={holder.displayId}
                  title={holder.title}
                  detail={`${factoryLabel(holder.factoryId)} · ${holderRuns(holder)}`}
                  trailing={slotCount(holder.runs)}
                />
              ))}
            </Group>
          )}
          {slots.queue.length > 0 && (
            <Group
              label="Queued"
              count={slots.queue.length}
              help="The next free slot goes to the first in line: the setup Task, sub-agent requests, Planning Runs, Automation Runs, then Tasks by Priority and rank."
            >
              {slots.queue.map((entry) =>
                entry.kind === 'sub-agent' ? (
                  <Row
                    key={entry.runId}
                    lead={ordinal(entry.place)}
                    place
                    title={`${entry.displayId} · ${entry.name}`}
                    detail={`${name(entry.factoryId)} · Sub-agent`}
                  />
                ) : (
                  <Row
                    key={entry.taskId}
                    lead={ordinal(entry.place)}
                    place
                    title={`${entry.displayId} · ${entry.title}`}
                    detail={`${name(entry.factoryId)} · ${priorityLabels[entry.priority]}`}
                  />
                ),
              )}
            </Group>
          )}
        </div>
      )}
      <div className={styles.footer}>
        <span className={styles.spacer} />
        <button type="button" className={styles.link} onClick={onOpenList}>
          Open in List →
        </button>
        <Help>Read-only. Reorder the queue in the List.</Help>
      </div>
    </div>
  )
}
