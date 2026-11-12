import type { ProcessUsage } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { ted } from '../ted.ts'
import styles from './ResourceUsage.module.css'

const refreshMs = 5_000

export function ResourceUsage() {
  const [usage, setUsage] = useState<ProcessUsage>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      timer = undefined
      if (stopped || running || document.hidden) return
      running = true
      try {
        const next = await ted.getProcessUsage()
        if (!stopped) {
          setUsage(next)
          setFailed(false)
        }
      } catch {
        if (!stopped) {
          setUsage(undefined)
          setFailed(true)
        }
      } finally {
        running = false
        if (!stopped) timer = setTimeout(refresh, refreshMs)
      }
    }
    const onVisibility = () => {
      if (!document.hidden && timer === undefined) void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <section
      className={styles.usage}
      aria-label="Developer resource usage"
      title="Daemon-owned processes and Run process trees, not the Electron app or all system usage. Refreshes every five seconds. CPU can exceed 100% across cores."
    >
      {usage
        ? `CPU ${Math.round(usage.cpuPercent * 10) / 10}% · Memory ${(usage.memoryBytes / 1024 ** 2).toFixed(0)} MB`
        : failed
          ? 'CPU / Memory unavailable'
          : 'CPU / Memory reading…'}
    </section>
  )
}
