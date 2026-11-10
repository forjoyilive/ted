import type { Factory, LinearStatus, MachineSettings } from '@ted/protocol'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { Help } from '../components/Help.tsx'
import { useFactories } from '../data.ts'
import { ted } from '../ted.ts'
import { Button, SettingRow, SettingsGroup, Switch } from './controls.tsx'
import styles from './linear.module.css'
import settingsStyles from './settings.module.css'

export function LinearGroup({
  sync,
  teams,
  declined,
}: {
  sync: boolean
  teams: MachineSettings['linearSyncTeams']
  declined: MachineSettings['linearSyncDeclined']
}) {
  const factories = useFactories()
  const [status, setStatus] = useState<LinearStatus>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [keyFile, setKeyFile] = useState('~/.ted/secrets/linear-api-key')
  const fieldId = useId()

  useEffect(() => {
    let current = true
    ted.getLinear().then(
      (next) => {
        if (current) setStatus(next)
      },
      (error: unknown) => {
        if (current) setProblem(message(error))
      },
    )
    ted.tedFolder().then(
      ({ path }) => {
        if (current) setKeyFile(`${path}secrets/linear-api-key`)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [])

  function act(label: string, work: () => Promise<LinearStatus>, clearDraft = false) {
    setBusy(label)
    setProblem(undefined)
    work()
      .then(
        (next) => {
          setStatus(next)
          if (clearDraft && next.storedIn !== undefined) setDraft('')
        },
        (error: unknown) => setProblem(message(error)),
      )
      .finally(() => setBusy(undefined))
  }

  const save = (inFile = false) =>
    act(inFile ? 'file' : 'save', () => ted.saveLinearKey(draft, inFile), true)

  const stored = status?.storedIn !== undefined
  const masked = stored ? `${'•'.repeat(20)}${status?.last4 ?? ''}` : ''
  const typing = draft !== ''
  const noKeyring = status?.state === 'no-keyring'

  return (
    <SettingsGroup
      label="Linear"
      help="TED uses the key to fill in a Task from a pasted Linear issue URL and to keep that issue’s status in step with the Task. It never gives the key to an agent."
    >
      <div className={styles.row}>
        <div className={settingsStyles.titleLine}>
          <label className={settingsStyles.rowTitle} htmlFor={fieldId}>
            API key
          </label>
          <Help>
            A personal API key from Linear’s Settings → Security & access. TED keeps it in{' '}
            {status?.keyring === 'secret-service' ? 'your keyring' : 'the macOS Keychain'}.
          </Help>
        </div>
        <div className={styles.controls}>
          <input
            id={fieldId}
            className={styles.field}
            aria-label="Linear API key"
            type={typing ? 'password' : 'text'}
            spellCheck={false}
            autoComplete="off"
            placeholder="lin_api_…"
            value={typing ? draft : masked}
            onFocus={(event) => {
              if (!typing) event.currentTarget.select()
            }}
            onChange={(event) => setDraft(event.target.value.replace(masked, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && typing) save(noKeyring)
              if (event.key === 'Escape' && typing) {
                event.stopPropagation()
                setDraft('')
              }
            }}
          />
          {typing && noKeyring && (
            <Button primary onClick={() => save(true)} disabled={busy !== undefined}>
              Save in a file only you can read
            </Button>
          )}
          {typing && !noKeyring && (
            <Button primary onClick={() => save()} disabled={busy !== undefined}>
              {busy === 'save' ? 'Checking…' : 'Save'}
            </Button>
          )}
          {!typing && stored && (
            <>
              <Button onClick={() => act('test', ted.testLinear)} disabled={busy !== undefined}>
                {busy === 'test' ? 'Testing…' : 'Test'}
              </Button>
              <Button
                danger
                onClick={() => act('remove', ted.removeLinearKey)}
                disabled={busy !== undefined}
              >
                Remove
              </Button>
            </>
          )}
        </div>
        {status && <StatusLine status={status} keyFile={keyFile} />}
        {problem !== undefined && (
          <p className={styles.bad} role="alert">
            {problem}
          </p>
        )}
        <button type="button" className={styles.link} onClick={() => void ted.openLinearKeyPage()}>
          Create a key ↗
        </button>
      </div>
      {stored && (
        <SettingRow
          title="Sync status with Linear"
          help="When a Task comes from a Linear issue, TED moves the issue to In Progress when the Task starts, to In Review at the Review sign-off and to Done when it merges, and links the pull requests. If someone closes the issue in Linear, TED archives a Task that hasn’t started, or asks you."
        >
          <Switch
            label="Sync status with Linear"
            checked={sync}
            onChange={(on) => void ted.updateSettings({ linearSync: on })}
          />
        </SettingRow>
      )}
      {stored &&
        sync &&
        factories.map((factory) => (
          <TeamsRow key={factory.id} factory={factory} teams={teams} declined={declined} />
        ))}
    </SettingsGroup>
  )
}

function TeamsRow({
  factory,
  teams,
  declined,
}: {
  factory: Factory
  teams: MachineSettings['linearSyncTeams']
  declined: MachineSettings['linearSyncDeclined']
}) {
  const listed = teams[factory.id] ?? []
  const saved = listed.join(', ')
  const notNow = (declined[factory.id] ?? []).filter((team) => !listed.includes(team))
  const [draft, setDraft] = useState(saved)
  const [problem, setProblem] = useState<string>()
  const fieldId = useId()
  useEffect(() => setDraft(saved), [saved])

  function save() {
    const list = draft
      .split(/[\s,]+/)
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t !== '')
    if (list.join(', ') === saved) return
    setProblem(undefined)
    ted
      .updateSettings({ linearSyncTeams: { ...teams, [factory.id]: list } })
      .catch((error: unknown) => setProblem(message(error)))
  }

  function allow(team: string) {
    setProblem(undefined)
    ted.allowLinearTeam(factory.id, team).catch((error: unknown) => setProblem(message(error)))
  }

  return (
    <SettingRow
      title={`Linear teams for Automations in ${factory.name}`}
      labelFor={fieldId}
      help="TED syncs a Task an Automation made only when its issue is in one of these Linear teams. The first time an Automation makes a Task from another team, TED asks you in the Inbox. For a single Task, open its menu and choose Sync with Linear."
      detail={
        problem ??
        (notNow.length > 0 ? (
          <span className={styles.notNow}>
            You chose Not now for
            {notNow.map((team) => (
              <span key={team} className={styles.notNowTeam}>
                {team}
                <button
                  type="button"
                  className={styles.link}
                  aria-label={`Allow ${team} for Automations in ${factory.name}`}
                  onClick={() => allow(team)}
                >
                  Allow
                </button>
              </span>
            ))}
          </span>
        ) : undefined)
      }
    >
      <input
        id={fieldId}
        className={styles.teams}
        spellCheck={false}
        autoComplete="off"
        placeholder="None"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
        }}
      />
    </SettingRow>
  )
}

