import {
  type Appearance,
  type QuitChoice,
  terminalFontSizes,
  textSizeLimits,
} from '@ted/protocol/settings'
import { systemTimeZone } from '@ted/protocol/time'
import { useEffect, useState } from 'react'
import type { LoginItemState } from '../../login-item.ts'
import { PersonAvatar } from '../components/Avatar.tsx'
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
  const [state, setState] = useState<LoginItemState>()
  useEffect(() => {
    const load = () => void ted.loginItem().then(setState)
    load()
    window.addEventListener('focus', load)
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'login-item') setState(event.state)
    })
    return () => {
      window.removeEventListener('focus', load)
      unsubscribe()
    }
  }, [])
  return state
}

function loginItemNote(state: LoginItemState | undefined): string | undefined {
  if (state === 'requires-approval') return 'Allow TED in System Settings → Login Items'
  if (state === 'unavailable') return 'Works only in an installed copy of TED.'
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
    ted.chooseProfilePicture().catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : String(error))
    })
  }

  return (
    <SettingsPage title="General">
      <SettingsGroup label="Profile">
        <SettingRow
          title="Profile picture"
          help="Shown beside your Comments. TED keeps it on this computer only."
          leading={<PersonAvatar name={name} photo={picture} size={32} />}
          {...(problem !== undefined && { detail: problem })}
        >
          <Button onClick={choosePicture}>Change…</Button>
          <Button
            onClick={() => void ted.updateSettings({ profilePicture: null })}
            disabled={picture === undefined}
          >
            Remove
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Display">
        <SettingRow title="Appearance">
          <Segmented
            label="Appearance"
            name="appearance"
            value={settings.appearance}
            options={appearanceOptions}
            onChange={(appearance) => void ted.updateSettings({ appearance })}
          />
        </SettingRow>
        <SettingRow
          title="Text size"
          detail="Changes text throughout TED. Terminal font size is separate."
        >
          <Stepper
            value={settings.textSize}
            min={textSizeLimits.min}
            max={textSizeLimits.max}
            step={textSizeLimits.step}
            format={(value) => `${value}%`}
            lessLabel="Decrease text size"
            moreLabel="Increase text size"
            onChange={(textSize) => void ted.updateSettings({ textSize })}
          />
          <Button
            disabled={settings.textSize === 100}
            onClick={() => void ted.updateSettings({ textSize: 100 })}
          >
            Default
          </Button>
        </SettingRow>
        <SettingRow
          title="Terminal font size"
          labelFor="terminal-font-size"
          help="The size of text in terminals and logs, in points."
        >
          <Select
            id="terminal-font-size"
            value={settings.terminalFontSize}
            options={fontSizeOptions}
            width={80}
            onChange={(terminalFontSize) => void ted.updateSettings({ terminalFontSize })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Date and time">
        <SettingRow title="Time format" detail="Used throughout TED.">
          <Segmented
            label="Time format"
            name="time-format"
            value={settings.timeFormat}
            options={[
              { value: 'system', label: 'System' },
              { value: '12-hour', label: '12-hour' },
              { value: '24-hour', label: '24-hour' },
            ]}
            onChange={(timeFormat) => void ted.updateSettings({ timeFormat })}
          />
        </SettingRow>
        <SettingRow
          title="Time zone"
          labelFor="time-zone"
          detail="Used for displayed times and all Automation schedules."
        >
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
            onChange={(timeZone) => void ted.updateSettings({ timeZone })}
            width={265}
          />
        </SettingRow>
        <SettingRow
          title="Current time"
          detail={`${settings.timeZone === 'system' ? 'Following system' : 'Fixed zone'} · ${settings.timeZone === 'system' ? systemZone : settings.timeZone}`}
        >
          <output>{formatTime(new Date(now))}</output>
        </SettingRow>
        <p className={styles.timeNote}>
          Automations keep their scheduled clock times when the zone changes. Choose a fixed zone to
          keep schedules in that zone when you travel.
        </p>
      </SettingsGroup>

      <SettingsGroup label="Overnight mode">
        <SettingRow
          title="Overnight mode across all Factories"
          help="Start eligible Backlog Tasks when working slots are free, including in Factories with automatic starting off. Sign-offs set in the Workflow or on a Task are off, so Tasks move through their Stages and merge without your sign-off. Setup Tasks, Tasks that change a Factory’s settings and Clarify at grilling depth still wait for you, and so do questions and permission prompts."
          detail={
            overnight.problem ??
            'Stays on until you turn it off, on this computer only. Turning it off leaves started work running; Factory automatic starting still applies.'
          }
        >
          <Switch
            label="Overnight mode across all Factories"
            checked={settings.overnightMode}
            disabled={overnight.saving}
            onChange={(enabled) => void overnight.change(enabled)}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Startup and quitting">
        <SettingRow
          title="Start TED in the background when you log in"
          help="TED starts with no window, so notifications and Automations work. It keeps running until you choose Quit TED completely."
          {...(loginNote !== undefined && { detail: loginNote })}
        >
          {loginItem === 'requires-approval' && settings.startAtLogin && (
            <Button onClick={() => void ted.openLoginItemsSettings()}>Open System Settings</Button>
          )}
          <Switch
            label="Start TED in the background when you log in"
            checked={settings.startAtLogin}
            onChange={(startAtLogin) => void ted.updateSettings({ startAtLogin })}
          />
        </SettingRow>
        <SettingRow
          title="When you quit with work running"
          labelFor="quit-with-work-running"
          help="Work running means Runs going or Automations on. Keeping TED running in the background lets them carry on with no window open."
        >
          <Select
            id="quit-with-work-running"
            value={settings.quitWithWorkRunning}
            options={quitOptions}
            width={240}
            onChange={(quitWithWorkRunning) => void ted.updateSettings({ quitWithWorkRunning })}
          />
        </SettingRow>
        {onLinux && (
          <SettingRow
            title="Show tray icon"
            help="Shows TED’s waiting count and problems in the system tray. Some desktops, such as stock GNOME, don’t show tray icons."
          >
            <Switch
              label="Show tray icon"
              checked={settings.showTrayIcon}
              onChange={(showTrayIcon) => void ted.updateSettings({ showTrayIcon })}
            />
          </SettingRow>
        )}
        <SettingRow
          title="Stay Awake while Runs are working"
          help="Keeps this computer from going to sleep on its own while any Run is working. Automations don’t keep it awake."
        >
          <Switch
            label="Stay Awake while Runs are working"
            checked={settings.stayAwake}
            onChange={(stayAwake) => void ted.updateSettings({ stayAwake })}
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
