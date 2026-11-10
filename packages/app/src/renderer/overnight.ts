import { useState } from 'react'
import { readableError, ted } from './ted.ts'

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
