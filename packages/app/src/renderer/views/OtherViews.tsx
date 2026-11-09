import type { Appearance, QuitChoice } from '@ted/protocol'
import type { ReactNode } from 'react'
import { Help } from '../components/Help.tsx'
import { useSettings } from '../data.ts'
import { ted } from '../ted.ts'
import styles from './views.module.css'

export function Inbox() {
  return (
    <>
      <section className={`${styles.pane} ${styles.listPane}`} aria-label="Inbox">
        <header className={`${styles.header} ${styles.listHeader}`}>
          <h1 className={styles.listTitle}>Inbox</h1>
          <Help>
            Questions and sign-offs from agents that need your answer, from every Factory.
          </Help>
        </header>
        <p className={styles.empty}>Nothing is waiting on you.</p>
      </section>
      <section className={styles.pane} aria-label="Nothing open" />
    </>
  )
}

export function Stub({ title, banners }: { title: string; banners?: ReactNode }) {
  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </header>
      {banners}
      <p className={styles.empty}>Not built yet.</p>
    </section>
  )
}

const appearanceLabels: Record<Appearance, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const appearances = Object.keys(appearanceLabels) as Appearance[]

const quitChoiceLabels: Record<QuitChoice, string> = {
  ask: 'Ask each time',
  'keep-running': 'Keep running in the background',
  stop: 'Stop it and quit',
}

const quitChoices = Object.keys(quitChoiceLabels) as QuitChoice[]

const onLinux = navigator.userAgent.includes('Linux')

export function AppSettings() {
  const settings = useSettings()

  return (
    <section className={styles.pane} aria-label="Settings">
      <header className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
      </header>
      <div className={styles.settings}>
        <div className={styles.settingRow}>
          <span id="appearance-label">Appearance</span>
          <div className={styles.segmented} role="radiogroup" aria-labelledby="appearance-label">
            {appearances.map((appearance) => (
              <label key={appearance} className={styles.segment}>
                <input
                  type="radio"
                  name="appearance"
                  className={styles.radio}
                  checked={settings?.appearance === appearance}
                  onChange={() => void ted.updateSettings({ appearance })}
                />
                {appearanceLabels[appearance]}
              </label>
            ))}
          </div>
        </div>
        <div className={styles.settingRow}>
          <label htmlFor="quit-with-work-running">When you quit with work running</label>
          <select
            id="quit-with-work-running"
            className={styles.select}
            value={settings?.quitWithWorkRunning ?? 'ask'}
            onChange={(event) =>
              void ted.updateSettings({ quitWithWorkRunning: event.target.value as QuitChoice })
            }
          >
            {quitChoices.map((choice) => (
              <option key={choice} value={choice}>
                {quitChoiceLabels[choice]}
              </option>
            ))}
          </select>
        </div>
        {onLinux && (
          <div className={styles.settingRow}>
            <label htmlFor="show-tray-icon">Show tray icon</label>
            <input
              id="show-tray-icon"
              type="checkbox"
              className={styles.toggle}
              checked={settings?.showTrayIcon ?? true}
              onChange={(event) => void ted.updateSettings({ showTrayIcon: event.target.checked })}
            />
          </div>
        )}
      </div>
    </section>
  )
}
