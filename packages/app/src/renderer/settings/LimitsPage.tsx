import { deviceSlotLimits } from '@ted/protocol/app'
import {
  checkCpuLimits,
  checkLimits,
  defaultMachineSettings,
  idleRunSleepLimits,
  workingRunLimits,
} from '@ted/protocol/settings'
import { useEmulators, useSimulators, useSlots } from '../data.ts'
import { nowLine, slotsDetail } from '../slots.ts'
import { ted } from '../ted.ts'
import { SettingRow, SettingsGroup, SettingsPage, Stepper, Switch } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './settings.module.css'

const sleepStep = 5

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
            label="Wait to start new work when this computer is busy"
            checked={settings.waitWhenBusy}
            onChange={(waitWhenBusy) => ted.updateSettings({ waitWhenBusy })}
          />
        </SettingRow>
        {(simulators?.supported === true || emulators?.supported === true) && (
          <>
            <SettingRow setting="app.limits.devices">
              <Stepper
                value={settings.maxRunningDevices}
                min={deviceSlotLimits.min}
                max={deviceSlotLimits.max}
                lessLabel="Fewer simulators and emulators"
                moreLabel="More simulators and emulators"
                onChange={(maxRunningDevices) => ted.updateSettings({ maxRunningDevices })}
              />
            </SettingRow>
            <SettingRow setting="app.limits.build-one-device">
              <Switch
                label="Build one simulator or emulator App at a time"
                checked={settings.buildDeviceAppsOneAtATime}
                onChange={(buildDeviceAppsOneAtATime) =>
                  ted.updateSettings({ buildDeviceAppsOneAtATime })
                }
              />
            </SettingRow>
          </>
        )}
        <SettingRow setting="app.limits.checks">
          <Stepper
            value={settings.maxChecksAtOnce}
            min={checkLimits.min}
            max={checkLimits.max}
            lessLabel="Fewer checks at once"
            moreLabel="More checks at once"
            onChange={(maxChecksAtOnce) => ted.updateSettings({ maxChecksAtOnce })}
          />
        </SettingRow>
        <SettingRow setting="app.limits.check-cpus">
          <Stepper
            value={settings.checkCpuPercent}
            min={checkCpuLimits.min}
            max={checkCpuLimits.max}
            step={checkCpuLimits.step}
            format={(percent) => `${percent}%`}
            lessLabel="Less CPU for a check"
            moreLabel="More CPU for a check"
            onChange={(checkCpuPercent) => ted.updateSettings({ checkCpuPercent })}
          />
        </SettingRow>
        <SettingRow setting="app.limits.scheduled-check-cpus">
          <Switch
            label="Limit the CPU scheduled checks use too"
            checked={settings.limitScheduledCheckCpus}
            onChange={(limitScheduledCheckCpus) => ted.updateSettings({ limitScheduledCheckCpus })}
          />
        </SettingRow>
        <SettingRow setting="app.limits.sleep-idle">
          <Switch
            label="End idle agents to free memory"
            checked={settings.sleepIdleRunsAfterMinutes !== null}
            onChange={(on) =>
              ted.updateSettings({
                sleepIdleRunsAfterMinutes: on
                  ? defaultMachineSettings.sleepIdleRunsAfterMinutes
                  : null,
              })
            }
          />
        </SettingRow>
        {settings.sleepIdleRunsAfterMinutes !== null && (
          <SettingRow setting="app.limits.sleep-idle-after">
            <Stepper
              value={settings.sleepIdleRunsAfterMinutes}
              min={sleepStep}
              max={idleRunSleepLimits.max}
              step={sleepStep}
              format={(minutes) => `${minutes} min`}
              lessLabel="End idle agents sooner"
              moreLabel="End idle agents later"
              onChange={(sleepIdleRunsAfterMinutes) =>
                ted.updateSettings({ sleepIdleRunsAfterMinutes })
              }
            />
          </SettingRow>
        )}
        <SettingRow setting="app.limits.low-priority">
          <Switch
            label="Run agents and checks at low priority"
            checked={settings.lowPriorityWork}
            onChange={(lowPriorityWork) => ted.updateSettings({ lowPriorityWork })}
          />
        </SettingRow>
      </SettingsGroup>
      {slots && (
        <p className={styles.nowLine} title={slotsDetail(slots)}>
          {nowLine(slots, simulators, emulators)}
        </p>
      )}
    </SettingsPage>
  )
}
