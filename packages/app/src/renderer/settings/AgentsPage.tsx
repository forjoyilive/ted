import type {
  AgentApiCost,
  AgentAvailability,
  AgentHealth,
  AgentKind,
  ApiCostReport,
  BilledAgentKind,
  Billing,
  PlanUsage,
  PlanWindow,
} from '@ted/protocol'
import {
  agentDisplayNames,
  antigravityTermsUrl,
  billingNames,
  billings,
  planWarnPercent,
  resetTime,
  runsPaused,
} from '@ted/protocol/health'
import { isBilledAgent } from '@ted/protocol/run'
import { agentBilling } from '@ted/protocol/settings'
import { useEffect, useId, useState } from 'react'
import { AntigravityChatWarning } from '../components/AntigravityChatWarning.tsx'
import dialogStyles from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Help } from '../components/Help.tsx'
import { Loading, LoadingError, Skeleton } from '../components/Loading.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { useAgentHealthState, useApiCost, useEventValue } from '../data.ts'
import { refreshPiModels } from '../pi-models.ts'
import { ago, useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
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

const keyVariables: Record<BilledAgentKind, string> = {
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
    return 'Paused until the limit resets. Ted tries one Run every 15 minutes.'
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
  agent: BilledAgentKind
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
                Ted removes {keyVariables[agent]} from {agentDisplayNames[agent]}’s Runs, and pauses
                it if a Run reports an API key. Ted never asks for or stores a key.
              </Help>
            )}
          </label>
        ))}
      </div>
      {agent === 'antigravity' && <AntigravityChatWarning agent={agent} />}
      {agent === 'antigravity' && billing === 'subscription' && (
        <div className={styles.planNotice} role="note" aria-label="Google’s terms">
          <p className={styles.line}>
            Google’s terms say that using Antigravity through other software, such as Ted, on a
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
            : 'Set GEMINI_API_KEY in your login-shell profile, then choose Check again. Requests are billed separately. Ted never asks for or stores the key.'}
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
          {health.agent === 'pi'
            ? 'Not available'
            : health.agent === 'antigravity'
              ? 'Usage figures are unavailable unless reported by Antigravity.'
              : health.agent === 'claude'
                ? 'Shows once a Run has made a request.'
                : 'Shows once a Run has started.'}
        </p>
      )}
    </div>
  )
}

