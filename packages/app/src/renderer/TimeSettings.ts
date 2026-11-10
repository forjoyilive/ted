import { defaultMachineSettings, type MachineSettings } from '@ted/protocol/settings'
import { systemTimeZone, uses12HourTime } from '@ted/protocol/time'
import { useEffect, useLayoutEffect, useState } from 'react'
import { setTimePreferences } from './time.ts'

export function useTimeSettings(settings: MachineSettings | undefined): void {
  const [, refresh] = useState(0)
  useLayoutEffect(() => {
    setTimePreferences(settings ?? defaultMachineSettings)
    refresh((n) => n + 1)
  }, [settings])
  useEffect(() => {
    let system = `${systemTimeZone()}:${uses12HourTime(defaultMachineSettings)}`
    const timer = setInterval(() => {
      const next = `${systemTimeZone()}:${uses12HourTime(defaultMachineSettings)}`
      if (system === next) return
      system = next
      setTimePreferences(settings ?? defaultMachineSettings)
      refresh((n) => n + 1)
    }, 30_000)
    return () => clearInterval(timer)
  }, [settings])
}
