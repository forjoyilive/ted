export const appearances = ['system', 'light', 'dark'] as const

export type Appearance = (typeof appearances)[number]

export interface MachineSettings {
  appearance: Appearance
}
