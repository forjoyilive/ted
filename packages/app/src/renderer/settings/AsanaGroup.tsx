import type { AsanaProjectList, AsanaStatus } from '@ted/protocol'
import { useEffect, useState } from 'react'
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
    work: () => Promise<AsanaStatus>
  }>()
  function confirm(title: string, text: string, work: () => Promise<AsanaStatus>) {
    setConfirmation({ title, text, work })
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
                    const work = confirmation.work
                    setConfirmation(undefined)
                    act(work)
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
        <details>
          <summary>Set up your own Asana app</summary>
          <p className={styles.explain}>
            Create an app in Asana’s developer console. Make it available in your workspace under
            Manage distribution. Use a separate registration for TED Dev.
          </p>
          <p className={styles.explain}>
            Register this exact redirect URL: {status?.redirectUri ?? 'Loading…'}
          </p>
          <p className={styles.explain}>
            Enable users:read, workspaces:read, projects:read, tasks:read, attachments:read,
            stories:read, tasks:write and stories:write. These permissions prepare for future import
            and sync; connecting alone writes no tasks.
          </p>
          <p className={styles.explain}>
            Create a private JSON file outside repos with client_id and client_secret. Set its
            permissions to 0600, import it below, then delete the temporary file. TED keeps the
            secret and refresh credentials in your OS keyring.
          </p>
          <Button onClick={() => void ted.openAsanaSetup()}>Asana setup instructions ↗</Button>
        </details>
        <p role="status" className={styles.explain}>
          {status?.state === 'authorizing'
            ? 'Waiting for browser authorization…'
            : status?.user
              ? `Connected as ${status.user.name} · ${status.user.email}`
              : status?.configured
                ? 'App configured. Connect to authorize your account.'
                : 'Import your app configuration to get started.'}
          {status?.storedIn === 'file' &&
            ' Credentials are stored in a private file in your TED home folder.'}
        </p>
        {(problem || status?.error) && (
          <p className={styles.bad} role="alert">
            {problem ?? status?.error}
          </p>
        )}
        <div className={own.controls}>
          <Button
            disabled={busy || status?.state === 'authorizing'}
            onClick={() =>
              status?.configured
                ? confirm(
                    'Replace Asana configuration?',
                    'This disconnects the current account and replaces the registered app. You will need to authorize again.',
                    () => ted.importAsanaConfiguration(),
                  )
                : act(() => ted.importAsanaConfiguration())
            }
          >
            Import app configuration
          </Button>
          {status?.storageProblem === 'no-keyring' && (
            <Button disabled={busy} onClick={() => act(() => ted.importAsanaConfiguration(true))}>
              Import and store in a private file
            </Button>
          )}
          {status?.configured && status.state !== 'authorizing' && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                status.user
                  ? confirm(
                      'Reconnect Asana?',
                      'This disconnects the current account first. Canceling browser authorization leaves TED disconnected.',
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
          {status?.configured && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                confirm(
                  'Remove Asana configuration?',
                  'This disconnects the account and deletes its tokens and client secret. To connect again, import your app configuration.',
                  ted.removeAsana,
                )
              }
            >
              Remove configuration
            </Button>
          )}
        </div>
        {status?.user && (
          <p className={styles.explain}>
            Reconnect first disconnects this account. Canceling leaves TED disconnected. Disconnect
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
