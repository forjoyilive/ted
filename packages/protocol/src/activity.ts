export interface RunCounts {
  working: number
  active: number
  queued: number
}

export interface Activity {
  waitingOnYou: number
  runs: RunCounts
  automationsOn: number
  factoriesSettingUp: number
  checksRunning: number
  shellsRunning: number
}

export const noActivity: Activity = {
  waitingOnYou: 0,
  runs: { working: 0, active: 0, queued: 0 },
  automationsOn: 0,
  factoriesSettingUp: 0,
  checksRunning: 0,
  shellsRunning: 0,
}

export function workRunning({
  runs,
  automationsOn,
  factoriesSettingUp,
  checksRunning,
  shellsRunning,
}: Activity): boolean {
  return (
    runs.active > 0 ||
    runs.queued > 0 ||
    automationsOn > 0 ||
    factoriesSettingUp > 0 ||
    checksRunning > 0 ||
    shellsRunning > 0
  )
}

export interface OpenAppResult {
  opened: boolean
}