const dollars = (value: number) =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const millions = (tokens: number) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000)}K`
      : String(tokens)

export function apiCostLines(
  agent: AgentKind,
  report: ApiCostReport | undefined,
): { figure: string; notes: string[] } | undefined {
  if (!report) return undefined
  if (agent === 'antigravity') {
    return { figure: 'Not available', notes: ['Antigravity doesn’t report the tokens it uses.'] }
  }
  const since =
    report.countedFrom !== undefined && report.countedFrom > report.since
      ? [
          `Counted since ${new Date(report.countedFrom).toLocaleDateString()}, when Ted began saving this.`,
        ]
      : []
  const used: AgentApiCost | undefined = report.agents.find((a) => a.agent === agent)
  if (!used || used.runs === 0) return { figure: 'No finished Runs yet', notes: since }
  const runs = `${used.runs} ${used.runs === 1 ? 'Run' : 'Runs'}`
  return {
    figure: `${dollars(used.cost)} for ${runs}`,
    notes: [
      `${millions(used.input)} input and ${millions(used.output)} output tokens.`,
      agent === 'claude'
        ? 'The cost Claude Code reported for each Run.'
        : agent === 'pi'
          ? 'The cost Pi reported for each Run.'
          : 'An estimate from OpenAI’s list prices.',
      ...(used.pricedRuns < used.runs
        ? [`${used.runs - used.pricedRuns} of them reported no cost and are left out.`]
        : []),
      ...since,
    ],
  }
}

function ApiCostSection({
  agent,
  report,
  billing,
}: {
  agent: AgentKind
  report: ApiCostReport | undefined
  billing: Billing | undefined
}) {
  const lines = apiCostLines(agent, report)
  if (!lines) return null
  const days = report?.days ?? 30
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>
          {billing === undefined
            ? `Last ${days} days`
            : billing === 'subscription'
              ? `If it had been on an API key, last ${days} days`
              : `On an API key, last ${days} days`}
        </h3>
        <Help>
          {billing === undefined
            ? `The tokens ${agentDisplayNames[agent]}’s finished Runs used, and the cost it reported for them.`
            : billing === 'subscription'
              ? `What ${agentDisplayNames[agent]}’s finished Runs would have cost on an API key, at API prices.`
              : `What ${agentDisplayNames[agent]}’s finished Runs cost on your API key.`}
        </Help>
      </div>
      <p className={styles.line}>{lines.figure}</p>
      {lines.notes.map((note) => (
        <p key={note} className={styles.line}>
          {note}
        </p>
      ))}
    </div>
  )
}

function AgentCard({
  health,
  enabled,
  lastEnabled,
  activeRuns,
  changing,
  onToggle,
  billing,
  opened,
  onFix,
  onCheck,
  onBilling,
  planAccepted,
  onAcceptPlan,
  apiCost,
  checking,
  error,
}: {
  apiCost: ApiCostReport | undefined
  health: AgentHealth
  enabled: boolean
  lastEnabled: boolean
  activeRuns: number
  changing: boolean
  onToggle: (enabled: boolean) => void
  billing: Billing | undefined
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
  const stopping = enabled && stopsWork(health)
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
          {enabled && <HealthIcon ready={ready} />}
          <h2 className={styles.name}>{name}</h2>
          <StatusChip
            tone={!enabled ? 'neutral' : ready ? 'success' : stopping ? 'failed' : 'neutral'}
          >
            {enabled ? chip : 'Off'}
          </StatusChip>
          <span
            title={lastEnabled ? 'Enable another Provider before turning this one off.' : undefined}
          >
            <Switch
              label={`Use ${name}`}
              checked={enabled}
              disabled={changing || lastEnabled}
              onChange={onToggle}
            />
          </span>
          <span className={styles.spacer} />
          {enabled && health.fix && (
            <Button onClick={() => ted.copyText(health.fix?.command ?? '')}>Copy command</Button>
          )}
          {enabled && (
            <Button onClick={onCheck} disabled={checking}>
              {checking ? <Loading compact label="Checking…" /> : 'Check again'}
            </Button>
          )}
          {enabled && health.fix && (
            <Button primary onClick={onFix}>
              {health.fix.label}
            </Button>
          )}
        </div>
        {!enabled && (
          <p className={styles.line}>
            Off for new Runs.{' '}
            {billing === undefined
              ? 'Saved choices are kept.'
              : 'Saved choices and billing are kept.'}
            {activeRuns > 0 ? ` ${activeRuns} existing Runs kept going.` : ''}
          </p>
        )}
        {lastEnabled && (
          <p className={styles.line}>Enable another Provider before turning this one off.</p>
        )}
        {enabled && (
          <div className={styles.lines}>
            <p className={styles.line}>{facts}</p>
            {signedIn && health.account !== undefined && (
              <p className={styles.line}>{health.account}</p>
            )}
            {health.state === 'unavailable' && <p className={styles.line}>{health.reason}</p>}
            {health.state === 'signed-out' && <p className={styles.line}>Not signed in.</p>}
            {health.state === 'too-old' && (
              <p className={styles.line}>
                This version is older than Ted supports. Ted never updates it without asking.
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
                  Runs stay open and carry on by themselves. Ted never switches them to another
                  Provider; change the Task Lead field if you want to.
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
                Opened <code className={styles.code}>{health.fix.command}</code> in {terminalName()}
                . Checking again every 5 seconds…
              </p>
            )}
            {error !== undefined && <p className={`${styles.line} ${styles.error}`}>{error}</p>}
          </div>
        )}
      </div>
      {enabled && (
        <>
          <ApiCostSection agent={health.agent} report={apiCost} billing={billing} />
          {billing !== undefined && isBilledAgent(health.agent) && (
            <BillingChoice
              agent={health.agent}
              billing={billing}
              onChange={onBilling}
              planAccepted={planAccepted}
              onAcceptPlan={onAcceptPlan}
            />
          )}
          <PlanUsageSection health={health} />
        </>
      )}
    </section>
  )
}

export function AgentsPage({ settings }: SettingsPageProps) {
  const resource = useAgentHealthState()
  const apiCost = useApiCost()
  const health = resource.health
  const availability = useEventValue<AgentAvailability[]>({
    initial: [],
    load: ted.agentAvailability,
    event: (event) =>
      ['settings-changed', 'run-updated'].includes(event.type) ? 'reload' : undefined,
  })
  const [confirmation, setConfirmation] = useState<AgentAvailability>()
  const [changing, setChanging] = useState(false)
  const [toggleError, setToggleError] = useState<string>()
  async function toggle(agent: AgentKind, enabled: boolean, existing?: 'keep' | 'stop') {
    setChanging(true)
    setToggleError(undefined)
    try {
      const result = await ted.changeAgentAvailability({
        agent,
        enabled,
        ...(existing && { existing }),
        ...(confirmation && {
          confirmedRunIds: [...confirmation.runs, ...confirmation.additionalRuns].map(
            (run) => run.id,
          ),
        }),
      })
      if (result.confirmationRequired) setConfirmation(result.availability)
      else {
        setConfirmation(undefined)
        void availability.refresh()
      }
    } catch (error) {
      setToggleError(readableError(error))
    } finally {
      setChanging(false)
    }
  }
  const [opened, setOpened] = useState<Partial<Record<AgentKind, boolean>>>({})
  const [checking, setChecking] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<AgentKind, string>>>({})
  const waiting = health.some(
    (h) => settings.enabledAgents.includes(h.agent) && opened[h.agent] && h.state !== 'ready',
  )
  const anyProblem = health.some(
    (h) => settings.enabledAgents.includes(h.agent) && h.state !== 'ready',
  )

  const check = async () => {
    setChecking(true)
    try {
      await ted.checkAgentHealth()
    } catch (error) {
      console.error(error)
    } finally {
      await refreshPiModels()
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
    <SettingsPage title="Providers">
      {toggleError && (
        <p role="alert" className={styles.error}>
          {toggleError}
        </p>
      )}
      {confirmation && (
        <Dialog
          onClose={() => {
            if (!changing) {
              setConfirmation(undefined)
              setToggleError(undefined)
            }
          }}
        >
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                Turn off {agentDisplayNames[confirmation.agent]}?
              </h2>
              <p className={dialogStyles.text}>
                {confirmation.runs.length} existing Runs use {agentDisplayNames[confirmation.agent]}
                . Queued work will wait until it is enabled again.
              </p>
              {confirmation.additionalRuns.length > 0 && (
                <>
                  <p className={dialogStyles.text}>
                    Stopping a Task Lead also stops these {confirmation.additionalRuns.length} Runs:
                  </p>
                  <ul>
                    {confirmation.additionalRuns.map((run) => (
                      <li key={run.id}>
                        {run.name} · {agentDisplayNames[run.agent]}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className={dialogStyles.text}>
                Stopped Tasks need Resume. Re-enabling a Provider does not resume stopped work.
              </p>
              {toggleError && (
                <p role="alert" className={styles.error}>
                  {toggleError}
                </p>
              )}
              <div className={dialogStyles.actions}>
                <Button disabled={changing} onClick={() => setConfirmation(undefined)}>
                  Cancel
                </Button>
                <Button
                  disabled={changing}
                  onClick={() => toggle(confirmation.agent, false, 'stop')}
                >
                  Turn off &amp; stop{' '}
                  {confirmation.runs.length + confirmation.additionalRuns.length} Runs
                </Button>
                <Button
                  primary
                  disabled={changing}
                  onClick={() => toggle(confirmation.agent, false, 'keep')}
                >
                  Turn off &amp; keep going
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
      <div className={styles.cards}>
        {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
        {!resource.loaded && health.length === 0 && !resource.error && (
          <Skeleton shape="settings" label="Checking your Providers…" />
        )}
        {health.map((h) => (
          <AgentCard
            key={h.agent}
            health={h}
            enabled={settings.enabledAgents.includes(h.agent)}
            lastEnabled={
              settings.enabledAgents.length === 1 && settings.enabledAgents.includes(h.agent)
            }
            activeRuns={
              availability.value.find((entry) => entry.agent === h.agent)?.runs.length ?? 0
            }
            changing={changing}
            onToggle={(enabled) => toggle(h.agent, enabled)}
            billing={agentBilling(settings.billing, h.agent)}
            opened={opened[h.agent] === true && h.state !== 'ready'}
            onFix={() => fix(h.agent)}
            onCheck={() => check()}
            onBilling={(billing) => chooseBilling(h.agent, billing)}
            planAccepted={settings.antigravityPlanAccepted}
            apiCost={apiCost}
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
        <SettingRow setting="app.agents.restart-idle-runs">
          <Switch
            label="Restart idle Runs onto new Provider versions"
            checked={settings.restartIdleRuns}
            onChange={(restartIdleRuns) => ted.updateSettings({ restartIdleRuns })}
          />
        </SettingRow>
      </SettingsGroup>
      <AgentDefaults />
    </SettingsPage>
  )
}
