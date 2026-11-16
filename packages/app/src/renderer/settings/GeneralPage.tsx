import {
  type Appearance,
  type QuitChoice,
  terminalFontSizes,
  textSizeLimits,
} from '@ted/protocol/settings'
import { systemTimeZone } from '@ted/protocol/time'
import { useState } from 'react'
import type { LoginItemState } from '../../login-item.ts'
import { PersonAvatar } from '../components/Avatar.tsx'
import { useEventValue } from '../data.ts'
import { useOvernightChange } from '../overnight.tsx'
import { useProfile } from '../profile.tsx'
import { useNow } from '../requests.ts'
import { ted } from '../ted.ts'
import { formatTime } from '../time.ts'
import { AboutGroup, CommandLineGroup } from './CommandLineGroup.tsx'
import {
  Button,
  Segmented,
  Select,
  SettingRow,
  SettingsGroup,
  SettingsPage,
  Stepper,
  Switch,
} from './controls.tsx'
import { EditorRow } from './EditorRow.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './settings.module.css'

const appearanceOptions: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const quitOptions: { value: QuitChoice; label: string }[] = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'keep-running', label: 'Keep running in the background' },
  { value: 'stop', label: 'Stop it and quit' },
]

const onLinux = navigator.userAgent.includes('Linux')

const fontSizeOptions = Array.from(
  { length: terminalFontSizes.max - terminalFontSizes.min + 1 },
  (_, i) => {
    const size = terminalFontSizes.min + i
    return { value: size, label: String(size) }
  },
)

function useLoginItem(): LoginItemState | undefined {
  return useEventValue<LoginItemState | undefined>({
    initial: undefined,
    load: ted.loginItem,
    focus: true,
    event: (event) => (event.type === 'login-item' ? () => event.state : undefined),
  }).value
}

function loginItemNote(state: LoginItemState | undefined): string | undefined {
  if (state === 'requires-approval') return 'Allow Ted in System Settings → Login Items'
  if (state === 'unavailable') return 'Works only in an installed copy of Ted.'
  return undefined
}

