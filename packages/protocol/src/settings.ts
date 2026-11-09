export const appearances = ['system', 'light', 'dark'] as const

export type Appearance = (typeof appearances)[number]

export const terminalFontSizes = { min: 10, max: 20 } as const

export const quitChoices = ['ask', 'keep-running', 'stop'] as const

export type QuitChoice = (typeof quitChoices)[number]

export interface MachineSettings {
  appearance: Appearance
  terminalFontSize: number
  profilePicture: string | null
  developerMode: boolean
  quitWithWorkRunning: QuitChoice
  showTrayIcon: boolean
}

export const defaultMachineSettings: MachineSettings = {
  appearance: 'system',
  terminalFontSize: 13,
  profilePicture: null,
  developerMode: false,
  quitWithWorkRunning: 'ask',
  showTrayIcon: true,
}

export interface Profile {
  name: string
}
