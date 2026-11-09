import { workingRunLimits } from '@ted/protocol'
import { useSlots } from '../data.ts'
import { nowLine } from '../slots.ts'
import { ted } from '../ted.ts'
import { SettingRow, SettingsGroup, SettingsPage, Stepper } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './settings.module.css'

export function LimitsPage({ settings }: SettingsPageProps) {
  const slots = useSlots()
  return (
    <SettingsPage
      title="Limits"
      help="Limits on this computer only. They apply to every Factory and are never committed."
    >
      <SettingsGroup>
        <SettingRow
          title="Max working Runs on this machine"
          help="A new Run starts only when a slot is free. Runs waiting on you, Paused Runs, Apps and Checks don’t take a slot; a Task setting up its worktree does. A Factory’s own max_working_runs can lower it further."
        >
          <Stepper
            value={settings.maxWorkingRuns}
            min={workingRunLimits.min}
            max={workingRunLimits.max}
            lessLabel="Fewer working Runs"
            moreLabel="More working Runs"
            onChange={(maxWorkingRuns) => void ted.updateSettings({ maxWorkingRuns })}
          />
        </SettingRow>
      </SettingsGroup>
      {slots && <p className={styles.nowLine}>{nowLine(slots)}</p>}
    </SettingsPage>
  )
}
