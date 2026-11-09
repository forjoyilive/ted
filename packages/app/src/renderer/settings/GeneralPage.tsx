import { type Appearance, type QuitChoice, terminalFontSizes } from '@ted/protocol/settings'
import { useEffect, useState } from 'react'
import { PersonAvatar } from '../components/Avatar.tsx'
import { ted } from '../ted.ts'
import {
  Button,
  Segmented,
  Select,
  SettingRow,
  SettingsGroup,
  SettingsPage,
  Switch,
} from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'

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

function useProfileName(): string {
  const [name, setName] = useState('')
  useEffect(() => {
    void ted.getProfile().then((profile) => setName(profile.name))
  }, [])
  return name
}

export function GeneralPage({ settings }: SettingsPageProps) {
  const name = useProfileName()
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

      <SettingsGroup label="Startup and quitting">
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
      </SettingsGroup>
    </SettingsPage>
  )
}
