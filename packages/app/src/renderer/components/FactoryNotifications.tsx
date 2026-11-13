import type { Factory, FactoryNotifications, MachineSettings } from '@ted/protocol'
import { factoryNotifications } from '@ted/protocol/settings'
import { ted } from '../ted.ts'
import styles from './FactoryNotifications.module.css'

const events: {
  key: keyof FactoryNotifications
  master: 'notifyInboxItems' | 'notifyTaskMerged'
  title: string
  help: string
}[] = [
  {
    key: 'inboxItems',
    master: 'notifyInboxItems',
    title: 'Inbox items',
    help: 'Requests that need you: questions, sign-offs, permission requests and Failed Tasks. When off, they stay in the Inbox but leave its count and the Dock badge.',
  },
  {
    key: 'taskMerged',
    master: 'notifyTaskMerged',
    title: 'Task merged',
    help: 'When a Task reaches Done.',
  },
]

function change(factoryId: string, key: keyof FactoryNotifications, on: boolean): void {
  void ted.setFactoryNotifications(factoryId, { [key]: on })
}

export function FactoryNotificationChoices({
  settings,
  factoryId,
}: {
  settings: MachineSettings
  factoryId: string
}) {
  const choices = factoryNotifications(settings, factoryId)
  return (
    <div className={styles.choices}>
      {events.map(({ key, master, title, help }) => (
        <label key={key} className={styles.choice}>
          <input
            type="checkbox"
            checked={choices[key]}
            onChange={(event) => change(factoryId, key, event.target.checked)}
          />
          <span className={styles.text}>
            <span className={styles.title}>{title}</span>
            <span className={styles.help}>{help}</span>
            {choices[key] && !settings[master] && (
              <span className={styles.note}>
                Off for every Factory in Settings → Notifications, so nothing is sent yet.
              </span>
            )}
          </span>
        </label>
      ))}
    </div>
  )
}

export function FactoryNotificationsTable({
  settings,
  factories,
}: {
  settings: MachineSettings
  factories: readonly Factory[]
}) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">Factory</th>
          {events.map(({ key, master, title }) => (
            <th key={key} scope="col" className={settings[master] ? undefined : styles.dim}>
              {title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {factories.map((factory) => {
          const choices = factoryNotifications(settings, factory.id)
          return (
            <tr key={factory.id}>
              <th scope="row">{factory.name}</th>
              {events.map(({ key, master, title }) => (
                <td key={key} className={settings[master] ? undefined : styles.dim}>
                  <input
                    type="checkbox"
                    aria-label={`${title} for ${factory.name}`}
                    checked={choices[key]}
                    onChange={(event) => change(factory.id, key, event.target.checked)}
                  />
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
