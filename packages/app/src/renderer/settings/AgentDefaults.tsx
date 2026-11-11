import type {
  AgentChoiceInput,
  AgentRole,
  Effort,
  LibraryAgentRow,
  LibraryView,
} from '@ted/protocol'
import { useEffect, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Skeleton } from '../components/Loading.tsx'
import { Select } from '../components/Select.tsx'
import { useConnection } from '../data.ts'
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
  const [view, setView] = useState<LibraryView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    let active = true
    const load = () =>
      ted.library().then(
        (next) => {
          if (!active) return
          setView(next)
          setError(undefined)
        },
        (failure: unknown) => active && setError(readableError(failure)),
      )
    void load()
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'library-changed') void load()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [epoch])

  async function save(role: AgentRole, choice: AgentChoiceInput | null) {
    if (!view) return
    setBusy(true)
    setError(undefined)
    try {
      setView(
        await ted.saveLibrary({ changes: { agents: { [role]: choice } }, version: view.version }),
      )
    } catch (failure) {
      setError(readableError(failure))
      void ted.library().then(setView, () => undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup
      label="Defaults for all Factories"
      help="Saved in your Library’s workflow.yaml. A Factory can override each one in its own settings."
    >
      {!view && !error && (
        <Skeleton shape="settings" framed={false} label="Loading agent defaults…" />
      )}
      {view?.agents.map((row) => (
        <AgentDefault
          key={`${row.role}:${view.version}`}
          row={row}
          busy={busy}
          onChange={(choice) => void save(row.role, choice)}
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
  const [model, setModel] = useState(shown.model ?? '')
  const name = roleNames[row.role]
  const agents: [string, string][] =
    row.role === 'reviewer'
      ? [
          ['claude', 'Claude'],
          ['codex', 'Codex'],
          ['same', 'Same as Task Lead'],
        ]
      : [
          ['claude', 'Claude'],
          ['codex', 'Codex'],
        ]
  const update = (fields: Partial<AgentChoiceInput>) => {
    const next: AgentChoiceInput = { ...shown, ...fields }
    for (const key of ['model', 'effort'] as const) if (!next[key]) delete next[key]
    onChange(next)
  }
  const commitModel = () => {
    if (model.trim() !== (shown.model ?? '')) update({ model: model.trim() })
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
        onChange={(event) => update({ agent: event.target.value })}
      >
        {agents.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <input
        aria-label={`${name} model`}
        className={`${sections.cellInput} ${styles.modelInput}`}
        placeholder="default model"
        disabled={busy}
        value={model}
        onChange={(event) => setModel(event.target.value)}
        onBlur={commitModel}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitModel()
        }}
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
