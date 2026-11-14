import { emulatorSlotLimits, simulatorSlotLimits } from '@ted/protocol/app'
import { checkLimits, workingRunLimits } from '@ted/protocol/settings'
import { useEmulators, useSimulators, useSlots } from '../data.ts'
import { nowLine } from '../slots.ts'
import { ted } from '../ted.ts'
import { SettingRow, SettingsGroup, SettingsPage, Stepper, Switch } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './settings.module.css'

export function LimitsPage({ settings }: SettingsPageProps) {
  const slots = useSlots()
  const simulators = useSimulators()
  const emulators = useEmulators()
  return (
    <SettingsPage
      title="Limits"
      help="Limits on this computer only. They apply to every Factory and are never committed."
    >
      <SettingsGroup>
        <SettingRow setting="app.limits.working-runs">
          <Stepper
            value={settings.maxWorkingRuns}
            min={workingRunLimits.min}
            max={workingRunLimits.max}
            lessLabel="Fewer working Runs"
            moreLabel="More working Runs"
            onChange={(maxWorkingRuns) => ted.updateSettings({ maxWorkingRuns })}
          />
        </SettingRow>
        <SettingRow setting="app.limits.busy">
          <Switch
            label="Start fewer Runs when this computer is busy"
            checked={settings.adjustRunsToLoad}
            onChange={(adjustRunsToLoad) => ted.updateSettings({ adjustRunsToLoad })}
          />
        </SettingRow>
        {simulators?.supported === true && (
          <SettingRow setting="app.limits.simulators">
            <Stepper
              value={settings.maxBootedSimulators}
              min={simulatorSlotLimits.min}
              max={simulatorSlotLimits.max}
              lessLabel="Fewer simulators"
              moreLabel="More simulators"
              onChange={(maxBootedSimulators) => ted.updateSettings({ maxBootedSimulators })}
            />
          </SettingRow>
        )}
        {emulators?.supported === true && (
          <SettingRow setting="app.limits.emulators">
            <Stepper
              value={settings.maxRunningEmulators}
              min={emulatorSlotLimits.min}
              max={emulatorSlotLimits.max}
              lessLabel="Fewer emulators"
              moreLabel="More emulators"
              onChange={(maxRunningEmulators) => ted.updateSettings({ maxRunningEmulators })}
            />
          </SettingRow>
        )}
        <SettingRow setting="app.limits.checks">
          <Stepper
            value={settings.maxChecksAtOnce}
            min={checkLimits.min}
            max={checkLimits.max}
            lessLabel="Fewer Checks at once"
            moreLabel="More Checks at once"
            onChange={(maxChecksAtOnce) => ted.updateSettings({ maxChecksAtOnce })}
          />
        </SettingRow>
        <SettingRow setting="app.limits.low-priority">
          <Switch
            label="Run agents and Checks at low priority"
            checked={settings.lowPriorityWork}
            onChange={(lowPriorityWork) => ted.updateSettings({ lowPriorityWork })}
          />
        </SettingRow>
      </SettingsGroup>
      {slots && <p className={styles.nowLine}>{nowLine(slots, simulators, emulators)}</p>}
    </SettingsPage>
  )
}
