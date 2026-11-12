import type { AgentHealth, AgentKind, Billing, PlanUsage, PlanWindow } from '@ted/protocol'
import {
  agentDisplayNames,
  antigravityTermsUrl,
  billingNames,
  billings,
  planWarnPercent,
  resetTime,
  runsPaused,
} from '@ted/protocol/health'
import { useEffect, useId, useState } from 'react'
import { AntigravityChatWarning } from '../components/AntigravityChatWarning.tsx'
import { Help } from '../components/Help.tsx'
import { Loading, LoadingError, Skeleton } from '../components/Loading.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { useAgentHealthState } from '../data.ts'
import { ago, useNow } from '../requests.ts'
import { ted } from '../ted.ts'
import { timePreferences } from '../time.ts'
import { AgentDefaults } from './AgentDefaults.tsx'
import styles from './AgentsPage.module.css'
import { Button, SettingRow, SettingsGroup, SettingsPage, Switch } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'

export const fixCheckEveryMs = 5_000

const stateLabels: Record<AgentHealth['state'], string> = {
  ready: 'Ready',
  'not-installed': 'Not installed',
  unavailable: 'Can’t run',
  'signed-out': 'Signed out',
  'too-old': 'Too old',
  'wrong-credential': 'Using an API key',
  'usage-limit': 'Usage limit',
  offline: 'Offline',
}

const windowNames: Record<PlanWindow['window'], string> = {
  'five-hour': '5-hour window',
  weekly: 'Weekly',
}

const keyVariables: Record<AgentKind, string> = {
  claude: 'ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN',
  codex: 'CODEX_API_KEY and OPENAI_API_KEY',
  antigravity: 'GEMINI_API_KEY and Google Cloud credentials',
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

function limitLine(health: AgentHealth): string {
  if (health.limitResetsAt === undefined) {
    return 'Paused until the limit resets. TED tries one Run every 15 minutes.'
  }
  const full = health.planUsage?.windows.find((w) => w.percent >= 100)
  const which = full ? `the ${windowNames[full.window].toLowerCase()}` : 'the limit'
  return `Paused until ${which} resets at ${resetTime(health.limitResetsAt, undefined, timePreferences())}.`
}

function freshness(health: AgentHealth, usage: PlanUsage, now: number): string {
  const when = ago(usage.at, now)
  if (health.state !== 'ready' && health.state !== 'usage-limit') return `Last known · ${when}`
  return usage.from === 'run' ? `From the last Run · ${when}` : `Read ${when}`
}

function tone(percent: number): 'full' | 'warn' | 'ok' {
  if (percent >= 100) return 'full'
  if (percent >= planWarnPercent) return 'warn'
  return 'ok'
}

function UsageBar({ window }: { window: PlanWindow }) {
  const percent = Math.round(window.percent)
  const shown = tone(window.percent)
  const resets =
    window.resetsAt !== undefined
      ? ` · resets ${resetTime(window.resetsAt, undefined, timePreferences())}`
      : ''
  return (
    <div className={styles.usage} data-tone={shown}>
      <div className={styles.usageLabels}>
        <span>{windowNames[window.window]}</span>
        <span className={styles.usageValue}>
          {percent}%{resets}
        </span>
      </div>
      <div className={styles.track} aria-hidden>
        <div className={styles.fill} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
    </div>
  )
}

function BillingChoice({
  agent,
  billing,
  onChange,
  planAccepted,
  onAcceptPlan,
}: {
  agent: AgentKind
  billing: Billing
  onChange: (billing: Billing) => void
  planAccepted: boolean
  onAcceptPlan: () => void
}) {
  const name = useId()
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Billing</h3>
      <div
        className={styles.choices}
        role="radiogroup"
        aria-label={`${agentDisplayNames[agent]} billing`}
      >
        {billings.map((choice) => (
          <label key={choice} className={styles.choice}>
            <input
              type="radio"
              name={name}
              className={styles.radio}
              checked={billing === choice}
              onChange={() => onChange(choice)}
            />
            {billingNames[choice]}
            {choice === 'subscription' && (
              <Help>
                TED removes {keyVariables[agent]} from this agent’s Runs, and pauses it if a Run
                reports an API key. TED never asks for or stores a key.
              </Help>
            )}
          </label>
        ))}
      </div>
      {agent === 'antigravity' && <AntigravityChatWarning agent={agent} />}
      {agent === 'antigravity' && billing === 'subscription' && (
        <div className={styles.planNotice} role="note" aria-label="Google’s terms">
          <p className={styles.line}>
            Google’s terms say that using Antigravity through other software, such as TED, on a
            Google plan can get your account suspended. Google recommends an API key for this. Read
            them at {antigravityTermsUrl.replace('https://', '')}.
          </p>
          {planAccepted ? (
            <p className={styles.line}>You chose to use your Google plan anyway.</p>
          ) : (
            <Button onClick={onAcceptPlan}>Use my Google plan anyway</Button>
          )}
        </div>
      )}
      {agent === 'antigravity' && (
        <p className={styles.line}>
          {billing === 'subscription'
            ? 'Sign in with the Google account that has your Ultra plan.'
            : 'Set GEMINI_API_KEY in your login-shell profile, then choose Check again. Requests are billed separately. TED never asks for or stores the key.'}
        </p>
      )}
    </div>
  )
}