export function GeneralPage({ settings }: SettingsPageProps) {
  const overnight = useOvernightChange()
  const now = useNow()
  const systemZone = systemTimeZone()
  const zones = [...new Set([systemZone, 'UTC', ...(Intl.supportedValuesOf?.('timeZone') ?? [])])]
  const { name } = useProfile()
  const loginItem = useLoginItem()
  const loginNote = settings.startAtLogin ? loginItemNote(loginItem) : undefined
  const [problem, setProblem] = useState<string>()
  const picture = settings.profilePicture ?? undefined

  const choosePicture = () => {
    setProblem(undefined)
    return ted.chooseProfilePicture().catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : String(error))
    })
  }

  return (
    <SettingsPage title="General">
      <SettingsGroup setting="app.general.profile">
        <SettingRow
          setting="app.general.profile.picture"
          leading={<PersonAvatar name={name} photo={picture} size={32} />}
          {...(problem !== undefined && { detail: problem })}
        >
          <Button onClick={choosePicture}>Change…</Button>
          <Button
            onClick={() => ted.updateSettings({ profilePicture: null })}
            disabled={picture === undefined}
          >
            Remove
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup setting="app.general.display">
        <SettingRow setting="app.general.display.appearance">
          <Segmented
            label="Appearance"
            name="appearance"
            value={settings.appearance}
            options={appearanceOptions}
            onChange={(appearance) => ted.updateSettings({ appearance })}
          />
        </SettingRow>
        <SettingRow setting="app.general.display.text-size">
          <Stepper
            value={settings.textSize}
            min={textSizeLimits.min}
            max={textSizeLimits.max}
            step={textSizeLimits.step}
            format={(value) => `${value}%`}
            lessLabel="Decrease text size"
            moreLabel="Increase text size"
            onChange={(textSize) => ted.updateSettings({ textSize })}
          />
          <Button
            disabled={settings.textSize === 100}
            onClick={() => ted.updateSettings({ textSize: 100 })}
          >
            Default
          </Button>
        </SettingRow>
        <SettingRow setting="app.general.display.terminal-font-size" labelFor="terminal-font-size">
          <Select
            id="terminal-font-size"
            value={settings.terminalFontSize}
            options={fontSizeOptions}
            width={80}
            onChange={(terminalFontSize) => ted.updateSettings({ terminalFontSize })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup setting="app.general.date-and-time">
        <SettingRow setting="app.general.date-and-time.time-format">
          <Segmented
            label="Time format"
            name="time-format"
            value={settings.timeFormat}
            options={[
              { value: 'system', label: 'System' },
              { value: '12-hour', label: '12-hour' },
              { value: '24-hour', label: '24-hour' },
            ]}
            onChange={(timeFormat) => ted.updateSettings({ timeFormat })}
          />
        </SettingRow>
        <SettingRow setting="app.general.date-and-time.time-zone" labelFor="time-zone">
          <Select
            id="time-zone"
            value={settings.timeZone}
            options={[
              { value: 'system', label: `System · ${systemZone}` },
              ...[
                ...new Set([
                  ...zones,
                  ...(settings.timeZone === 'system' ? [] : [settings.timeZone]),
                ]),
              ].map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') })),
            ]}
            onChange={(timeZone) => ted.updateSettings({ timeZone })}
            width={265}
          />
        </SettingRow>
        <SettingRow
          setting="app.general.date-and-time.current-time"
          detail={`${settings.timeZone === 'system' ? 'Following system' : 'Fixed zone'} · ${settings.timeZone === 'system' ? systemZone : settings.timeZone}`}
        >
          <output>{formatTime(new Date(now))}</output>
        </SettingRow>
        <p className={styles.timeNote}>
          Automations keep their scheduled clock times when the zone changes. Choose a fixed zone to
          keep schedules in that zone when you travel.
        </p>
      </SettingsGroup>

      <SettingsGroup setting="app.general.autopilot">
        <SettingRow
          setting="app.general.autopilot.mode"
          {...(overnight.problem !== undefined && { detail: overnight.problem })}
        >
          <Switch
            label="Autopilot across all Factories"
            checked={settings.overnightMode}
            disabled={overnight.saving}
            onChange={(enabled) => overnight.change(enabled)}
          />
        </SettingRow>
        <SettingRow setting="app.general.autopilot.unvetted">
          <Switch
            label="Review Tasks from Automations and public issues"
            checked={settings.reviewUnvettedTasks}
            onChange={(reviewUnvettedTasks) => ted.updateSettings({ reviewUnvettedTasks })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup setting="app.general.startup">
        <SettingRow
          setting="app.general.startup.login"
          {...(loginNote !== undefined && { detail: loginNote })}
        >
          {loginItem === 'requires-approval' && settings.startAtLogin && (
            <Button onClick={() => ted.openLoginItemsSettings()}>Open System Settings</Button>
          )}
          <Switch
            label="Start Ted in the background when you log in"
            checked={settings.startAtLogin}
            onChange={(startAtLogin) => ted.updateSettings({ startAtLogin })}
          />
        </SettingRow>
        <SettingRow setting="app.general.startup.quit" labelFor="quit-with-work-running">
          <Select
            id="quit-with-work-running"
            value={settings.quitWithWorkRunning}
            options={quitOptions}
            width={240}
            onChange={(quitWithWorkRunning) => ted.updateSettings({ quitWithWorkRunning })}
          />
        </SettingRow>
        {onLinux && (
          <SettingRow setting="app.general.startup.tray">
            <Switch
              label="Show tray icon"
              checked={settings.showTrayIcon}
              onChange={(showTrayIcon) => ted.updateSettings({ showTrayIcon })}
            />
          </SettingRow>
        )}
        <SettingRow setting="app.general.startup.stay-awake">
          <Switch
            label="Stay awake while Runs are working"
            checked={settings.stayAwake}
            onChange={(stayAwake) => ted.updateSettings({ stayAwake })}
          />
        </SettingRow>
      </SettingsGroup>

      <CommandLineGroup>
        <EditorRow settings={settings} />
      </CommandLineGroup>
      <AboutGroup />
    </SettingsPage>
  )
}
