import type {
  AgentHealth,
  AgentKind,
  GitHealth,
  IntegrationFix,
  IntegrationRemedy,
  IntegrationsHealth,
  MachineSettings,
} from '@ted/protocol'
import { agentDisplayNames } from '@ted/protocol/health'
import { minGhVersion } from '@ted/protocol/integrations'
import { agentKinds } from '@ted/protocol/run'
import { type ReactNode, useEffect, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { Loading } from '../components/Loading.tsx'
import { StatusChip, type StatusTone } from '../components/StatusChip.tsx'
import { useAgentHealth } from '../data.ts'
import { reportingLabel, reportingShort } from '../reporting.ts'
import { useIntegrations } from '../settings/IntegrationsPage.tsx'
import { ted } from '../ted.ts'
import styles from './FirstLaunch.module.css'
import { OnboardingFrame } from './OnboardingFrame.tsx'

export const recheckEveryMs = 5_000
const recheckForMs = 10 * 60 * 1000

const firstLaunchHost = 'github.com'

type Tone = 'ok' | 'warn' | 'stop' | 'checking'

const chipTones: Record<Tone, StatusTone> = {
  ok: 'success',
  warn: 'waiting',
  stop: 'failed',
  checking: 'neutral',
}

const terminalName = () => (/Mac/.test(navigator.userAgent) ? 'Terminal' : 'your terminal')

const opened = (command: string) =>
  `Opened ${command} in ${terminalName()}. Checking again every 5 seconds…`

const join = (...parts: (string | undefined)[]) =>
  parts.filter((p): p is string => p !== undefined && p !== '').join(' · ')

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const usable: readonly AgentHealth['state'][] = [
  'ready',
  'wrong-credential',
  'usage-limit',
  'offline',
]

export function canContinue(agents: readonly AgentHealth[], git: GitHealth | undefined): boolean {
  return git?.state === 'ready' && agents.some((h) => usable.includes(h.state))
}

function StatusIcon({ tone }: { tone: Tone }) {
  return (
    <svg className={`${styles.icon} ${styles[tone]}`} viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="9" fill="currentColor" />
      {tone === 'ok' && (
        <path
          className={styles.glyph}
          d="M5.4 9.2L7.8 11.6L12.6 6.6"
          fill="none"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {(tone === 'warn' || tone === 'stop') && (
        <>
          <rect className={styles.glyphFill} x="8.1" y="4.4" width="1.8" height="6" rx="0.9" />
          <circle className={styles.glyphFill} cx="9" cy="13" r="1.05" />
        </>
      )}
    </svg>
  )
}

function Row({
  name,
  tone,
  chip,
  help,
  detail,
  meta,
  actions,
  below,
  note,
}: {
  name: string
  tone: Tone
  chip: string
  help?: ReactNode
  detail?: ReactNode
  meta?: string | undefined
  actions?: ReactNode
  below?: ReactNode
  note?: string | undefined
}) {
  return (
    <fieldset className={styles.row} aria-label={name} data-tone={tone}>
      <div className={styles.head}>
        {tone === 'checking' ? <Loading compact label={chip} /> : <StatusIcon tone={tone} />}
        <span className={styles.name}>{name}</span>
        {help !== undefined && <Help>{help}</Help>}
        {tone !== 'checking' && <StatusChip tone={chipTones[tone]}>{chip}</StatusChip>}
        <span className={styles.spacer} />
        {actions !== undefined && <div className={styles.actions}>{actions}</div>}
      </div>
      <div className={styles.body}>
        {detail !== undefined && <p className={styles.detail}>{detail}</p>}
        {meta !== undefined && meta !== '' && <p className={styles.meta}>{meta}</p>}
        {below}
        {note !== undefined && (
          <p className={styles.note} role="status">
            {note}
          </p>
        )}
      </div>
    </fieldset>
  )
}

function CommandLine({
  command,
  onCopy,
  children,
}: {
  command: string
  onCopy: () => unknown
  children?: ReactNode
}) {
  return (
    <div className={styles.command}>
      <code className={styles.code}>{command}</code>
      <div className={styles.actions}>
        <Button onClick={onCopy}>Copy</Button>
        {children}
      </div>
    </div>
  )
}

interface RowActions {
  copy: (text: string) => Promise<void>
  watch: () => void
}

function AgentRow({
  agent,
  health,
  note,
  error,
  onFix,
  onBilling,
  actions,
}: {
  agent: AgentKind
  health: AgentHealth | undefined
  note: string | undefined
  error: string | undefined
  onFix: () => void
  onBilling: (billing: 'subscription' | 'api-key') => void
  actions: RowActions
}) {
  const name = agentDisplayNames[agent]
  const shown = error ?? note
  if (!health) return <Row name={name} tone="checking" chip="Checking…" />
  const fix = health.fix
  const fixButtons = fix && (
    <>
      <Button size="small" onClick={() => actions.copy(fix.command)}>
        Copy command
      </Button>
      <Button size="small" variant="primary" onClick={onFix}>
        {fix.label}
      </Button>
    </>
  )
  if (health.state === 'wrong-credential') {
    return (
      <Row
        name={name}
        tone="warn"
        chip="Signed in with an API key"
        detail={
          health.keySource ??
          `${name} is signed in with an API key. Choose how ${name} Runs are billed before the first Run.`
        }
        meta={join(health.version, health.path)}
        below={
          <div className={styles.buttons}>
            <Button onClick={() => onBilling('api-key')}>Use API-key billing</Button>
            <Button onClick={() => onBilling('subscription')}>
              Sign in with a subscription instead
            </Button>
          </div>
        }
        note={shown}
      />
    )
  }
  if (health.state === 'ready') {
    return (
      <Row
        name={name}
        tone="ok"
        chip="Ready"
        detail={join(health.version, health.account)}
        meta={health.path}
      />
    )
  }
  if (health.state === 'not-installed') {
    return (
      <Row
        name={name}
        tone="stop"
        chip="Not installed"
        help="Continue needs only one Provider. Install this one too if you want Ted to use it."
        below={
          fix && (
            <CommandLine command={fix.command} onCopy={() => actions.copy(fix.command)}>
              <Button onClick={onFix}>Open Terminal</Button>
            </CommandLine>
          )
        }
        note={shown}
      />
    )
  }
  if (health.state === 'signed-out') {
    return (
      <Row
        name={name}
        tone="stop"
        chip="Signed out"
        detail={join(health.version, 'not signed in')}
        meta={health.path}
        actions={fixButtons}
        note={shown}
      />
    )
  }
  if (health.state === 'too-old') {
    return (
      <Row
        name={name}
        tone="stop"
        chip="Too old"
        detail={`${health.version ?? 'This version'} is older than ${health.minimumVersion}, the oldest version Ted supports. Ted never updates it without asking.`}
        meta={health.path}
        actions={fixButtons}
        note={shown}
      />
    )
  }
  return (
    <Row
      name={name}
      tone="stop"
      chip={health.reason ?? 'Can’t run'}
      detail={join(health.version, health.account)}
      meta={health.path}
      actions={fixButtons}
      note={shown}
    />
  )
}

function GitHubRow({
  health,
  note,
  onFix,
  actions,
}: {
  health: IntegrationsHealth | undefined
  note: string | undefined
  onFix: (fix: IntegrationFix, host?: string) => void
  actions: RowActions
}) {
  const name = 'GitHub'
  if (!health) return <Row name={name} tone="checking" chip="Checking…" />
  const { cli } = health.github
  const host = health.github.hosts.find((h) => h.host === firstLaunchHost) ?? health.github.hosts[0]
  const meta = join(cli.version && `gh ${cli.version}`, cli.path)
  const buttons = (fix: IntegrationRemedy, kind: IntegrationFix, hostName?: string) => (
    <>
      {'command' in fix && (
        <Button size="small" onClick={() => actions.copy(fix.command)}>
          Copy command
        </Button>
      )}
      <Button size="small" variant="primary" onClick={() => onFix(kind, hostName)}>
        {fix.label}
      </Button>
    </>
  )
  if (cli.state === 'not-installed') {
    return (
      <Row
        name={name}
        tone="stop"
        chip="GitHub CLI not installed"
        detail="Needed to add a Factory. Ted reaches GitHub through the GitHub CLI, gh."
        below={
          cli.fix &&
          ('url' in cli.fix ? (
            <Button onClick={() => onFix('gh-install')}>{cli.fix.label}</Button>
          ) : (
            <CommandLine
              command={cli.fix.command}
              onCopy={() => actions.copy(cli.fix && 'command' in cli.fix ? cli.fix.command : '')}
            >
              <Button onClick={() => onFix('gh-install')}>Open Terminal</Button>
            </CommandLine>
          ))
        }
        note={note}
      />
    )
  }
  if (cli.state === 'too-old') {
    return (
      <Row
        name={name}
        tone="stop"
        chip="Too old"
        detail={`Needed to add a Factory. gh ${cli.version} is older than ${minGhVersion}, the oldest version Ted supports.`}
        meta={cli.path}
        actions={cli.fix && buttons(cli.fix, 'gh-update')}
        note={note}
      />
    )
  }
  if (cli.state === 'failed' || !host || host.state === 'failed') {
    return (
      <Row
        name={name}
        tone="warn"
        chip="Couldn’t check"
        detail={`Needed to add a Factory. ${host?.error ?? cli.error ?? 'The GitHub CLI didn’t answer.'}`}
        meta={meta}
      />
    )
  }
  if (host.state === 'signed-out') {
    return (
      <Row
        name={name}
        tone="stop"
        chip="Signed out"
        detail={`Needed to add a Factory. The GitHub CLI is installed but not signed in to ${host.host}.`}
        meta={meta}
        actions={host.fix && buttons(host.fix, 'gh-login', host.host)}
        note={note}
      />
    )
  }
  const signedIn = join(host.login && `Signed in as ${host.login}`, host.host)
  if (host.state === 'missing-workflow-scope') {
    return (
      <Row
        name={name}
        tone="warn"
        chip="Missing workflow scope"
        detail={`${signedIn}. Ted can’t push changes to GitHub Actions workflows without it.`}
        meta={meta}
        actions={host.fix && buttons(host.fix, 'gh-refresh', host.host)}
        note={note}
      />
    )
  }
  return <Row name={name} tone="ok" chip="Ready" detail={signedIn} meta={meta} />
}

function GitRow({
  git,
  note,
  onFix,
  actions,
}: {
  git: GitHealth | undefined
  note: string | undefined
  onFix: (fix: IntegrationFix) => void
  actions: RowActions
}) {
  const name = 'Git'
  if (!git) return <Row name={name} tone="checking" chip="Checking…" />
  const version = git.version?.split('.').slice(0, 2).join('.')
  if (git.state === 'not-installed') {
    return (
      <Row
        name={name}
        tone="stop"
        chip="Not installed"
        detail="Ted needs Git to clone repos and make worktrees."
        below={
          git.fix &&
          ('url' in git.fix ? (
            <Button onClick={() => onFix('git-install')}>{git.fix.label}</Button>
          ) : (
            <CommandLine
              command={git.fix.command}
              onCopy={() => actions.copy(git.fix && 'command' in git.fix ? git.fix.command : '')}
            >
              <Button onClick={() => onFix('git-install')}>Open Terminal</Button>
            </CommandLine>
          ))
        }
        note={note}
      />
    )
  }
  if (git.state === 'no-identity') {
    return (
      <Row
        name={name}
        tone="warn"
        chip="No name or email set"
        detail="Agents need a name and email to commit. Run these in your terminal:"
        meta={join(version, git.path)}
        below={(git.copy ?? []).map((command) => (
          <CommandLine
            key={command}
            command={command}
            onCopy={() => actions.copy(command).then(() => actions.watch())}
          />
        ))}
      />
    )
  }
  const identity = [git.name, git.email && `<${git.email}>`].filter(Boolean).join(' ')
  return <Row name={name} tone="ok" chip="Ready" detail={join(version, identity)} meta={git.path} />
}

export function FirstLaunch({
  settings,
  startAtLogin,
  onStartAtLogin,
  reporting,
  onReporting,
  footer,
}: {
  settings: MachineSettings
  startAtLogin: boolean
  onStartAtLogin: (on: boolean) => void
  reporting: boolean
  onReporting: (on: boolean) => void
  footer: (ready: boolean) => ReactNode
}) {
  const agents = useAgentHealth()
  const { health: integrations } = useIntegrations()
  const [watchingSince, setWatchingSince] = useState<number>()
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const ready = canContinue(agents, integrations?.git)

  useEffect(() => {
    const checkAll = () => {
      void ted.checkAgentHealth().catch(() => undefined)
      return ted.checkIntegrations().catch(() => undefined)
    }
    window.addEventListener('focus', checkAll)
    if (watchingSince === undefined) return () => window.removeEventListener('focus', checkAll)
    const timer = setInterval(() => {
      if (Date.now() - watchingSince > recheckForMs) setWatchingSince(undefined)
      else checkAll()
    }, recheckEveryMs)
    return () => {
      window.removeEventListener('focus', checkAll)
      clearInterval(timer)
    }
  }, [watchingSince])

  const watch = () => setWatchingSince(Date.now())
  const rowActions: RowActions = {
    copy: (text) => ted.copyText(text),
    watch,
  }
  const setFor = (key: string, note?: string, error?: string) => {
    setNotes(({ [key]: _, ...rest }) => (note === undefined ? rest : { ...rest, [key]: note }))
    setErrors(({ [key]: _, ...rest }) => (error === undefined ? rest : { ...rest, [key]: error }))
  }

  async function fixAgent(agent: AgentKind) {
    setFor(agent)
    try {
      const health = await ted.fixAgent(agent)
      setFor(agent, health.fix ? opened(health.fix.command) : undefined)
      watch()
    } catch (error) {
      setFor(agent, undefined, message(error))
    }
  }

  async function chooseBilling(health: AgentHealth, billing: 'subscription' | 'api-key') {
    setFor(health.agent)
    try {
      if (billing === 'subscription') await fixAgent(health.agent)
      else await ted.updateSettings({ billing: { ...settings.billing, [health.agent]: billing } })
    } catch (error) {
      setFor(health.agent, undefined, message(error))
    }
  }

  function runFix(key: string, fix: IntegrationFix, host?: string) {
    setFor(key)
    return ted.runFix({ fix, ...(host !== undefined && { host }) }).then(
      (result) => {
        setFor(
          key,
          'url' in result
            ? 'Opened instructions in your browser. Follow them, then return to Ted. Checking again every 5 seconds…'
            : opened(result.command),
        )
        watch()
      },
      (error: unknown) => setFor(key, message(error)),
    )
  }

  const agentFor = (agent: AgentKind) => agents.find((h) => h.agent === agent)
  const noteFor = (key: string) =>
    key === 'github' &&
    integrations?.github.cli.state === 'ready' &&
    integrations.github.hosts.every((h) => h.state === 'ready')
      ? undefined
      : notes[key]

  return (
    <OnboardingFrame label="Set up Ted" footer={footer(ready)}>
      <h1 className={styles.title}>
        Set up Ted
        <Help>
          Ted runs Claude Code, Codex, Antigravity and Pi with your own logins. It never sees your
          passwords or tokens.
        </Help>
      </h1>
      <div className={styles.rows}>
        {agentKinds.map((agent) => {
          const health = agentFor(agent)
          const good = health?.state === 'ready'
          return (
            <AgentRow
              key={agent}
              agent={agent}
              health={health}
              note={good ? undefined : notes[agent]}
              error={errors[agent]}
              onFix={() => fixAgent(agent)}
              onBilling={(billing) => health && chooseBilling(health, billing)}
              actions={rowActions}
            />
          )
        })}
        <GitHubRow
          health={integrations}
          note={noteFor('github')}
          onFix={(fix, host) => runFix('github', fix, host)}
          actions={rowActions}
        />
        <GitRow
          git={integrations?.git}
          note={integrations?.git.state === 'ready' ? undefined : notes.git}
          onFix={(fix) => runFix('git', fix)}
          actions={rowActions}
        />
      </div>
      <label className={styles.login}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={startAtLogin}
          onChange={(event) => onStartAtLogin(event.target.checked)}
        />
        Start Ted in the background when you log in
      </label>
      <label className={styles.reporting}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={reporting}
          onChange={(event) => onReporting(event.target.checked)}
        />
        <span>
          {reportingLabel}
          <span className={styles.reportingNote}>{reportingShort}</span>
        </span>
      </label>
      {/Mac/.test(navigator.userAgent) && (
        <p className={styles.permissions}>
          macOS may ask whether Ted can use a folder or an attached drive. That means an agent, or a
          command it ran, tried to read it: macOS counts them as Ted. You can say no.
        </p>
      )}
    </OnboardingFrame>
  )
}
