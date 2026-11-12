import type { MachineSettings } from '@ted/protocol'
import { useEventValue } from '../data.ts'
import { type SettingId, settingEntry } from '../settings-search.ts'
import { ted } from '../ted.ts'
import { Button, SettingRow, SettingsGroup, SettingsPage, Switch } from './controls.tsx'
import styles from './notifications.module.css'
import type { SettingsPageProps } from './sections.tsx'

type NotifySetting = 'notifyInboxItems' | 'notifyProblems' | 'notifyTaskMerged' | 'notifySound'

const switches: { setting: NotifySetting; row: SettingId }[] = [
  { setting: 'notifyInboxItems', row: 'app.notifications.send.inbox' },
  { setting: 'notifyProblems', row: 'app.notifications.send.problems' },
  { setting: 'notifyTaskMerged', row: 'app.notifications.send.merged' },
]

export function useNotificationsOff(): boolean {
  return useEventValue({
    initial: false,
    load: ted.notificationsOff,
    event: (event) => (event.type === 'notifications-off' ? () => event.off : undefined),
  }).value
}

function NotifySwitch({
  settings,
  setting,
  row,
}: {
  settings: MachineSettings
  setting: NotifySetting
  row: SettingId
}) {
  return (
    <SettingRow setting={row}>
      <Switch
        label={settingEntry(row).name}
        checked={settings[setting]}
        onChange={(on) => void ted.updateSettings({ [setting]: on })}
      />
    </SettingRow>
  )
}

export function NotificationsPage({ settings }: SettingsPageProps) {
  const off = useNotificationsOff()
  return (
    <SettingsPage
      title="Notifications"
      help="TED notifies you only when something needs you. More than 3 within a minute fold into one. Use your system’s Focus to quiet them."
    >
      {off && (
        <div className={styles.off} role="alert">
          <span className={styles.mark} aria-hidden>
            !
          </span>
          <div className={styles.text}>
            <span className={styles.title}>Notifications are off for TED in System Settings</span>
            <span className={styles.detail}>TED can’t notify you until you turn them on.</span>
          </div>
          <Button onClick={() => void ted.openNotificationSettings()}>Open System Settings</Button>
        </div>
      )}
      <SettingsGroup setting="app.notifications.send">
        {switches.map((row) => (
          <NotifySwitch key={row.setting} settings={settings} {...row} />
        ))}
      </SettingsGroup>
      <SettingsGroup setting="app.notifications.sound">
        <NotifySwitch
          settings={settings}
          setting="notifySound"
          row="app.notifications.sound.play"
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
