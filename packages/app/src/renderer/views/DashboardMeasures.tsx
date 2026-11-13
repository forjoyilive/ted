import styles from './Dashboard.module.css'

export const hours = (ms: number | null) =>
  ms === null
    ? 'Unavailable'
    : ms > 0 && ms < 36_000
      ? '<0.01h'
      : `${Number((ms / 3_600_000).toFixed(2))}h`

export const share = (ms: number | null, totalMs: number) => {
  if (ms === null || totalMs <= 0) return '—'
  const percent = (ms / totalMs) * 100
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`
}

export function TimingChange({
  current,
  previous,
  neutral = false,
}: {
  current: number | null
  previous: number | null
  neutral?: boolean
}) {
  const percent =
    current === null || previous === null || previous === 0
      ? null
      : ((current - previous) / previous) * 100
  const tone =
    neutral || percent === null || percent === 0 ? '' : percent < 0 ? styles.good : styles.bad
  const display =
    percent === null
      ? previous === 0
        ? 'No baseline'
        : 'Unavailable'
      : percent === 0
        ? '0%'
        : `${percent > 0 ? '+' : '−'}${Math.abs(percent) < 0.1 ? '<0.1' : Number(Math.abs(percent).toFixed(1))}%`
  return (
    <span
      className={`${styles.timingChange} ${tone}`}
      title={`Selected: ${hours(current)}; previous equal period: ${hours(previous)}. Samples and coverage may differ.`}
    >
      <strong>{display}</strong>
    </span>
  )
}

export function StatisticsHelp() {
  return (
    <details className={styles.dataTable}>
      <summary>What do these statistics mean?</summary>
      <p>
        Middle Task means median: half the measured values are at or below it, and half at or above
        it. Middle 50% is the range from the 25th to 75th percentile. It describes spread, not a
        target or confidence score.
      </p>
      <p>
        For waits of 0h, 1h, 2h, 3h and 10h, the median is 2h and the middle 50% is 1–3h. Largest
        delays show the long waits that range can hide. Small samples use interpolation; partial
        measurements may understate delay.
      </p>
    </details>
  )
}
