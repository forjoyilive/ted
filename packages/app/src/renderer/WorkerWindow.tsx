import { useState } from 'react'
import { usePolledResource } from './data.ts'
import { Button, SettingsGroup } from './settings/controls.tsx'
import { ConnectionHelpLink, ExecutionHelp } from './settings/ExecutionHelp.tsx'
import { ExecutionReadiness } from './settings/ExecutionReadiness.tsx'
import styles from './settings/machines.module.css'
import { readableError, ted } from './ted.ts'

export function WorkerWindow() {
  const resource = usePolledResource(ted.workerStatus)
  const [details, setDetails] = useState(''),
    [capacity, setCapacity] = useState('2'),
    [problem, setProblem] = useState<string>(),
    [busy, setBusy] = useState(false)
  const status = resource.value
  function act(work: () => Promise<unknown>) {
    setBusy(true)
    setProblem(undefined)
    void work()
      .catch((e: unknown) => setProblem(readableError(e)))
      .finally(() => {
        setBusy(false)
        resource.reload()
      })
  }
  return (
    <main className={styles.worker} data-loaded={status !== undefined}>
      <h1>Use this Mac as a worker</h1>
      <p>
        Connect to one controlling TED. Its Tasks and approvals stay on that computer. This worker
        has separate storage from independent TED Factories here.
      </p>
      <ExecutionHelp worker />
      {(problem || resource.error) && (
        <p role="alert" className={styles.error}>
          {problem || resource.error} <ConnectionHelpLink />
        </p>
      )}
      <SettingsGroup label="Pair with the main Mac">
        <div className={styles.panel}>
          <label htmlFor="worker-details">Pairing details</label>
          <textarea
            id="worker-details"
            className={styles.input}
            rows={3}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Paste the complete details from the main Mac"
            autoComplete="off"
            spellCheck={false}
          />
          <label htmlFor="worker-capacity">Working Run capacity</label>
          <input
            id="worker-capacity"
            className={styles.input}
            type="number"
            min={1}
            max={64}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
          <Button
            primary
            disabled={
              busy ||
              !details.trim() ||
              !['stopped', 'refused', 'unpaired'].includes(status?.state ?? 'stopped')
            }
            onClick={() =>
              act(async () => {
                const input = { details: details.trim(), capacity: Number(capacity) }
                setDetails('')
                await ted.workerPair(input)
              })
            }
          >
            Connect to controller
          </Button>
        </div>
      </SettingsGroup>
      <SettingsGroup label="Connection">
        <div className={styles.panel}>
          <h2>{status?.state ?? 'Loading…'}</h2>
          <p>{status?.message}</p>
          <ConnectionHelpLink />
          {status?.publicKey && (
            <>
              <h3>This Mac’s worker identity</h3>
              <code className={styles.identity}>SHA256:{status.publicKey}</code>
            </>
          )}
          {status?.controllerPin && (
            <>
              <h3>Controller identity</h3>
              <code className={styles.identity}>SHA256:{status.controllerPin}</code>
            </>
          )}
          <p>Allowed repos: {status?.scopes.map((s) => s.repo).join(', ') || 'none'}</p>
          {status?.readiness && (
            <ExecutionReadiness
              value={status.readiness}
              stale={status.state !== 'connected' && status.state !== 'pending'}
            />
          )}
          <div className={styles.actions}>
            <Button
              disabled={busy || !status || status.state === 'stopped'}
              onClick={() => act(() => ted.workerStop())}
            >
              Stop worker
            </Button>
            <Button
              disabled={busy || !['stopped', 'unpaired'].includes(status?.state ?? '')}
              onClick={() => act(() => ted.workerStart())}
            >
              Start worker
            </Button>
            <Button onClick={() => act(() => ted.quit())}>Quit TED completely</Button>
          </div>
        </div>
      </SettingsGroup>
      <p className={styles.notice}>
        Closing this window keeps the worker running. After logout or reboot, open TED in worker
        mode or use CLI Start.
      </p>
    </main>
  )
}
