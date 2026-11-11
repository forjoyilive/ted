import type { Diagnostics } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { ted } from '../ted.ts'
import styles from './ResourceUsage.module.css'

export function ResourceUsage() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const next = await ted.getDiagnostics()
        if (!stopped) {
          setDiagnostics(next)
          setFailed(false)
        }
      } catch {
        if (!stopped) {
          setDiagnostics(undefined)
          setFailed(true)
        }
      } finally {
        if (!stopped) timer = setTimeout(refresh, 2_000)
      }
    }
    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])

  const cpu = diagnostics?.processes.reduce((total, process) => total + process.cpuPercent, 0)
  const memory = diagnostics?.processes.reduce((total, process) => total + process.memoryBytes, 0)

  return (
    <section
      className={styles.usage}
      aria-label="Developer resource usage"
      title="Daemon-owned processes and Run process trees, not the Electron app or all system usage. Refreshes every two seconds. CPU can exceed 100% across cores."
    >
      {cpu !== undefined && memory !== undefined
        ? `CPU ${Math.round(cpu * 10) / 10}% · Memory ${(memory / 1024 ** 2).toFixed(0)} MB`
        : failed
          ? 'CPU / Memory unavailable'
          : 'CPU / Memory reading…'}
    </section>
  )
}
