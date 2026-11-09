export const appearances = ['system', 'light', 'dark'] as const

export type Appearance = (typeof appearances)[number]

export const workingRunLimits = { min: 1, max: 99 } as const

export const terminalFontSizes = { min: 10, max: 20 } as const

export interface MachineSettings {
  appearance: Appearance
  terminalFontSize: number
  profilePicture: string | null
  developerMode: boolean
  maxWorkingRuns: number
}

export const defaultMachineSettings: MachineSettings = {
  appearance: 'system',
  terminalFontSize: 13,
  profilePicture: null,
  developerMode: false,
  maxWorkingRuns: 6,
}

export interface Profile {
  name: string
}
