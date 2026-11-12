import type { ExecutionReadiness as Readiness } from '@ted/protocol'
import styles from './machines.module.css'
export function ExecutionReadiness({
  value,
  stale = false,
}: {
  value: Readiness
  stale?: boolean
}) {
  return (
    <>
      <p className={styles.muted}>
        {stale ? 'Last reported · Offline; these readings are stale' : 'Reported by this worker'} ·{' '}
        {new Date(value.observedAt).toLocaleString()}
      </p>
      <dl className={styles.readiness}>
        <dt>Platform</dt>
        <dd>
          {value.platform} · {value.arch} · TED {value.version}
        </dd>
        <dt>Agents</dt>
        <dd>
          {value.agents.map((a) => (
            <div key={a.name}>
              {a.name}: {a.detected ? 'detected' : 'not detected'} · Model access unverified
              <div>
                {a.version ? `Version: ${a.version}` : `Version unavailable · ${a.versionReason}`}
              </div>
            </div>
          ))}
        </dd>
        <dt>Sandbox</dt>
        <dd>
          {value.sandbox.available ? 'Available' : 'Unavailable'} · {value.sandbox.reason}
        </dd>
        <dt>Disk / load</dt>
        <dd>
          {(value.freeBytes / 1024 ** 3).toFixed(1)} GB free · {value.loadPerCore.toFixed(2)} per
          core
        </dd>
        <dt>Configured capacity</dt>
        <dd>{value.capacity} working Runs</dd>
      </dl>
    </>
  )
}
