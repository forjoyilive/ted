import { type Appearance, terminalFontSizes } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { PersonAvatar } from '../components/Avatar.tsx'
import { ted } from '../ted.ts'
import { Button, Segmented, Select, SettingRow, SettingsGroup, SettingsPage } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'

const appearanceOptions: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

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
    </SettingsPage>
  )
}
