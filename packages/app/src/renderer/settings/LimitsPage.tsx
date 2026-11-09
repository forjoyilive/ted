import { simulatorSlotLimits } from '@ted/protocol/app'
import { workingRunLimits } from '@ted/protocol/settings'
import { useSimulators, useSlots } from '../data.ts'
import { nowLine } from '../slots.ts'
import { ted } from '../ted.ts'
import { SettingRow, SettingsGroup, SettingsPage, Stepper } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './settings.module.css'

export function LimitsPage({ settings }: SettingsPageProps) {
  const slots = useSlots()
  const simulators = useSimulators()
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
        {simulators?.supported === true && (
          <SettingRow
            title="Simulators booted at once"
            help="iOS simulator Apps share these slots. When they’re all taken, TED asks which simulator to shut down; it never shuts one down on its own to make room."
          >
            <Stepper
              value={settings.maxBootedSimulators}
              min={simulatorSlotLimits.min}
              max={simulatorSlotLimits.max}
              lessLabel="Fewer simulators"
              moreLabel="More simulators"
              onChange={(maxBootedSimulators) => void ted.updateSettings({ maxBootedSimulators })}
            />
          </SettingRow>
        )}
      </SettingsGroup>
      {slots && <p className={styles.nowLine}>{nowLine(slots, simulators)}</p>}
    </SettingsPage>
  )
}
