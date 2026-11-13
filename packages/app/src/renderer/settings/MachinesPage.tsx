import type { ExecutionOffer, ExecutionPending } from '@ted/protocol'
import { useState } from 'react'
import { usePolledResource } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import { Button, Select, SettingsGroup, SettingsPage } from './controls.tsx'
import { ConnectionHelpLink, ExecutionHelp } from './ExecutionHelp.tsx'
import { ExecutionReadiness } from './ExecutionReadiness.tsx'
import styles from './machines.module.css'

function PairReview({
  row,
  repos,
  act,
  busy,
}: {
  row: ExecutionPending
  repos: Awaited<ReturnType<typeof ted.executionMachines>>['repos']
  act: (work: () => Promise<unknown>) => void
  busy: boolean
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [matched, setMatched] = useState(false)
  return (
    <article className={styles.panel} data-nav-item tabIndex={-1}>
      <h3>{row.name} · Waiting for approval</h3>
      <p>Check this worker identity against its window on the other Mac.</p>
      <code className={styles.identity}>SHA256:{row.publicKey}</code>
      <p>Expires {new Date(row.expiresAt).toLocaleTimeString()}</p>
      <ExecutionReadiness value={row.readiness} />
      <h4>Allow access to these repos</h4>
      <p className={styles.muted}>
        Nothing is selected by default. Repos added later need another approval.
      </p>
      {repos.map((r) => {
        const id = JSON.stringify([r.factoryId, r.repo])
        return (
          <label className={styles.choice} key={id}>
            <input
              type="checkbox"
              checked={selected.includes(id)}
              onChange={(e) =>
                setSelected((current) =>
                  e.target.checked ? [...current, id] : current.filter((v) => v !== id),
                )
              }
            />
            {r.factoryName} / {r.repo}
          </label>
        )
      })}
      <label className={styles.choice}>
        <input type="checkbox" checked={matched} onChange={(e) => setMatched(e.target.checked)} />I
        checked the worker identity on the other Mac.
      </label>
      <div className={styles.actions}>
        <Button
          primary
          disabled={
            busy || !matched || selected.length === 0 || Date.parse(row.expiresAt) <= Date.now()
          }
          onClick={() =>
            act(() =>
              ted.approveExecution({
                id: row.id,
                scopes: repos
                  .filter((r) => selected.includes(JSON.stringify([r.factoryId, r.repo])))
                  .map(({ factoryId, repo }) => ({ factoryId, repo })),
              }),
            )
          }
        >
          Approve pairing
        </Button>
        <Button disabled={busy} onClick={() => act(() => ted.rejectExecution({ id: row.id }))}>
          Reject
        </Button>
      </div>
    </article>
  )
}
export function MachinesPage() {
  const resource = usePolledResource(ted.executionMachines)
  const [address, setAddress] = useState(''),
    [port, setPort] = useState(''),
    [offer, setOffer] = useState<ExecutionOffer>(),
    [problem, setProblem] = useState<string>(),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<string>()
  const data = resource.value
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
  const chosenPort = port || String(data?.endpoint?.port ?? 47443)
  const chosen = address || data?.endpoint?.address || data?.addresses[0]?.address || ''
  return (
    <SettingsPage
      title="Machines"
      subtitle="This TED owns your Factories, Tasks and approvals. Connect another Mac for future execution."
    >
      <ExecutionHelp />
      {(problem || resource.error || data?.problem) && (
        <p className={styles.error} role="alert">
          {problem || resource.error || data?.problem} <ConnectionHelpLink />
        </p>
      )}
      <SettingsGroup setting="app.machines.connect">
        <div className={styles.panel}>
          <label htmlFor="execution-address" data-setting="app.machines.connect.address">
            This Mac’s local address
          </label>
          <Select
            id="execution-address"
            value={chosen}
            options={(data?.addresses ?? []).map((a) => ({
              value: a.address,
              label: `${a.name} · ${a.address}`,
            }))}
            onChange={setAddress}
          />
          <label htmlFor="execution-port" data-setting="app.machines.connect.port">
            Port
          </label>
          <input
            className={styles.input}
            id="execution-port"
            type="number"
            min={1}
            max={65535}
            value={chosenPort}
            onChange={(e) => setPort(e.target.value)}
          />
          <div className={styles.actions}>
            <Button
              primary
              disabled={busy || !chosen}
              onClick={() =>
                act(async () => {
                  await ted.configureExecution({ address: chosen, port: Number(chosenPort) })
                  setOffer(await ted.createExecutionEnrollment())
                })
              }
            >
              Create pairing details
            </Button>
            <Button
              disabled={busy || !offer}
              onClick={() =>
                act(async () => {
                  await ted.cancelExecutionEnrollment()
                  setOffer(undefined)
                })
              }
            >
              Cancel pairing
            </Button>
          </div>
          {offer && Date.parse(offer.expiresAt) > Date.now() && (
            <div className={styles.notice}>
              <p>Ready · Single use · Expires {new Date(offer.expiresAt).toLocaleTimeString()}</p>
              <Button onClick={() => act(() => ted.copyText(JSON.stringify(offer)))}>
                Copy pairing details
              </Button>
              <p>Paste into the worker window on the other Mac. Keep these details private.</p>
            </div>
          )}
          <Button onClick={() => act(() => ted.openWorker())}>Use this Mac as a worker…</Button>
        </div>
      </SettingsGroup>
      {data?.pending.map((row) => (
        <SettingsGroup key={row.id} label="Review pairing">
          <PairReview row={row} repos={data.repos} act={act} busy={busy} />
        </SettingsGroup>
      ))}
      <SettingsGroup setting="app.machines.execution">
        {data?.machines.length ? (
          data.machines.map((m) => (
            <article key={m.id} className={styles.panel} data-nav-item tabIndex={-1}>
              <h3>
                {m.name} · {m.revokedAt ? 'Revoked' : m.connected ? 'Connected' : 'Disconnected'}
              </h3>
              <code className={styles.identity}>SHA256:{m.publicKey}</code>
              <p>Grant: {m.id}</p>
              <p>Allowed repos: {m.scopes.map((s) => s.repo).join(', ')}</p>
              {m.readiness && <ExecutionReadiness value={m.readiness} stale={!m.connected} />}
              {!m.revokedAt &&
                (confirm === m.id ? (
                  <>
                    <p>
                      Revoke immediately rejects traffic and asks a reachable worker to stop.
                      Unreachable assignments remain unresolved. Fresh pairing cannot reclaim them.
                    </p>
                    <div className={styles.actions}>
                      <Button
                        danger
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await ted.revokeExecution({ id: m.id })
                            setConfirm(undefined)
                          })
                        }
                      >
                        Confirm revocation
                      </Button>
                      <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
                    </div>
                  </>
                ) : (
                  <Button danger disabled={busy} onClick={() => setConfirm(m.id)}>
                    Revoke access
                  </Button>
                ))}
            </article>
          ))
        ) : (
          <p className={styles.panel}>No execution Mac paired yet.</p>
        )}
      </SettingsGroup>
      <p className={styles.muted}>Task execution comes later. Pairing alone starts no Tasks.</p>
    </SettingsPage>
  )
}
