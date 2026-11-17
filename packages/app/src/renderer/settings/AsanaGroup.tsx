import type { AsanaProjectList, AsanaStatus } from '@ted/protocol'
import { asanaScopes } from '@ted/protocol/asana'
import { useEffect, useId, useState } from 'react'
import dialogStyles from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import { useFactories, useSettings } from '../data.ts'
import { ted } from '../ted.ts'
import { AsanaProjectsRow } from './AsanaProjectsRow.tsx'
import own from './asana.module.css'
import { SettingRow, SettingsGroup, Switch } from './controls.tsx'
import styles from './linear.module.css'

export function AsanaGroup() {
  const settings = useSettings()
  const sync = settings?.asanaSync
  const factories = useFactories()
  const [status, setStatus] = useState<AsanaStatus>()
  const [projects, setProjects] = useState<AsanaProjectList>()
  const connectedAs = status?.user?.gid
  const listing = connectedAs !== undefined && sync === true
  useEffect(() => {
    if (connectedAs === undefined || sync !== true) return
    let active = true
    setProjects(undefined)
    ted.asanaProjects().then(
      (list) => {
        if (active) setProjects(list)
      },
      (error: unknown) => {
        if (active)
          setProblem(error instanceof Error ? error.message : 'Couldn’t list Asana projects.')
      },
    )
    return () => {
      active = false
    }
  }, [sync, connectedAs])
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    title: string
    text: string
    run: () => void
  }>()
  function confirm(title: string, text: string, work: () => Promise<AsanaStatus>) {
    setConfirmation({ title, text, run: () => act(work) })
  }
  const fieldId = useId()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [copied, setCopied] = useState(false)
  const pasting = status !== undefined && (!status.configured || replacing)
  const noKeyring =
    status?.storageProblem === 'no-keyring' || (replacing && status?.storedIn === 'file')
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  function copyRedirect(url: string) {
    void ted.copyText(url).then(() => setCopied(true))
  }
  function save(inFile: boolean) {
    act(async () => {
      const next = await ted.configureAsana({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        inFile,
      })
      setClientId('')
      setClientSecret('')
      setReplacing(false)
      return next
    })
  }
  useEffect(() => {
    let active = true
    let loading = false
    const load = async () => {
      if (loading) return
      loading = true
      try {
        const next = await ted.getAsana()
        if (active) setStatus(next)
      } catch {
        if (active) setProblem('Couldn’t load Asana. Try opening Settings again.')
      } finally {
        loading = false
      }
    }
    void load()
    const timer = setInterval(() => void load(), 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  function act(work: () => Promise<AsanaStatus>) {
    setBusy(true)
    setProblem(undefined)
    void work()
      .then(setStatus, (error: unknown) =>
        setProblem(
          error instanceof Error ? error.message : 'Couldn’t complete this action. Try again.',
        ),
      )
      .finally(() => setBusy(false))
  }
  return (
    <SettingsGroup setting="app.integrations.asana">
      {confirmation && (
        <Dialog onClose={() => setConfirmation(undefined)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                {confirmation.title}
              </h2>
              <p className={dialogStyles.body}>{confirmation.text}</p>
              <div className={dialogStyles.buttons}>
                <Button onClick={() => setConfirmation(undefined)}>Cancel</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    const run = confirmation.run
                    setConfirmation(undefined)
                    run()
                  }}
                >
                  Continue
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
      <div className={styles.row}>
        <details key={pasting ? 'setup' : 'configured'} open={pasting} className={own.setup}>
          <summary>Set up your own Asana app</summary>
          <ol className={own.steps}>
            <li>
              Open Asana’s developer console and click <b>Create new app</b>. Name it Ted.
              <br />
              <button
                type="button"
                className={styles.link}
                onClick={() => void ted.openAsanaSetup()}
              >
                Open Asana developer console ↗
              </button>
            </li>
            <li>
              Under <b>OAuth</b>, add this redirect URL exactly:
              <span className={own.copyLine}>
                <code className={own.code}>{status?.redirectUri ?? 'Loading…'}</code>
                {status?.redirectUri && (
                  <Button size="small" onClick={() => copyRedirect(status.redirectUri)}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </span>
            </li>
            <li>
              Under <b>OAuth</b> → <b>Permission scopes</b>, turn on:
              <span className={own.scopes}>
                {asanaScopes.map((scope) => (
                  <code key={scope} className={own.code}>
                    {scope}
                  </code>
                ))}
              </span>
              <span className={own.note}>
                Ted reads tasks and their files to import them, and writes comments and completes
                tasks only when Task Sync is on.
              </span>
            </li>
            <li>
              Under <b>Manage distribution</b>, choose <b>Specific workspace</b> and add your
              workspace.
            </li>
            <li>
              Copy the <b>Client ID</b> and <b>Client secret</b> from <b>OAuth</b> and paste them
              below.
            </li>
          </ol>
          <p className={styles.explain}>
            Ted and Ted Dev each need an app of their own, because their redirect URLs differ.
          </p>
        </details>
        <p role="status" className={styles.explain}>
          {status?.state === 'authorizing'
            ? 'Waiting for browser authorization…'
            : replacing
              ? 'Paste the new app’s client ID and secret.'
              : status?.user
                ? `Connected as ${status.user.name} · ${status.user.email}`
                : status?.configured
                  ? 'App configured. Connect to authorize your account.'
                  : 'Set up an Asana app, then paste its client ID and secret.'}
          {status?.storedIn === 'file' &&
            !pasting &&
            ' Credentials are stored in a private file in your Ted home folder.'}
        </p>
        {status?.user && !replacing && status.extraScopes && status.extraScopes.length > 0 && (
          <p className={styles.explain}>
            Asana also granted {status.extraScopes.join(', ')}. Ted doesn’t need{' '}
            {status.extraScopes.length === 1 ? 'it' : 'them'}; you can turn{' '}
            {status.extraScopes.length === 1 ? 'it' : 'them'} off in the Asana developer console.
          </p>
        )}
        {(problem || status?.error) && (
          <p className={styles.bad} role="alert">
            {problem ?? status?.error}
          </p>
        )}
        {pasting && (
          <>
            <div className={own.fields}>
              <label htmlFor={`${fieldId}-id`}>Client ID</label>
              <input
                id={`${fieldId}-id`}
                className={styles.field}
                spellCheck={false}
                autoComplete="off"
                inputMode="numeric"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
              <label htmlFor={`${fieldId}-secret`}>Client secret</label>
              <input
                id={`${fieldId}-secret`}
                className={styles.field}
                type="password"
                spellCheck={false}
                autoComplete="off"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') save(noKeyring)
                }}
              />
            </div>
            {noKeyring && (
              <p className={styles.explain}>
                No keyring is available on this computer. Ted can keep the secret in a private file
                in its home folder instead.
              </p>
            )}
            <div className={own.controls}>
              <Button variant="primary" disabled={busy} onClick={() => save(noKeyring)}>
                {noKeyring ? 'Save in a file only you can read' : 'Save'}
              </Button>
              {replacing && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setClientId('')
                    setClientSecret('')
                    setReplacing(false)
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </>
        )}
        {!pasting && (
          <div className={own.controls}>
            {status?.configured && status.state !== 'authorizing' && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  status.user
                    ? confirm(
                        'Reconnect Asana?',
                        'This disconnects the current account first. Canceling browser authorization leaves Ted disconnected.',
                        ted.authorizeAsana,
                      )
                    : act(ted.authorizeAsana)
                }
              >
                {status.user ? 'Reconnect as another user' : 'Connect'}
              </Button>
            )}
            {status?.state === 'authorizing' && (
              <Button disabled={busy} onClick={() => act(ted.cancelAsana)}>
                Cancel authorization
              </Button>
            )}
            {status?.user && (
              <>
                <Button disabled={busy} onClick={() => act(ted.testAsana)}>
                  Test connection
                </Button>
                <Button disabled={busy} onClick={() => act(ted.disconnectAsana)}>
                  Disconnect
                </Button>
              </>
            )}
            {status?.configured && status.state !== 'authorizing' && (
              <Button
                disabled={busy}
                onClick={() =>
                  setConfirmation({
                    title: 'Replace the Asana app?',
                    text: 'Saving a new app’s client ID and secret disconnects the current account. You then click Connect to authorize again.',
                    run: () => {
                      setProblem(undefined)
                      setReplacing(true)
                    },
                  })
                }
              >
                Replace app
              </Button>
            )}
            {status?.configured && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  confirm(
                    'Remove Asana configuration?',
                    'This disconnects the account and deletes its tokens and client secret. To connect again, set up the app again.',
                    ted.removeAsana,
                  )
                }
              >
                Remove configuration…
              </Button>
            )}
          </div>
        )}
        {status?.user && !pasting && (
          <p className={styles.explain}>
            Reconnect first disconnects this account. Canceling leaves Ted disconnected. Disconnect
            retains app configuration; Remove configuration deletes it too.
          </p>
        )}
      </div>
      {status?.configured && sync !== undefined && (
        <SettingRow setting="app.integrations.asana.sync">
          <Switch
            label="Task Sync"
            checked={sync}
            onChange={(on) => void ted.updateSettings({ asanaSync: on })}
          />
        </SettingRow>
      )}
      {listing &&
        settings &&
        connectedAs !== undefined &&
        factories.map((factory) => (
          <AsanaProjectsRow
            key={factory.id}
            factory={factory}
            settings={settings}
            projects={projects}
            account={connectedAs}
          />
        ))}
    </SettingsGroup>
  )
}
