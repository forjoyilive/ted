import { ted } from '../ted.ts'
import { SettingRow, SettingsGroup, SettingsPage, Switch } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'

export function NotificationsPage({ settings }: SettingsPageProps) {
  return (
    <SettingsPage title="Notifications">
      <SettingsGroup label="Notify me about">
        <SettingRow
          title="Task merged"
          help="One notification when a Task reaches Done. Clicking it opens the Task."
        >
          <Switch
            label="Task merged"
            checked={settings.notifyTaskMerged}
            onChange={(notifyTaskMerged) => void ted.updateSettings({ notifyTaskMerged })}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
