import type { MachineSettings } from '@ted/protocol'
import { useEventValue } from '../data.ts'
import { ted } from '../ted.ts'
import { Button, SettingRow, SettingsGroup, SettingsPage, Switch } from './controls.tsx'
import styles from './notifications.module.css'
import type { SettingsPageProps } from './sections.tsx'

type NotifySetting = 'notifyInboxItems' | 'notifyProblems' | 'notifyTaskMerged' | 'notifySound'

const switches: { setting: NotifySetting; title: string; help: string }[] = [
  {
    setting: 'notifyInboxItems',
    title: 'Inbox items',
    help: 'One notification per new Inbox item: Failed Tasks, permission requests, sign-offs and the idle ask. Clicking it opens the Task.',
  },
  {
    setting: 'notifyProblems',
    title: 'Problems that stop work',
    help: 'One notification when such a problem starts, never when it clears. Warnings never notify. Clicking it opens the Settings section.',
  },
  {
    setting: 'notifyTaskMerged',
    title: 'Task merged',
    help: 'One notification when a Task reaches Done. Clicking it opens the Task.',
  },
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
  title,
  help,
}: {
  settings: MachineSettings
  setting: NotifySetting
  title: string
  help: string
}) {
  return (
    <SettingRow title={title} help={help}>
      <Switch
        label={title}
        checked={settings[setting]}
        onChange={(on) => ted.updateSettings({ [setting]: on })}
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
          <Button onClick={() => ted.openNotificationSettings()}>Open System Settings</Button>
        </div>
      )}
      <SettingsGroup label="Send a notification for">
        {switches.map((row) => (
          <NotifySwitch key={row.setting} settings={settings} {...row} />
        ))}
      </SettingsGroup>
      <SettingsGroup label="Sound">
        <NotifySwitch
          settings={settings}
          setting="notifySound"
          title="Play a sound"
          help="Play the system sound with each notification."
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
