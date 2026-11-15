import type { GitHubIntakeScope } from '@ted/protocol'
import { memo, useEffect, useId, useState } from 'react'
import { Select } from '../components/Select.tsx'
import { useSettings } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import styles from './FactorySettings.module.css'

const maxLabelLength = 50

export const GitHubIntakeSection = memo(function GitHubIntakeSection({
  factoryId,
}: {
  factoryId: string
}) {
  const settings = useSettings()
  const saved = settings?.githubIntakeScopes[factoryId]?.label
  const [draftKind, setDraftKind] = useState<'any' | 'label'>()
  const kind = draftKind ?? (saved === undefined ? 'any' : 'label')
  const [label, setLabel] = useState(saved ?? '')
  const [saveError, setSaveError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const id = useId()
  useEffect(() => setLabel(saved ?? ''), [saved])

  async function save(next: GitHubIntakeScope | null) {
    setSaving(true)
    setSaveError(undefined)
    try {
      await ted.setFactoryGitHubIntake(factoryId, next)
      setDraftKind(undefined)
    } catch (failure) {
      setSaveError(readableError(failure))
    } finally {
      setSaving(false)
    }
  }

  function saveLabel() {
    const trimmed = label.trim()
    setLabel(trimmed)
    if (trimmed === '' || trimmed === saved) return
    void save({ label: trimmed })
  }

  return (
    <section className={styles.section} aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className={styles.groupLabel} data-setting="factory.intake.github">
        GitHub
      </h3>
      <span className={styles.caption}>
        Choose which GitHub issues Automations can bring into this Factory. TED checks each issue
        itself. Tasks you create yourself aren’t affected.
      </span>
      <div className={styles.field} data-setting="factory.intake.github.scope">
        <label className={styles.label} htmlFor={`${id}-kind`}>
          Issues Automations can bring in
        </label>
        <Select
          fullWidth
          id={`${id}-kind`}
          controlClassName={styles.select}
          value={kind}
          disabled={!settings || saving}
          onChange={(event) => {
            const value = event.target.value
            if (value !== 'any' && value !== 'label') return
            setDraftKind(value)
            setSaveError(undefined)
            if (value === 'any') void save(null)
          }}
        >
          <option value="any">Any open issue</option>
          <option value="label">Only issues with this label</option>
        </Select>
      </div>
      {kind === 'label' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-label`}>
            Label
          </label>
          <input
            id={`${id}-label`}
            className={styles.input}
            value={label}
            maxLength={maxLabelLength}
            placeholder="ready for TED"
            disabled={!settings || saving}
            onChange={(event) => setLabel(event.target.value)}
            onBlur={saveLabel}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setLabel(saved ?? '')
            }}
          />
          <span className={styles.caption}>
            {saved === undefined
              ? 'Type the label a maintainer adds to issues TED may take. Nothing is saved until you do.'
              : `Automations bring in only open issues labelled “${saved}”.`}
          </span>
        </div>
      )}
      {saveError !== undefined && (
        <p className={styles.fieldError} role="alert">
          {saveError}
        </p>
      )}
    </section>
  )
})
