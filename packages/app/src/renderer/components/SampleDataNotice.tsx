import { useEffect, useState } from 'react'
import { ted } from '../ted.ts'
import { Button } from './Button.tsx'
import styles from './SampleDataNotice.module.css'

// Shown on every screen of the sample data, so it is never mistaken for the person’s own Ted.
export function SampleDataNotice() {
  const [sample, setSample] = useState(false)
  useEffect(() => {
    let current = true
    ted.sampleData().then(
      (shown) => current && setSample(shown),
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [])
  if (!sample) return null
  return (
    <section className={styles.notice} aria-label="Sample data">
      <span className={styles.text}>
        Sample data. The Providers and GitHub here are stand-ins, and nothing you do here reaches
        your accounts.
      </span>
      <Button size="small" onClick={() => ted.quit()}>
        Set up Ted for real
      </Button>
    </section>
  )
}
