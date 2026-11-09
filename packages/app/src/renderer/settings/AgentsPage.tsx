import type { AgentHealth, AgentKind } from '@ted/protocol'
import { agentDisplayNames, runsPaused } from '@ted/protocol/health'
import { useEffect, useState } from 'react'
import { StatusChip } from '../components/StatusChip.tsx'
import { useAgentHealth } from '../data.ts'
import { ted } from '../ted.ts'
import styles from './AgentsPage.module.css'
import { Button, SettingsPage } from './controls.tsx'

export const fixCheckEveryMs = 5_000

const stateLabels: Record<AgentHealth['state'], string> = {
  ready: 'Ready',
  'not-installed': 'Not installed',
  'signed-out': 'Signed out',
  'too-old': 'Too old',
  'wrong-credential': 'Using an API key',
}

export function stopsWork(health: AgentHealth): boolean {
  return health.state !== 'ready' && (health.state !== 'not-installed' || health.pausedRuns > 0)
}

const terminalName = () => (/Mac/.test(navigator.userAgent) ? 'Terminal' : 'your terminal')

function HealthIcon({ ready }: { ready: boolean }) {
  return (
    <svg
      className={ready ? styles.readyIcon : styles.problemIcon}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden
    >
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      {ready ? (
        <path
          className={styles.onIcon}
          d="M4.8 8.2L7 10.4L11.2 5.8"
          fill="none"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <rect className={styles.onIconFill} x="7.2" y="3.8" width="1.6" height="5.4" rx="0.8" />
          <circle className={styles.onIconFill} cx="8" cy="11.6" r="0.95" />
        </>
      )}
    </svg>
  )
}

function AgentCard({
  health,
  opened,
  onFix,
  onCheck,
  checking,
  error,
}: {
  health: AgentHealth
  opened: boolean
  onFix: () => void
  onCheck: () => void
  checking: boolean
  error: string | undefined
}) {
  const ready = health.state === 'ready'
  const stopping = stopsWork(health)
  const name = agentDisplayNames[health.agent]
  const chip =
    health.pausedRuns > 0 && !ready
      ? `${stateLabels[health.state]} · ${runsPaused(health.pausedRuns)}`
      : stateLabels[health.state]
  const facts = [
    ...(health.version !== undefined ? [health.version] : []),
    `minimum ${health.minimumVersion}`,
    ...(health.path !== undefined ? [health.path] : []),
  ].join(' · ')

  return (
    <section
      className={`${styles.card} ${stopping ? styles.stopsWork : ''}`}
      aria-label={name}
      data-state={health.state}
    >
      <div className={styles.head}>
        <HealthIcon ready={ready} />
        <h2 className={styles.name}>{name}</h2>
        <StatusChip tone={ready ? 'success' : stopping ? 'failed' : 'neutral'}>{chip}</StatusChip>
        <span className={styles.spacer} />
        {health.fix && (
          <Button onClick={() => void ted.copyText(health.fix?.command ?? '')}>Copy command</Button>
        )}
        <Button onClick={onCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
        {health.fix && (
          <Button primary onClick={onFix}>
            {health.fix.label}
          </Button>
        )}
      </div>
      <div className={styles.lines}>
        <p className={styles.line}>{facts}</p>
        {health.state === 'ready' && health.account !== undefined && (
          <p className={styles.line}>{health.account}</p>
        )}
        {health.state === 'signed-out' && <p className={styles.line}>Not signed in.</p>}
        {health.state === 'too-old' && (
          <p className={styles.line}>
            This version is older than TED supports. TED never updates it without asking.
          </p>
        )}
        {health.state === 'not-installed' && health.fix && (
          <p className={styles.line}>
            Not installed. Install it with <code className={styles.code}>{health.fix.command}</code>
          </p>
        )}
        {opened && health.fix && (
          <p className={styles.line}>
            Opened <code className={styles.code}>{health.fix.command}</code> in {terminalName()}.
            Checking again every 5 seconds…
          </p>
        )}
        {error !== undefined && <p className={`${styles.line} ${styles.error}`}>{error}</p>}
      </div>
    </section>
  )
}

export function AgentsPage() {
  const health = useAgentHealth()
  const [opened, setOpened] = useState<Partial<Record<AgentKind, boolean>>>({})
  const [checking, setChecking] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<AgentKind, string>>>({})
  const waiting = health.some((h) => opened[h.agent] && h.state !== 'ready')
  const anyProblem = health.some((h) => h.state !== 'ready')

  const check = async () => {
    setChecking(true)
    try {
      await ted.checkAgentHealth()
    } catch (error) {
      console.error(error)
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(
      () => void ted.checkAgentHealth().catch(() => undefined),
      fixCheckEveryMs,
    )
    return () => clearInterval(timer)
  }, [waiting])

  useEffect(() => {
    if (!anyProblem) return
    const onFocus = () => void ted.checkAgentHealth().catch(() => undefined)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [anyProblem])

  async function fix(agent: AgentKind) {
    setErrors((current) => ({ ...current, [agent]: undefined }))
    try {
      await ted.fixAgent(agent)
      setOpened((current) => ({ ...current, [agent]: true }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrors((current) => ({
        ...current,
        [agent]: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      }))
    }
  }

  return (
    <SettingsPage title="Agents">
      <div className={styles.cards}>
        {health.length === 0 && <p className={styles.line}>Checking your agents…</p>}
        {health.map((h) => (
          <AgentCard
            key={h.agent}
            health={h}
            opened={opened[h.agent] === true && h.state !== 'ready'}
            onFix={() => void fix(h.agent)}
            onCheck={() => void check()}
            checking={checking}
            error={errors[h.agent]}
          />
        ))}
      </div>
    </SettingsPage>
  )
}
