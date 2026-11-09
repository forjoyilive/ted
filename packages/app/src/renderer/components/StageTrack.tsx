import type { AgentStageId, TrackStage } from '@ted/protocol'
import { useState } from 'react'
import { Tooltip } from './Help.tsx'
import styles from './StageTrack.module.css'

const stateLabels: Record<TrackStage['state'], string> = {
  past: 'done',
  current: 'now',
  skipped: 'skipped',
  future: 'not yet',
}

const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

export function StageTrack({
  track,
  selected,
  onSelect,
}: {
  track: readonly TrackStage[]
  selected: AgentStageId | undefined
  onSelect: (stage: AgentStageId | undefined) => void
}) {
  const [hovered, setHovered] = useState<AgentStageId>()

  return (
    <ol className={styles.track} aria-label="Stage track">
      {track.map(({ stage, state }) => {
        const clickable = state === 'past' || state === 'current'
        const name = stageName(stage)
        return (
          <li key={stage} className={styles.item}>
            <button
              type="button"
              className={`${styles.segment} ${styles[state]}`}
              aria-label={`${name}, ${stateLabels[state]}`}
              aria-pressed={clickable ? selected === stage : undefined}
              aria-disabled={!clickable}
              onClick={() => {
                if (clickable) onSelect(selected === stage ? undefined : stage)
              }}
              onMouseEnter={() => setHovered(stage)}
              onMouseLeave={() => setHovered(undefined)}
              onFocus={() => setHovered(stage)}
              onBlur={() => setHovered(undefined)}
            >
              <span className={styles.bar} />
            </button>
            {hovered === stage && (
              <Tooltip className={styles.tooltip}>
                <span className={state === 'skipped' ? styles.struck : undefined}>{name}</span>
                {state === 'skipped' && ' · skipped'}
                {clickable && (selected === stage ? ' · click to show all' : ' · click to filter')}
              </Tooltip>
            )}
          </li>
        )
      })}
    </ol>
  )
}
