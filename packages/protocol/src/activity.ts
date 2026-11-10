export interface RunCounts {
  working: number
  active: number
  queued: number
}

export interface Activity {
  runs: RunCounts
  automationsOn: number
  factoriesSettingUp: number
  checksRunning: number
  checksWaiting: number
  shellsRunning: number
}

export const noActivity: Activity = {
  runs: { working: 0, active: 0, queued: 0 },
  automationsOn: 0,
  factoriesSettingUp: 0,
  checksRunning: 0,
  checksWaiting: 0,
  shellsRunning: 0,
}

export function workRunning({
  runs,
  automationsOn,
  factoriesSettingUp,
  checksRunning,
  checksWaiting,
  shellsRunning,
}: Activity): boolean {
  return (
    runs.active > 0 ||
    runs.queued > 0 ||
    automationsOn > 0 ||
    factoriesSettingUp > 0 ||
    checksRunning > 0 ||
    checksWaiting > 0 ||
    shellsRunning > 0
  )
}

export interface OpenAppResult {
  opened: boolean
}
