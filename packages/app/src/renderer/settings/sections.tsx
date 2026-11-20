import type { MachineSettings } from '@ted/protocol'
import type { ComponentType } from 'react'
import {
  type NavigationAction,
  type SettingsSectionId,
  shownSettingsSectionIds,
} from '../navigation.ts'
import { settingsPageNames } from '../settings-search.ts'
import { AgentsPage } from './AgentsPage.tsx'
import { SettingsPage } from './controls.tsx'
import { DeveloperPage } from './DeveloperPage.tsx'
import { GeneralPage } from './GeneralPage.tsx'
import { IntegrationsPage } from './IntegrationsPage.tsx'
import { LibraryPage } from './LibraryPage.tsx'
import { LimitsPage } from './LimitsPage.tsx'
import { MachinesPage } from './MachinesPage.tsx'
import { NotificationsPage } from './NotificationsPage.tsx'
import { PhonesPage } from './PhonesPage.tsx'
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

const pages: Record<SettingsSectionId, ComponentType<SettingsPageProps>> = {
  general: GeneralPage,
  notifications: NotificationsPage,
  machines: MachinesPage,
  phones: PhonesPage,
  agents: AgentsPage,
  limits: LimitsPage,
  integrations: IntegrationsPage,
  library: LibraryPage,
  storage: StoragePage,
  developer: DeveloperPage,
}

export const settingsSections: readonly SettingsSection[] = shownSettingsSectionIds.map((id) => ({
  id,
  label: settingsPageNames[id],
  Page: pages[id],
}))
