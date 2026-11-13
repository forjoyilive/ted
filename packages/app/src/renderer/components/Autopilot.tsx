import type { AutopilotChoice, Task } from '@ted/protocol'
import { useContext, useState } from 'react'
import { OvernightContext } from '../overnight.tsx'
import { readableError, ted } from '../ted.ts'
import styles from './Autopilot.module.css'
import { Select } from './Select.tsx'

export function AutopilotLabel({ task }: { task: Task }) {
  const choice = task.autopilot?.choice ?? 'inherit'
  if (choice === 'inherit') return null
  return <span className={styles.label}>{choice === 'on' ? 'Autopilot on' : 'Autopilot off'}</span>
}

export function AutopilotField({ task }: { task: Task }) {
  const { on } = useContext(OvernightContext)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const choice = task.autopilot?.choice ?? 'inherit'
  const enabled = choice === 'on' || (choice === 'inherit' && on)
  async function change(next: string) {
    setBusy(true)
    setError(undefined)
    try {
      await ted.setTaskAutopilot(task.id, { choice: next as AutopilotChoice })
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.field}>
      <Select
        className={styles.select}
        aria-label="Autopilot"
        value={choice}
        disabled={busy || !!task.archived || task.stage === 'done'}
        onChange={(event) => void change(event.target.value)}
      >
        <option value="inherit">Use global setting ({on ? 'On' : 'Off'})</option>
        <option value="on">Autopilot on</option>
        <option value="off">Autopilot off</option>
      </Select>
      <small>
        {enabled
          ? 'Makes routine decisions and continues through Merge. Turning on also handles waiting routine requests.'
          : 'Follows normal questions and sign-offs.'}{' '}
        Start and Resume are separate actions.
      </small>
      <details>
        <summary>What still needs you?</summary>
        <small>
          Permissions, failed Checks requiring your decision, setup and Workflow-change safeguards,
          missing access or information, size checks and split proposals.
        </small>
      </details>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