function StatusLine({ status, keyFile }: { status: LinearStatus; keyFile: string }) {
  const where =
    status.storedIn === 'file'
      ? `stored in ${keyFile}`
      : status.storedIn === 'keyring'
        ? `stored in ${status.keyring === 'macos-keychain' ? 'the macOS Keychain' : 'your keyring'}`
        : undefined
  const line = (tone: 'good' | 'warn' | 'bad', text: ReactNode, detail?: string) => (
    <p className={styles.status}>
      <span className={`${styles.dot} ${styles[`${tone}Dot`]}`} aria-hidden />
      <span className={styles[tone]}>{text}</span>
      {detail !== undefined && <span className={styles.where}>· {detail}</span>}
    </p>
  )
  switch (status.state) {
    case 'connected':
      return line(
        'good',
        `Connected as ${[status.user, status.workspace].filter(Boolean).join(' · ')}`,
        where,
      )
    case 'invalid':
      return line('bad', status.error ?? 'Linear didn’t accept this key', where)
    case 'unreachable':
      return line('warn', status.error ?? 'Couldn’t reach Linear', where)
    case 'no-keyring':
      return (
        <>
          {line('bad', 'No keyring found on this computer')}
          <p className={styles.explain}>
            TED keeps the key in the Secret Service, and none is running. Type the key, then save it
            in {keyFile}, which only you can read.
          </p>
        </>
      )
    case 'locked':
      return (
        <>
          {line('bad', 'Keyring is locked')}
          <p className={styles.explain}>Unlock it, then save or test the key again.</p>
        </>
      )
    case 'no-key':
      return line(
        'bad',
        'No API key',
        'pasting a Linear URL in a new Task links it but fills nothing in',
      )
  }
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
