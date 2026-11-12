import type { MachineSettings } from '@ted/protocol'
import type { ComponentType } from 'react'
import type { NavigationAction, SettingsSectionId } from '../navigation.ts'
import { AgentsPage } from './AgentsPage.tsx'
import { SettingsPage } from './controls.tsx'
import { DeveloperPage } from './DeveloperPage.tsx'
import { GeneralPage } from './GeneralPage.tsx'
import { IntegrationsPage } from './IntegrationsPage.tsx'
import { LibraryPage } from './LibraryPage.tsx'
import { LimitsPage } from './LimitsPage.tsx'
import { MachinesPage } from './MachinesPage.tsx'
import { NotificationsPage } from './NotificationsPage.tsx'
import { StoragePage } from './StoragePage.tsx'
import styles from './settings.module.css'

export interface SettingsPageProps {
  settings: MachineSettings
  dispatch: (action: NavigationAction) => void
}

export interface SettingsSection {
  id: SettingsSectionId
  label: string
  Page?: ComponentType<SettingsPageProps>
}

export function NotBuiltYet({ title }: { title: string }) {
  return (
    <SettingsPage title={title}>
      <p className={styles.notBuilt}>Not built yet.</p>
    </SettingsPage>
  )
}

export const settingsSections: readonly SettingsSection[] = [
  { id: 'general', label: 'General', Page: GeneralPage },
  { id: 'notifications', label: 'Notifications', Page: NotificationsPage },
  { id: 'machines', label: 'Machines', Page: MachinesPage },
  { id: 'agents', label: 'Agents', Page: AgentsPage },
  { id: 'limits', label: 'Limits', Page: LimitsPage },
  { id: 'integrations', label: 'Integrations', Page: IntegrationsPage },
  { id: 'library', label: 'Library', Page: LibraryPage },
  { id: 'storage', label: 'Storage', Page: StoragePage },
  { id: 'developer', label: 'Developer', Page: DeveloperPage },
]
