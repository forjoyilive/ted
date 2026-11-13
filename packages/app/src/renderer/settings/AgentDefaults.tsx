import type {
  AgentChoiceInput,
  AgentRole,
  Effort,
  LibraryAgentRow,
  LibraryView,
} from '@ted/protocol'
import { useState } from 'react'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { Button } from '../components/Button.tsx'
import { Skeleton } from '../components/Loading.tsx'
import { ModelSelect } from '../components/ModelSelect.tsx'
import { Select } from '../components/Select.tsx'
import { useEventValue } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import sections from '../views/FactorySettingsSections.module.css'
import { FromChip } from '../views/FactorySettingsSections.tsx'
import styles from './AgentsPage.module.css'
import { SettingRow, SettingsGroup } from './controls.tsx'

const roleNames: Record<AgentRole, string> = {
  lead: 'Task Lead',
  reviewer: 'Reviewer',
  planner: 'Planner',
}
const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export function AgentDefaults() {
  const [saveError, setSaveError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const {
    value: view,
    update,
    refresh,
    error: loadError,
  } = useEventValue<LibraryView | undefined>({
    initial: undefined,
    load: ted.library,
    event: (event) =>
      event.type === 'library-changed' || event.type === 'settings-changed' ? 'reload' : undefined,
  })
  const error = saveError ?? loadError

  async function save(role: AgentRole, choice: AgentChoiceInput | null) {
    if (!view) return
    setBusy(true)
    setSaveError(undefined)
    try {
      const saved = await ted.saveLibrary({
        changes: { agents: { [role]: choice } },
        version: view.version,
      })
      update(() => saved)
    } catch (failure) {
      setSaveError(readableError(failure))
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup setting="app.agents.defaults">
      {!view && !error && (
        <Skeleton shape="settings" framed={false} label="Loading agent defaults…" />
      )}
      {view?.agents.map((row) => (
        <AgentDefault
          key={`${row.role}:${view.version}`}
          row={row}
          busy={busy}
          onChange={(choice) => save(row.role, choice)}
        />
      ))}
      {view?.invalid && (
        <p className={styles.line}>
          The Library’s {view.invalid.file} has an error. Fix it in Settings → Library first.
        </p>
      )}
      {error !== undefined && <p className={`${styles.line} ${styles.error}`}>{error}</p>}
    </SettingsGroup>
  )
}

function AgentDefault({
  row,
  busy,
  onChange,
}: {
  row: LibraryAgentRow
  busy: boolean
  onChange: (choice: AgentChoiceInput | null) => void
}) {
  const shown = row.own ?? row.default
  const name = roleNames[row.role]
  const update = (fields: Partial<AgentChoiceInput>) => {
    const next: AgentChoiceInput = { ...shown, ...fields }
    for (const key of ['model', 'effort'] as const) if (!next[key]) delete next[key]
    onChange(next)
  }
  return (
    <SettingRow
      title={
        <span className={styles.roleTitle}>
          {name} <span className={styles.roleKey}>{row.role}</span> <FromChip layer={row.from} />
        </span>
      }
    >
      <Select
        aria-label={`${name} agent`}
        className={`${styles.defaultSelect} ${styles.agentSelect}`}
        disabled={busy}
        value={shown.agent ?? 'claude'}
        onChange={(event) => update({ agent: event.target.value, model: '' })}
      >
        <AgentOptions current={shown.agent} same={row.role === 'reviewer'} />
      </Select>
      <ModelSelect
        aria-label={`${name} model`}
        className={`${styles.defaultSelect} ${styles.modelSelect}`}
        inputClassName={`${sections.cellInput} ${styles.modelInput}`}
        defaultLabel="default model"
        disabled={busy}
        agent={shown.agent ?? 'claude'}
        value={shown.model ?? ''}
        onChange={(model) => update({ model })}
      />
      <Select
        aria-label={`${name} effort`}
        className={styles.defaultSelect}
        disabled={busy}
        value={shown.effort ?? ''}
        onChange={(event) => {
          const effort = efforts.find((e) => e === event.target.value)
          if (effort !== undefined) update({ effort })
          else {
            const { effort: _, ...rest } = shown
            onChange(rest)
          }
        }}
      >
        <option value="">default effort</option>
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </Select>
      {row.from === 'library' && (
        <Button
          size="small"
          className={styles.resetButton}
          disabled={busy}
          onClick={() => onChange(null)}
        >
          Reset to TED default
        </Button>
      )}
    </SettingRow>
  )
}
