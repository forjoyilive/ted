import { createContext, useContext, useState } from 'react'
import { readableError, ted } from './ted.ts'
import base from './views/FactorySettings.module.css'
import sections from './views/FactorySettingsSections.module.css'

export function useOvernightChange() {
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  async function change(overnightMode: boolean) {
    if (saving) return
    setSaving(true)
    setProblem(undefined)
    try {
      await ted.updateSettings({ overnightMode })
    } catch (error) {
      setProblem(readableError(error))
    } finally {
      setSaving(false)
    }
  }
  return { saving, problem, change }
}

export const OvernightContext = createContext<{ on: boolean; openGeneral: () => void }>({
  on: false,
  openGeneral: () => {},
})

export function OvernightNotice() {
  const { on, openGeneral } = useContext(OvernightContext)
  if (!on) return null
  return (
    <p className={sections.warning} role="status" aria-label="Autopilot is on">
      <span className={sections.warnMark} aria-hidden>
        ▲
      </span>{' '}
      Autopilot is on. Sign-Offs set here are off until you turn it off in{' '}
      <button type="button" className={base.link} onClick={openGeneral}>
        Settings → General
      </button>
      . Setup Tasks and Tasks that change a Factory’s settings still wait for you.
    </p>
  )
}
