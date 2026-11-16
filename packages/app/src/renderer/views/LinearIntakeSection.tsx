import type { LinearIntakeChoices, LinearIntakeScope } from '@ted/protocol'
import { memo, useEffect, useId, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Select } from '../components/Select.tsx'
import { useConnection, useSettings } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import styles from './FactorySettings.module.css'

export const LinearIntakeSection = memo(function LinearIntakeSection({
  factoryId,
}: {
  factoryId: string
}) {
  const settings = useSettings()
  const scope = settings?.linearIntakeScopes[factoryId]
  const [draftKind, setDraftKind] = useState<'none' | 'team' | 'project'>()
  const kind = draftKind ?? scope?.kind ?? 'none'
  const [choices, setChoices] = useState<LinearIntakeChoices>()
  const [loadError, setLoadError] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [notConnected, setNotConnected] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  const { epoch } = useConnection()
  const id = useId()
  useEffect(() => {
    void epoch
    void retry
    let live = true
    setLoading(true)
    setLoadError(undefined)
    setNotConnected(false)
    setChoices(undefined)
    void ted
      .getLinear()
      .then(async (status) => {
        if (status.state !== 'connected') return undefined
        return ted.getLinearIntakeChoices()
      })
      .then(
        (loaded) => {
          if (!live) return
          if (loaded) setChoices(loaded)
          else setNotConnected(true)
        },
        (failure: unknown) => {
          if (live) setLoadError(readableError(failure))
        },
      )
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [epoch, retry])

  async function save(next: LinearIntakeScope | null) {
    setSaving(true)
    setSaveError(undefined)
    try {
      await ted.setFactoryLinearIntake(factoryId, next)
      setDraftKind(undefined)
    } catch (failure) {
      setSaveError(readableError(failure))
      if (next === null) setDraftKind(undefined)
    } finally {
      setSaving(false)
    }
  }
  const targets = kind === 'team' ? choices?.teams : choices?.projects
  const matchesWorkspace =
    scope?.workspaceId === choices?.workspaceId && scope?.workspace === choices?.workspace
  const selected = scope?.kind === kind && matchesWorkspace ? scope.id : ''
  const missing =
    scope?.kind === kind &&
    (!matchesWorkspace || !targets?.some((target) => target.id === scope.id))
  const savedLabel = scope
    ? `${scope.kind === 'team' ? 'Team' : 'Project'}: ${scope.name} · ${scope.workspace}`
    : 'Unscoped'
  const heading = (
    <h3 id={`${id}-heading`} className={styles.groupLabel} data-setting="factory.intake.linear">
      Linear
    </h3>
  )
  if (loading || notConnected)
    return (
      <section className={styles.section} aria-labelledby={`${id}-heading`}>
        {heading}
        <span className={styles.caption}>
          Choose which Linear issues Automations can bring into this Factory.
        </span>
        <span className={styles.caption}>
          {loading
            ? 'Loading Linear teams and projects…'
            : 'Connect Linear in App Settings → Integrations to choose a Team or Project.'}
          {!loading && scope ? ` The saved scope (${savedLabel}) stays in effect.` : ''}
        </span>
      </section>
    )

  return (
    <section className={styles.section} aria-labelledby={`${id}-heading`}>
      {heading}
      <span className={styles.caption}>
        Choose which Linear issues Automations can bring into this Factory.
      </span>
      <div className={styles.field} data-setting="factory.intake.linear.scope">
        <label className={styles.label} htmlFor={`${id}-kind`}>
          Scope
        </label>
        <Select
          fullWidth
          id={`${id}-kind`}
          controlClassName={styles.select}
          value={kind}
          disabled={!settings || saving}
          onChange={(event) => {
            const value = event.target.value
            if (value !== 'none' && value !== 'team' && value !== 'project') return
            setDraftKind(value)
            setSaveError(undefined)
            if (value === 'none') save(null)
          }}
        >
          <option value="none">Unscoped</option>
          <option value="team">One team</option>
          <option value="project">One project</option>
        </Select>
      </div>
      {kind !== 'none' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-target`}>
            {kind === 'team' ? 'Team' : 'Project'}
          </label>
          <Select
            fullWidth
            id={`${id}-target`}
            controlClassName={styles.select}
            disabled={loading || saving || !choices || !settings}
            value={missing ? 'saved-unavailable' : selected}
            onChange={(event) => {
              const target = targets?.find((target) => target.id === event.target.value)
              if (!choices || !target) return
              return save({
                kind,
                id: target.id,
                name: target.name,
                workspace: choices.workspace,
                workspaceId: choices.workspaceId,
              })
            }}
          >
            <option value="">Choose a {kind === 'team' ? 'Team' : 'Project'}…</option>
            {missing && (
              <option value="saved-unavailable" disabled>
                {scope?.name} (saved; unavailable)
              </option>
            )}
            {targets?.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
                {'key' in target
                  ? ` · ${target.key}`
                  : targets.filter((other) => other.name === target.name).length > 1
                    ? ` · ${target.id.slice(0, 8)}`
                    : ''}
              </option>
            ))}
          </Select>
          {targets?.length === 0 && (
            <span className={styles.caption}>
              No accessible {kind === 'team' ? 'Teams' : 'Projects'} found.
            </span>
          )}
        </div>
      )}
      {(saving || !settings) && (
        <span className={styles.caption} role="status">
          {saving ? 'Saving…' : 'Loading saved scope…'}
        </span>
      )}
      {loadError && (
        <div>
          <p className={styles.fieldError}>{loadError} A saved scope stays in effect.</p>
          <Button onClick={() => setRetry((value) => value + 1)}>Try again</Button>
        </div>
      )}
      {saveError && (
        <p className={styles.fieldError} role="alert">
          {saveError} The saved scope stays in effect. Try selecting again.
        </p>
      )}
      <span className={styles.caption}>
        The built-in Linear Automation brings in issues assigned to you that haven’t started yet.
      </span>
      <span className={styles.caption}>
        Changes apply immediately to automatic intake. You can still paste any Linear issue into a
        new Task. Existing Tasks and status-sync consent stay as they are.
      </span>
    </section>
  )
})
