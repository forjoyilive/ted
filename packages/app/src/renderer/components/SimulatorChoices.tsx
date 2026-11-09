import type { BootedSimulator } from '@ted/protocol'
import { ago } from '../requests.ts'
import styles from './SimulatorChoices.module.css'

export function firstChoice(booted: readonly BootedSimulator[]): string | undefined {
  return booted.find((b) => !b.recording)?.udid
}

export function SimulatorChoices({
  booted,
  chosen,
  onChoose,
  now,
  label,
  showApp = false,
  disabled = false,
}: {
  booted: readonly BootedSimulator[]
  chosen: string | undefined
  onChoose: (udid: string) => void
  now: number
  label: string
  showApp?: boolean
  disabled?: boolean
}) {
  const oldest = firstChoice(booted)
  return (
    <div className={styles.choices} role="radiogroup" aria-label={label}>
      {booted.map((sim) => {
        const used = sim.recording
          ? 'recording, can’t be shut down'
          : showApp
            ? `last used ${ago(sim.lastUsedAt, now)}`
            : `used ${ago(sim.lastUsedAt, now)}${sim.udid === oldest && booted.length > 1 ? ' · longest ago' : ''}`
        const title = sim.title === '' ? sim.displayId : `${sim.displayId} · ${sim.title}`
        return (
          <label
            key={sim.udid}
            className={styles.choice}
            data-chosen={sim.udid === chosen || undefined}
            data-locked={sim.recording || undefined}
          >
            <input
              type="radio"
              className={styles.radio}
              name={label}
              value={sim.udid}
              checked={sim.udid === chosen}
              disabled={disabled || sim.recording}
              onChange={() => onChoose(sim.udid)}
            />
            <span className={styles.text}>
              <span className={styles.title}>{title}</span>
              <span className={styles.detail}>{showApp ? `${sim.app} · ${used}` : used}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}
