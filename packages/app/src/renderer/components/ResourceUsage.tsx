import type { ResourceReading } from '@ted/protocol'
import {
  agentBreakdown,
  agentsPartLabel,
  memoryParts,
  memoryProcessCount,
  memorySize,
  memoryTotal,
} from '@ted/protocol/memory'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { besideAnchor } from '../menu-tooltip.ts'
import type { NavigationAction } from '../navigation.ts'
import { openSetting } from '../setting-focus.ts'
import { percent } from '../slots.ts'
import { ted } from '../ted.ts'
import styles from './ResourceUsage.module.css'

const refreshMs = 5_000
const closeAfterMs = 150

const share = (value: number | null) => (value === null ? '–' : percent(value))

export function ResourceUsage({ dispatch }: { dispatch: (action: NavigationAction) => void }) {
  const [usage, setUsage] = useState<ResourceReading>()
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined)
  const line = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLElement>(null)

  useEffect(() => {
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      timer = undefined
      if (stopped || running || document.hidden) return
      running = true
      try {
        const next = await ted.resourceUsage()
        if (!stopped) {
          setUsage(next)
          setFailed(false)
        }
      } catch {
        if (!stopped) {
          setUsage(undefined)
          setFailed(true)
        }
      } finally {
        running = false
        if (!stopped) timer = setTimeout(refresh, refreshMs)
      }
    }
    const onVisibility = () => {
      if (!document.hidden && timer === undefined) void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
      clearTimeout(closing.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const memory = usage?.memory
  const shown = open && memory !== undefined

  useLayoutEffect(() => {
    const anchor = line.current
    const bubble = card.current
    if (!shown || !anchor || !bubble) return
    if ('showPopover' in bubble) {
      bubble.popover = 'manual'
      bubble.showPopover()
    }
    const { left, top } = besideAnchor(
      anchor.getBoundingClientRect(),
      bubble.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
    )
    bubble.style.left = `${left}px`
    bubble.style.top = `${top}px`
  })

  const show = () => {
    clearTimeout(closing.current)
    setOpen(true)
  }
  const hide = () => {
    clearTimeout(closing.current)
    closing.current = setTimeout(() => setOpen(false), closeAfterMs)
  }

  const parts = memory ? memoryParts(memory) : []
  const total = memory ? memoryTotal(memory) : 0
  const largest = Math.max(1, ...parts.map((part) => part.bytes))
  const agents = memory ? agentBreakdown(memory) : []

  return (
    <section
      className={styles.usage}
      aria-label="Developer resource usage"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hide()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        ref={line}
        type="button"
        className={styles.line}
        aria-expanded={shown}
        disabled={memory === undefined}
        onClick={show}
      >
        {usage
          ? `CPU ${share(usage.machine.cpuInUse)} · Memory ${share(usage.machine.memoryInUse)}`
          : failed
            ? 'CPU / Memory unavailable'
            : 'CPU / Memory reading…'}
      </button>
      {shown && (
        <section ref={card} className={styles.card} aria-label="Memory breakdown">
          <h3 className={styles.title}>
            {`Memory used by Ted and its agents (${memoryProcessCount(memory)} processes)`}
          </h3>
          <p className={styles.note}>
            Each process is measured the way Activity Monitor measures it. Most show there as node,
            claude, codex or Ted.
          </p>
          <ul className={styles.parts}>
            {parts.map((part) => (
              <li key={part.label} className={styles.part}>
                <span className={styles.label}>
                  {part.label} <span className={styles.count}>· {part.count}</span>
                </span>
                <span className={styles.size}>{memorySize(part.bytes)}</span>
                {part.label === agentsPartLabel && agents.length > 0 && (
                  <span className={styles.kinds}>{agents.join(' · ')}</span>
                )}
                <span className={styles.meter}>
                  <span
                    className={styles.fill}
                    style={{ width: `${Math.round((part.bytes / largest) * 100)}%` }}
                  />
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.total}>
            <span>Total</span>
            <span>{memorySize(total)}</span>
          </p>
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              setOpen(false)
              openSetting(
                {
                  id: 'app.developer.processes',
                  name: 'Processes',
                  where: 'Settings › Developer',
                  target: { kind: 'app', section: 'developer' },
                },
                dispatch,
              )
            }}
          >
            Show every process in Settings → Developer
          </button>
        </section>
      )}
    </section>
  )
}
