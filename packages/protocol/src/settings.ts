export const appearances = ['system', 'light', 'dark'] as const

export type Appearance = (typeof appearances)[number]

export const quitChoices = ['ask', 'keep-running', 'stop'] as const

export type QuitChoice = (typeof quitChoices)[number]

export interface MachineSettings {
  appearance: Appearance
  quitWithWorkRunning: QuitChoice
  showTrayIcon: boolean
}

export const defaultSettings: MachineSettings = {
  appearance: 'system',
  quitWithWorkRunning: 'ask',
  showTrayIcon: true,
}
