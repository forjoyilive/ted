import type { MachineSettings } from '@ted/protocol'
import type { ComponentType } from 'react'
import type { SettingsSectionId } from '../navigation.ts'
import { AgentsPage } from './AgentsPage.tsx'
import { SettingsPage } from './controls.tsx'
import { DeveloperPage } from './DeveloperPage.tsx'
import { GeneralPage } from './GeneralPage.tsx'
import { IntegrationsPage } from './IntegrationsPage.tsx'
import styles from './settings.module.css'

export interface SettingsPageProps {
  settings: MachineSettings
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
  { id: 'notifications', label: 'Notifications' },
  { id: 'agents', label: 'Agents', Page: AgentsPage },
  { id: 'limits', label: 'Limits' },
  { id: 'integrations', label: 'Integrations', Page: IntegrationsPage },
  { id: 'library', label: 'Library' },
  { id: 'storage', label: 'Storage' },
  { id: 'developer', label: 'Developer', Page: DeveloperPage },
]
