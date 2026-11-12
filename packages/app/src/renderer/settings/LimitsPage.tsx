import { simulatorSlotLimits } from '@ted/protocol/app'
import { checkLimits, workingRunLimits } from '@ted/protocol/settings'
import { useSimulators, useSlots } from '../data.ts'
import { nowLine } from '../slots.ts'
import { ted } from '../ted.ts'
import { SettingRow, SettingsGroup, SettingsPage, Stepper, Switch } from './controls.tsx'
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
            onChange={(maxWorkingRuns) => ted.updateSettings({ maxWorkingRuns })}
          />
        </SettingRow>
        <SettingRow
          title="Start fewer Runs when this computer is busy"
          help="While this computer is busy, TED starts no new Run unless none is working. Runs already working carry on. The limit above is still the most TED runs at once."
        >
          <Switch
            label="Start fewer Runs when this computer is busy"
            checked={settings.adjustRunsToLoad}
            onChange={(adjustRunsToLoad) => ted.updateSettings({ adjustRunsToLoad })}
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
              onChange={(maxBootedSimulators) => ted.updateSettings({ maxBootedSimulators })}
            />
          </SettingRow>
        )}
        <SettingRow
          title="Checks running at once"
          help="A Task’s Checks run one after another and count as one. When this many Tasks are running Checks, the next waits its turn; a Check you try with Run now in Factory settings waits too. Lowering the limit doesn’t stop Checks that are running."
        >
          <Stepper
            value={settings.maxChecksAtOnce}
            min={checkLimits.min}
            max={checkLimits.max}
            lessLabel="Fewer Checks at once"
            moreLabel="More Checks at once"
            onChange={(maxChecksAtOnce) => ted.updateSettings({ maxChecksAtOnce })}
          />
        </SettingRow>
        <SettingRow
          title="Run agents and Checks at low priority"
          help="For agents, Checks, worktree setup and teardown, and Apps an agent starts. On macOS they run at the system’s “utility” priority, so they give way to your other apps and may run slower. On Linux they run at a lower scheduling priority. Apps you start with ▶ and Task shells keep normal priority."
          detail="Applies to work started after you change it. A Run that is already going keeps its priority."
        >
          <Switch
            label="Run agents and Checks at low priority"
            checked={settings.lowPriorityWork}
            onChange={(lowPriorityWork) => ted.updateSettings({ lowPriorityWork })}
          />
        </SettingRow>
      </SettingsGroup>
      {slots && <p className={styles.nowLine}>{nowLine(slots, simulators)}</p>}
    </SettingsPage>
  )
}
