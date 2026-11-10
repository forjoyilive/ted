import type { Effort, LayerKind } from '@ted/protocol'
import { efforts } from '@ted/protocol/task'
import { Select } from './Select.tsx'
import styles from './StageEffort.module.css'

export function StageEffort({
  stage,
  value,
  inherited,
  source,
  onChange,
}: {
  stage: string
  value: Effort | null | undefined
  inherited?: Effort | undefined
  source?: LayerKind | undefined
  onChange: (effort: Effort | null) => void
}) {
  const layer = source === 'library' ? 'Library' : 'Task Lead default'
  return (
    <Select
      className={styles.control}
      title={
        value ?? (inherited ? `Inherit (${inherited} · ${layer})` : 'Inherit (Task Lead default)')
      }
      aria-label={`${stage} effort`}
      value={value ?? ''}
      onChange={(event) => onChange(efforts.find((e) => e === event.target.value) ?? null)}
    >
      <option value="">
        Inherit{inherited ? ` (${inherited} · ${layer})` : ' (Task Lead default)'}
      </option>
      {efforts.map((effort) => (
        <option key={effort} value={effort}>
          {effort}
        </option>
      ))}
    </Select>
  )
}
