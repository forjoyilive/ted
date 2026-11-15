import type {
  GitHealth,
  GitHubCli,
  GitHubHost,
  IntegrationFix,
  IntegrationRemedy,
  IntegrationsHealth,
} from '@ted/protocol'
import { minGhVersion } from '@ted/protocol/integrations'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { StatusChip, type StatusTone } from '../components/StatusChip.tsx'
import { useEventValue } from '../data.ts'
import { ted } from '../ted.ts'
import { AsanaGroup } from './AsanaGroup.tsx'
import { Button, SettingRow, SettingsGroup, SettingsPage, Switch } from './controls.tsx'
import styles from './integrations.module.css'
import { LinearGroup } from './LinearGroup.tsx'
import type { SettingsPageProps } from './sections.tsx'
import settingsStyles from './settings.module.css'

const inTerminal = /Mac/.test(navigator.platform) ? 'in Terminal' : 'in your terminal'

type Tone = 'ok' | 'warn' | 'stop'

const chipTone: Record<Tone, StatusTone> = { ok: 'success', warn: 'waiting', stop: 'failed' }

export function useIntegrations() {
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<string>()

  const { value: health, refresh } = useEventValue<IntegrationsHealth | undefined>({
    initial: undefined,
    load: ted.getIntegrations,
    event: (event) => (event.type === 'integrations-checked' ? () => event.health : undefined),
    changed: () => setProblem(undefined),
    error: (error) => setProblem(message(error)),
  })

  const checkAgain = useCallback(() => {
    setChecking(true)
    setProblem(undefined)
    return refresh(ted.checkIntegrations).finally(() => setChecking(false))
  }, [refresh])

  return { health, checking, problem, checkAgain }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function IntegrationsPage({ settings }: Pick<SettingsPageProps, 'settings'>) {
  const { health, checking, problem, checkAgain } = useIntegrations()
  const [opened, setOpened] = useState<{ key: string; text: string }>()

  useEffect(() => {
    if (!opened) return
    window.addEventListener('focus', checkAgain)
    return () => window.removeEventListener('focus', checkAgain)
  }, [opened, checkAgain])

  const runFix = (key: string, fix: IntegrationFix, host?: string) => {
    setOpened(undefined)
    return ted.runFix({ fix, ...(host !== undefined && { host }) }).then(
      (result) =>
        setOpened({
          key,
          text:
            'url' in result
              ? 'Opened instructions in your browser. Follow them, then choose Check again.'
              : `Opened ${result.command} ${inTerminal}. Checking again every 5 seconds…`,
        }),
      (error: unknown) => setOpened({ key, text: message(error) }),
    )
  }

  const note = (key: string) => (opened?.key === key ? opened.text : undefined)
  const checkButton = (
    <Button onClick={checkAgain} disabled={checking}>
      Check again
    </Button>
  )

  return (
    <SettingsPage title="Integrations">
      {problem !== undefined && <LoadingError error={problem} retry={checkAgain} />}
      <SettingsGroup setting="app.integrations.github">
        {!health ? (
          problem ? null : (
            <LoadingRow />
          )
        ) : health.github.cli.state !== 'ready' ? (
          <CliRow
            cli={health.github.cli}
            note={note('cli')}
            onFix={(fix) => runFix('cli', fix)}
            checkButton={checkButton}
          />
        ) : (
          health.github.hosts.map((host) => (
            <HostRow
              key={host.host}
              host={host}
              cli={health.github.cli}
              note={note(host.host)}
              onFix={(fix) => runFix(host.host, fix, host.host)}
              checkButton={checkButton}
            />
          ))
        )}
        <SettingRow setting="app.integrations.github.sync">
          <Switch
            label="Keep issues up to date"
            checked={settings.githubIssueSync}
            onChange={(on) => void ted.updateSettings({ githubIssueSync: on })}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup setting="app.integrations.git">
        {!health ? (
          problem ? null : (
            <LoadingRow />
          )
        ) : (
          <GitRow
            git={health.git}
            note={note('git')}
            onFix={(fix) => runFix('git', fix)}
            checkButton={checkButton}
          />
        )}
      </SettingsGroup>
      <AsanaGroup />
      <LinearGroup
        sync={settings.linearSync}
        teams={settings.linearSyncTeams}
        declined={settings.linearSyncDeclined}
      />
    </SettingsPage>
  )
}

function LoadingRow() {
  return <Skeleton shape="settings" rows={1} framed={false} label="Loading integrations…" />
}

function HealthRow({
  tone,
  title,
  chip,
  lines,
  controls,
}: {
  tone: Tone
  title: string
  chip?: string
  lines: ReactNode
  controls: ReactNode
}) {
  return (
    <div className={styles.row}>
      <span className={`${styles.status} ${styles[tone]}`} role="img" aria-label={chip ?? 'Ready'}>
        {tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '✕'}
      </span>
      <div className={styles.text}>
        <div className={styles.titleLine}>
          <span className={settingsStyles.rowTitle}>{title}</span>
          {chip !== undefined && <StatusChip tone={chipTone[tone]}>{chip}</StatusChip>}
        </div>
        {lines}
      </div>
      <div className={settingsStyles.rowControls}>{controls}</div>
    </div>
  )
}

function FixButtons({
  fix,
  kind,
  onFix,
}: {
  fix: IntegrationRemedy
  kind: IntegrationFix
  onFix: (fix: IntegrationFix) => void
}) {
  return (
    <>
      {'command' in fix && <Button onClick={() => ted.copyText(fix.command)}>Copy command</Button>}
      <Button onClick={() => onFix(kind)}>{fix.label}</Button>
    </>
  )
}

function Note({ text }: { text: string | undefined }) {
  return text === undefined ? null : (
    <p className={styles.note} role="status">
      {text}
    </p>
  )
}

const join = (...parts: (string | undefined | false)[]) =>
  parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ')

function tokenSource(source: string | undefined): string | undefined {
  if (source === undefined) return undefined
  if (source === 'keyring') return 'token in the keyring'
  if (source === 'oauth_token') return 'token in gh’s config file'
  return `token from ${source}`
}

function protocol(name: string | undefined): string | undefined {
  if (name === 'https') return 'git over HTTPS'
  if (name === 'ssh') return 'git over SSH'
  return name === undefined ? undefined : `git over ${name}`
}

function HostRow({
  host,
  cli,
  note,
  onFix,
  checkButton,
}: {
  host: GitHubHost
  cli: GitHubCli
  note: string | undefined
  onFix: (fix: IntegrationFix) => void
  checkButton: ReactNode
}) {
  const usedBy = host.usedBy.length > 0 ? `Used by ${host.usedBy.join(', ')}` : undefined
  const scopes =
    host.scopes.length > 0
      ? `${usedBy ? 'scopes' : 'Scopes'}: ${host.scopes.join(', ')}`
      : undefined
  const meta = join(usedBy, scopes, cli.version && `gh ${cli.version}`, cli.path)
  const signedIn = join(
    host.login && `Signed in as ${host.login}`,
    tokenSource(host.tokenSource),
    protocol(host.gitProtocol),
  )

  if (host.state === 'ready') {
    return (
      <HealthRow
        tone="ok"
        title={host.host}
        chip="Ready"
        controls={checkButton}
        lines={
          <>
            <p className={styles.detail}>{signedIn}</p>
            <p className={styles.meta}>{meta}</p>
          </>
        }
      />
    )
  }
  if (host.state === 'missing-workflow-scope') {
    return (
      <HealthRow
        tone="warn"
        title={host.host}
        chip="Missing workflow scope"
        controls={
          <>
            {host.fix && <FixButtons fix={host.fix} kind="gh-refresh" onFix={onFix} />}
            {checkButton}
          </>
        }
        lines={
          <>
            <p className={styles.detail}>{signedIn}</p>
            <p className={styles.warning}>
              Can’t push changes to GitHub Actions workflows. Add permission opens{' '}
              <span className={styles.nowrap}>{host.fix?.command}</span> {inTerminal}.
            </p>
            <p className={styles.meta}>{meta}</p>
            <Note text={note} />
          </>
        }
      />
    )
  }
  if (host.state === 'signed-out') {
    return (
      <HealthRow
        tone="stop"
        title={host.host}
        chip="Signed out"
        controls={
          <>
            {host.fix && <FixButtons fix={host.fix} kind="gh-login" onFix={onFix} />}
            {checkButton}
          </>
        }
        lines={
          <>
            <p className={styles.detail}>
              {host.login
                ? `${host.login}’s login no longer works`
                : 'The GitHub CLI isn’t signed in to this host'}
            </p>
            <p className={styles.danger}>
              Needed to add a Factory and to merge. Sign in opens{' '}
              <span className={styles.nowrap}>{host.fix?.command}</span> {inTerminal}.
            </p>
            <p className={styles.meta}>{meta}</p>
            <Note text={note} />
          </>
        }
      />
    )
  }
  return (
    <HealthRow
      tone="warn"
      title={host.host}
      chip="Couldn’t check"
      controls={checkButton}
      lines={
        <>
          <p className={styles.detail}>{host.error ?? 'The GitHub CLI didn’t answer.'}</p>
          <p className={styles.meta}>{meta}</p>
        </>
      }
    />
  )
}

function CliRow({
  cli,
  note,
  onFix,
  checkButton,
}: {
  cli: GitHubCli
  note: string | undefined
  onFix: (fix: IntegrationFix) => void
  checkButton: ReactNode
}) {
  if (cli.state === 'failed') {
    return (
      <HealthRow
        tone="stop"
        title="GitHub CLI"
        chip="Not working"
        controls={checkButton}
        lines={<p className={styles.detail}>{join(cli.error, cli.path)}</p>}
      />
    )
  }
  const tooOld = cli.state === 'too-old'
  return (
    <HealthRow
      tone="stop"
      title="GitHub CLI"
      chip={tooOld ? 'Too old' : 'Not installed'}
      controls={
        <>
          {cli.fix && (
            <FixButtons fix={cli.fix} kind={tooOld ? 'gh-update' : 'gh-install'} onFix={onFix} />
          )}
          {checkButton}
        </>
      }
      lines={
        <>
          <p className={styles.detail}>
            {tooOld
              ? `gh ${cli.version} is older than ${minGhVersion}, the oldest version TED supports`
              : 'TED reaches GitHub through the GitHub CLI, gh'}
          </p>
          <p className={styles.danger}>Needed to add a Factory and to merge.</p>
          {cli.fix &&
            ('command' in cli.fix ? (
              <code className={styles.command}>{cli.fix.command}</code>
            ) : (
              <p className={styles.detail}>
                Follow the official Linux instructions, then choose Check again.
              </p>
            ))}
          {cli.path !== undefined && <p className={styles.meta}>{cli.path}</p>}
          <Note text={note} />
        </>
      }
    />
  )
}

function GitRow({
  git,
  note,
  onFix,
  checkButton,
}: {
  git: GitHealth
  note: string | undefined
  onFix: (fix: IntegrationFix) => void
  checkButton: ReactNode
}) {
  if (git.state === 'not-installed') {
    return (
      <HealthRow
        tone="stop"
        title="Git"
        chip="Not installed"
        controls={
          <>
            {git.fix && <FixButtons fix={git.fix} kind="git-install" onFix={onFix} />}
            {checkButton}
          </>
        }
        lines={
          <>
            <p className={styles.detail}>TED needs Git to clone repos and make worktrees.</p>
            {git.fix &&
              ('command' in git.fix ? (
                <code className={styles.command}>{git.fix.command}</code>
              ) : (
                <p className={styles.detail}>
                  Follow the official Linux instructions, then choose Check again.
                </p>
              ))}
            <Note text={note} />
          </>
        }
      />
    )
  }
  const identity = [git.name, git.email && `<${git.email}>`].filter(Boolean).join(' ')
  const title = `Git ${shortVersion(git.version)}`
  if (git.state === 'no-identity') {
    const commands = git.copy ?? []
    return (
      <HealthRow
        tone="warn"
        title={title}
        chip="No name or email"
        controls={
          <>
            <Button onClick={() => ted.copyText(commands.join('\n'))}>Copy commands</Button>
            {checkButton}
          </>
        }
        lines={
          <>
            <p className={styles.detail}>{join(identity, git.path)}</p>
            <p className={styles.warning}>
              Commits need a name and email. Run these in a terminal, with your own details:
            </p>
            {commands.map((command) => (
              <code key={command} className={styles.command}>
                {command}
              </code>
            ))}
          </>
        }
      />
    )
  }
  return (
    <HealthRow
      tone="ok"
      title={title}
      controls={checkButton}
      lines={<p className={styles.detail}>{join(identity, git.path)}</p>}
    />
  )
}

function shortVersion(version: string | undefined): string {
  return version?.split('.').slice(0, 2).join('.') ?? ''
}
