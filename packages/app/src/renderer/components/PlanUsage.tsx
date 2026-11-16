import type { AgentHealth, AgentKind, Billing } from '@ted/protocol'
import { agentShortNames, runsPaused } from '@ted/protocol/health'
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  fullestWindow,
  usageAgents,
  usageEmpty,
  usageReset,
  usageTone,
  usageWindowNames,
  usageWindows,
} from '../plan-usage.ts'
import { ago, useNow } from '../requests.ts'
import styles from './PlanUsage.module.css'
import { AgentMark } from './RunIcon.tsx'

interface UsageProps {
  health: readonly AgentHealth[]
  billing: Readonly<Record<AgentKind, Billing>>
  agents: readonly AgentKind[]
}

function freshness(health: AgentHealth | undefined, now: number): string {
  if (!health) return 'Checking Provider…'
  const status =
    health.state === 'ready' ? undefined : (health.reason ?? health.state.replaceAll('-', ' '))
  const usage = health.planUsage
  const source = usage
    ? `${health.state !== 'ready' && health.state !== 'usage-limit' ? 'Last known' : usage.from === 'run' ? 'From last Run' : 'Last read'} · ${ago(usage.at, now)}`
    : undefined
  return [
    status,
    health.state !== 'ready' && health.pausedRuns > 0 ? runsPaused(health.pausedRuns) : undefined,
    source,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function PlanUsage({
  health,
  billing,
  enabledAgents,
  open,
  onToggle,
  onClose,
  onSettings,
}: Omit<UsageProps, 'agents'> & {
  enabledAgents: readonly AgentKind[]
  open: boolean
  onToggle: () => void
  onClose: () => void
  onSettings: () => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const now = useNow()
  const id = useId()
  const agents = usageAgents(health, enabledAgents)
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label="Usage"
        aria-description={agents
          .map((agent) => {
            const window = fullestWindow(
              usageWindows(
                health.find((h) => h.agent === agent),
                billing[agent],
              ),
            )
            return `${agentShortNames[agent]}: ${window ? `${usageWindowNames[window.window]}, ${Math.round(window.percent)}%` : billing[agent] === 'api-key' ? 'API key' : 'No usage yet'}`
          })
          .join('; ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={onToggle}
      >
        <span className={styles.triggerHead}>
          Usage <span aria-hidden>{open ? '⌄' : '⌃'}</span>
        </span>
        {agents.map((agent) => {
          const known = health.find((h) => h.agent === agent)
          const window = fullestWindow(usageWindows(known, billing[agent]))
          const reset = usageReset(window?.resetsAt, now)
          const label = window
            ? `${agentShortNames[agent]} · ${usageWindowNames[window.window]} · ${Math.round(window.percent)}%${reset ? ` · ${reset === 'Awaiting update' ? reset : `resets in ${reset}`}` : ''}`
            : `${agentShortNames[agent]} · ${billing[agent] === 'api-key' ? 'API key' : 'No usage yet'}`
          return (
            <span
              key={agent}
              className={styles.mini}
              data-tone={usageTone(window?.percent)}
              title={label}
            >
              <AgentMark agent={agent} size={13} />
              <span>{agentShortNames[agent]}</span>
              <strong>{window ? `${Math.round(window.percent)}%` : '—'}</strong>
              <span className={styles.countdown}>
                {reset === 'Awaiting update' ? 'Update due' : reset}
              </span>
            </span>
          )
        })}
      </button>
      {open && (
        <UsagePopover
          id={id}
          trigger={trigger}
          health={health}
          billing={billing}
          agents={agents}
          onClose={onClose}
          onSettings={onSettings}
        />
      )}
    </>
  )
}

function UsagePopover({
  id,
  trigger,
  health,
  billing,
  agents,
  onClose,
  onSettings,
}: UsageProps & {
  id: string
  trigger: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onSettings: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ left: 12, bottom: 12 })
  const now = useNow()
  useLayoutEffect(() => {
    const place = () => {
      const box = trigger.current?.getBoundingClientRect()
      if (box)
        setPosition({
          left: Math.max(12, Math.min(box.left, window.innerWidth - 378)),
          bottom: Math.max(
            12,
            Math.min(window.innerHeight - 120, window.innerHeight - box.top + 8),
          ),
        })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [trigger])
  useEffect(() => {
    const panel = ref.current
    close.current?.focus()
    const dismiss = (event: PointerEvent) => {
      if (
        !panel?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        onClose()
    }
    window.addEventListener('pointerdown', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      if (panel?.contains(document.activeElement) || document.activeElement === document.body)
        trigger.current?.focus()
    }
  }, [onClose, trigger])
  return (
    <div
      id={id}
      ref={ref}
      role="dialog"
      aria-labelledby={`${id}-title`}
      className={styles.popover}
      style={{ ...position, maxHeight: `calc(100vh - ${position.bottom + 12}px)` }}
    >
      <div className={styles.header}>
        <h2 id={`${id}-title`}>Usage</h2>
        <button
          ref={close}
          type="button"
          className={styles.close}
          aria-label="Close usage"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {agents.length === 0 && <p className={styles.empty}>No Providers are set up.</p>}
      {agents.map((agent) => {
        const known = health.find((h) => h.agent === agent)
        const top = fullestWindow(usageWindows(known, billing[agent]))
        const reset = usageReset(top?.resetsAt, now)
        return (
          <section
            key={agent}
            className={styles.agent}
            aria-label={`${agentShortNames[agent]} usage`}
          >
            <div className={styles.agentHead}>
              <AgentMark agent={agent} size={16} />
              <strong>{agentShortNames[agent]}</strong>
              <span className={styles.summary}>
                {top ? (
                  <>
                    {usageWindowNames[top.window]}{' '}
                    <span>{reset === 'Awaiting update' ? 'Update due' : reset}</span>{' '}
                    <b data-tone={usageTone(top.percent)}>{Math.round(top.percent)}%</b>
                  </>
                ) : billing[agent] === 'api-key' ? (
                  'API key'
                ) : (
                  'No usage yet'
                )}
              </span>
            </div>
            {!top && <p className={styles.note}>{usageEmpty(agent, billing[agent])}</p>}
            <p className={styles.note}>{freshness(known, now)}</p>
          </section>
        )
      })}
      <div className={styles.footer}>
        <p>
          Updates as Runs report usage. Percentages are for your Provider accounts, across all apps.
        </p>
        <button type="button" onClick={onSettings}>
          Provider settings <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  )
}