function PlanUsageSection({ health }: { health: AgentHealth }) {
  const now = useNow()
  const usage = health.planUsage
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Plan usage</h3>
        {usage && <span className={styles.fresh}>{freshness(health, usage, now)}</span>}
      </div>
      {usage && usage.windows.length > 0 ? (
        <div className={styles.bars}>
          {usage.windows.map((w) => (
            <UsageBar key={w.window} window={w} />
          ))}
        </div>
      ) : (
        <p className={styles.line}>
          {health.agent === 'antigravity'
            ? 'Usage figures are unavailable unless reported by Antigravity.'
            : health.agent === 'claude'
              ? 'Shows once a Run has made a request.'
              : 'Shows once a Run has started.'}
        </p>
      )}
    </div>
  )
}

function AgentCard({
  health,
  billing,
  opened,
  onFix,
  onCheck,
  onBilling,
  planAccepted,
  onAcceptPlan,
  checking,
  error,
}: {
  health: AgentHealth
  billing: Billing
  opened: boolean
  onFix: () => void
  onCheck: () => void
  onBilling: (billing: Billing) => void
  planAccepted: boolean
  onAcceptPlan: () => void
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
  const signedIn = !['not-installed', 'signed-out', 'too-old', 'unavailable'].includes(health.state)

  return (
    <section
      className={`${styles.card} ${stopping ? styles.stopsWork : ''}`}
      aria-label={name}
      data-state={health.state}
    >
      <div className={styles.top}>
        <div className={styles.head}>
          <HealthIcon ready={ready} />
          <h2 className={styles.name}>{name}</h2>
          <StatusChip tone={ready ? 'success' : stopping ? 'failed' : 'neutral'}>{chip}</StatusChip>
          <span className={styles.spacer} />
          {health.fix && (
            <Button onClick={() => void ted.copyText(health.fix?.command ?? '')}>
              Copy command
            </Button>
          )}
          <Button onClick={onCheck} disabled={checking}>
            {checking ? <Loading compact label="Checking…" /> : 'Check again'}
          </Button>
          {health.fix && (
            <Button primary onClick={onFix}>
              {health.fix.label}
            </Button>
          )}
        </div>
        <div className={styles.lines}>
          <p className={styles.line}>{facts}</p>
          {signedIn && health.account !== undefined && (
            <p className={styles.line}>{health.account}</p>
          )}
          {health.state === 'unavailable' && <p className={styles.line}>{health.reason}</p>}
          {health.state === 'signed-out' && <p className={styles.line}>Not signed in.</p>}
          {health.state === 'too-old' && (
            <p className={styles.line}>
              This version is older than TED supports. TED never updates it without asking.
            </p>
          )}
          {health.state === 'not-installed' && health.fix && (
            <p className={styles.line}>
              Not installed. Install it with{' '}
              <code className={styles.code}>{health.fix.command}</code>
            </p>
          )}
          {health.state === 'usage-limit' && (
            <p className={styles.line}>
              {limitLine(health)}{' '}
              <Help>
                Runs stay open and carry on by themselves. TED never switches them to the other
                agent; change the Task Lead field if you want to.
              </Help>
            </p>
          )}
          {health.state === 'offline' && (
            <p className={styles.line}>Paused until the connection returns.</p>
          )}
          {health.state === 'wrong-credential' && (
            <p className={`${styles.line} ${styles.error}`}>
              A Run is using an API key, not your subscription. {health.keySource}
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
      </div>
      <BillingChoice
        agent={health.agent}
        billing={billing}
        onChange={onBilling}
        planAccepted={planAccepted}
        onAcceptPlan={onAcceptPlan}
      />
      <PlanUsageSection health={health} />
    </section>
  )
}

export function AgentsPage({ settings }: SettingsPageProps) {
  const resource = useAgentHealthState()
  const health = resource.health
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

  const chooseBilling = (agent: AgentKind, billing: Billing) =>
    void ted
      .updateSettings({ billing: { ...settings.billing, [agent]: billing } })
      .catch((error: unknown) => console.error(error))

  return (
    <SettingsPage title="Agents">
      <div className={styles.cards}>
        {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
        {!resource.loaded && health.length === 0 && !resource.error && (
          <Skeleton shape="settings" label="Checking your agents…" />
        )}
        {health.map((h) => (
          <AgentCard
            key={h.agent}
            health={h}
            billing={settings.billing[h.agent]}
            opened={opened[h.agent] === true && h.state !== 'ready'}
            onFix={() => void fix(h.agent)}
            onCheck={() => void check()}
            onBilling={(billing) => chooseBilling(h.agent, billing)}
            planAccepted={settings.antigravityPlanAccepted}
            onAcceptPlan={() =>
              void ted
                .updateSettings({ antigravityPlanAccepted: true })
                .catch((error: unknown) => console.error(error))
            }
            checking={checking}
            error={errors[h.agent]}
          />
        ))}
      </div>
      <SettingsGroup>
        <SettingRow
          title="Restart idle Runs onto new agent versions"
          help="When an agent updates, TED restarts each idle Run on the new version and resumes its conversation. Working Runs restart once they go idle."
        >
          <Switch
            label="Restart idle Runs onto new agent versions"
            checked={settings.restartIdleRuns}
            onChange={(restartIdleRuns) => void ted.updateSettings({ restartIdleRuns })}
          />
        </SettingRow>
      </SettingsGroup>
      <AgentDefaults />
    </SettingsPage>
  )
}
