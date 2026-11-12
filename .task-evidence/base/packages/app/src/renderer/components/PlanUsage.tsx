import type { AgentHealth, AgentKind, Billing } from '@ted/protocol'
import { agentShortNames, runsPaused } from '@ted/protocol/health'
import { agentKinds } from '@ted/protocol/run'
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  fullestWindow,
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
}

function freshness(health: AgentHealth | undefined, now: number): string {
  if (!health) return 'Checking agent…'
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
  open,
  onToggle,
  onClose,
  onSettings,
}: UsageProps & {
  open: boolean
  onToggle: () => void
  onClose: () => void
  onSettings: () => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const now = useNow()
  const id = useId()
  const [detailed, setDetailed] = useState(false)
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label="Usage"
        aria-description={agentKinds
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
        {agentKinds.map((agent) => {
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
          detailed={detailed}
          onDetailed={setDetailed}
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
  detailed,
  onDetailed,
  onClose,
  onSettings,
}: UsageProps & {
  id: string
  trigger: RefObject<HTMLButtonElement | null>
  detailed: boolean
  onDetailed: (detailed: boolean) => void
  onClose: () => void
  onSettings: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<AgentKind>>(new Set())
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
        <span>All agents</span>
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
      <fieldset className={styles.tabs} aria-label="Usage view">
        <button type="button" aria-pressed={detailed} onClick={() => onDetailed(true)}>
          Detailed
        </button>
        <button
          type="button"
          aria-pressed={!detailed}
          onClick={() => {
            onDetailed(false)
            setExpanded(new Set())
          }}
        >
          Compact
        </button>
      </fieldset>
      {agentKinds.map((agent) => {
        const known = health.find((h) => h.agent === agent)
        const windows = usageWindows(known, billing[agent])
        const top = fullestWindow(windows)
        const reset = usageReset(top?.resetsAt, now)
        const shown = detailed || expanded.has(agent)
        const detailsId = `${id}-${agent}`
        return (
          <section
            key={agent}
            className={styles.agent}
            aria-label={`${agentShortNames[agent]} usage`}
          >
            <button
              type="button"
              className={styles.agentHead}
              aria-label={`${agentShortNames[agent]} usage details`}
              aria-expanded={shown}
              aria-controls={detailsId}
              aria-describedby={`${detailsId}-summary`}
              onClick={() => {
                if (detailed) {
                  onDetailed(false)
                  setExpanded(new Set(agentKinds.filter((kind) => kind !== agent)))
                  return
                }
                setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(agent)) next.delete(agent)
                  else next.add(agent)
                  return next
                })
              }}
            >
              <AgentMark agent={agent} size={16} />
              <strong>{agentShortNames[agent]}</strong>
              <span id={`${detailsId}-summary`} className={styles.summary}>
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
              <span aria-hidden>{shown ? '⌄' : '›'}</span>
            </button>
            <div id={detailsId} hidden={!shown} className={styles.details}>
              {windows.map((window) => {
                const reset = usageReset(window.resetsAt, now)
                return (
                  <div
                    key={window.window}
                    className={styles.window}
                    data-tone={usageTone(window.percent)}
                  >
                    <div className={styles.labels}>
                      <span>{usageWindowNames[window.window]}</span>
                      <span>
                        {Math.round(window.percent)}%
                        {reset
                          ? ` · ${reset === 'Awaiting update' ? reset : `resets in ${reset}`}`
                          : ''}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`${agentShortNames[agent]} ${usageWindowNames[window.window]}`}
                      aria-valuenow={Math.min(100, window.percent)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className={styles.track}
                    >
                      <div
                        className={styles.fill}
                        style={{ width: `${Math.min(100, window.percent)}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
            {!top && <p className={styles.note}>{usageEmpty(agent, billing[agent])}</p>}
            <p className={styles.note}>{freshness(known, now)}</p>
          </section>
        )
      })}
      <div className={styles.footer}>
        <p>
          Updates as Runs report usage. Percentages are for your agent accounts, across all apps.
        </p>
        <button type="button" onClick={onSettings}>
          Agent settings <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  )
}
