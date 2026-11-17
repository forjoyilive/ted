import type { LayerKind } from '@ted/protocol'
import {
  type AgentFileRow,
  type AgentPower,
  type AgentSettingsInput,
  agentPowerHelp,
  agentPowerNames,
  agentPowers,
} from '@ted/protocol/agent-files'
import { agentKinds } from '@ted/protocol/run'
import { useId, useState } from 'react'
import {
  type AgentDraft,
  agentFileEdited,
  agentIdFrom,
  agentProblem,
  newAgentDraft,
  overrideDraft,
  resolvedChoice,
} from '../agent-files.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { Button } from '../components/Button.tsx'
import { ModelSelect } from '../components/ModelSelect.tsx'
import { Select } from '../components/Select.tsx'
import grow from '../components/TextGrow.module.css'
import type { SettingId } from '../settings-search.ts'
import { agentLabels } from '../task-fields.ts'
import styles from './AgentFilesSection.module.css'
import base from './FactorySettings.module.css'
import sections from './FactorySettingsSections.module.css'
import { Edited, FromChip } from './FactorySettingsSections.tsx'
import { DiffLines } from './SaveSettingsDialog.tsx'

interface Line {
  id: string
  row?: AgentFileRow
  own?: AgentDraft
}

export function AgentFilesSection({
  layer,
  folder,
  rows,
  draft,
  loaded,
  kept,
  newSetting,
  onDraft,
  onKeep,
}: {
  layer: 'factory' | 'library'
  folder: string
  rows: readonly AgentFileRow[]
  draft: readonly AgentDraft[]
  loaded: readonly AgentDraft[]
  kept: readonly string[]
  newSetting: SettingId
  onDraft: (change: (agents: AgentDraft[]) => AgentDraft[]) => void
  onKeep: (id: string) => void
}) {
  const [open, setOpen] = useState<AgentDraft>()
  const lines: Line[] = [
    ...rows.flatMap((row): Line[] => {
      const own = draft.find((a) => a.id === row.id && !a.added)
      if (!own && !row.inherited) return []
      return [{ id: row.id, row, ...(own && { own }) }]
    }),
    ...draft.filter((a) => a.added).map((own): Line => ({ id: own.id, own })),
  ]
  const ids = rows.map((row) => row.id)
  const replace = (from: AgentDraft, to: AgentDraft) => {
    onDraft((agents) => agents.map((a) => (a === from ? to : a)))
    if (open === from) setOpen(to)
  }
  const remove = (own: AgentDraft) => {
    onDraft((agents) => agents.filter((a) => a !== own))
    if (open === own) setOpen(undefined)
  }
  return (
    <div className={styles.agents}>
      <div className={`${sections.table} ${styles.table}`}>
        <div className={`${styles.row} ${sections.headRow}`}>
          <span>Name</span>
          <span>Powers</span>
          <span>Provider</span>
          <span>Source</span>
          <span className={base.visuallyHidden}>Actions</span>
        </div>
        {lines.map((line) => (
          <AgentLine
            key={line.own?.added ? `new:${draft.indexOf(line.own)}` : line.id}
            line={line}
            layer={layer}
            folder={folder}
            open={line.own !== undefined && open === line.own}
            edited={agentFileEdited(draft, loaded, line.id)}
            kept={kept.includes(line.id)}
            problem={
              line.own &&
              agentProblem(
                line.own,
                line.own.added
                  ? [...ids, ...draft.filter((a) => a !== line.own).map((a) => a.id)]
                  : [],
              )
            }
            onOpen={(own) => setOpen(own)}
            onOverride={(row) => {
              const own = overrideDraft(row)
              onDraft((agents) => [...agents, own])
              setOpen(own)
            }}
            onChange={replace}
            onRemove={remove}
            onKeep={() => onKeep(line.id)}
          />
        ))}
      </div>
      <div className={styles.newRow} data-setting={newSetting}>
        <Button
          onClick={() => {
            const own = newAgentDraft([...ids, ...draft.map((a) => a.id)])
            onDraft((agents) => [...agents, own])
            setOpen(own)
          }}
        >
          New Agent…
        </Button>
        <span className={styles.caption}>
          Starts from the Blank recipe. Saved as {folder}agents.yaml and {folder}
          agents/&lt;id&gt;.md.
        </span>
      </div>
    </div>
  )
}

function shownSettings(line: Line): AgentSettingsInput {
  const inherited = line.row?.inherited?.settings
  const own = line.own?.settings
  if (line.own) {
    const { agent: _agent, model: _model, ...rest } = { ...inherited, ...own }
    return { ...rest, ...resolvedChoice(own, inherited) }
  }
  const row = line.row
  return row
    ? {
        name: row.name,
        ...(row.agent !== undefined && { agent: row.agent }),
        ...(row.model !== undefined && { model: row.model }),
        powers: row.powers,
      }
    : {}
}

function AgentLine({
  line,
  layer,
  folder,
  open,
  edited,
  kept,
  problem,
  onOpen,
  onOverride,
  onChange,
  onRemove,
  onKeep,
}: {
  line: Line
  layer: LayerKind
  folder: string
  open: boolean
  edited: boolean
  kept: boolean
  problem: string | undefined
  onOpen: (own: AgentDraft | undefined) => void
  onOverride: (row: AgentFileRow) => void
  onChange: (from: AgentDraft, to: AgentDraft) => void
  onRemove: (own: AgentDraft) => void
  onKeep: () => void
}) {
  const { row, own } = line
  const settings = shownSettings(line)
  const name = settings.name?.trim() || (own?.added ? 'New Agent' : line.id)
  const from: LayerKind = own ? layer : (row?.inherited?.layer ?? row?.from ?? layer)
  const drift = own && row?.drift && own.instructions !== null && !kept ? row.drift : undefined
  const powers = (settings.powers ?? []).map((p) => agentPowerNames[p]).join(', ')
  return (
    <div className={drift ? sections.stageDrift : open ? sections.stageOpen : sections.stageBlock}>
      <div className={styles.row}>
        <span className={sections.stageName}>
          {name}
          {drift && (
            <span className={sections.driftDot} role="img" aria-label="Inherited version changed" />
          )}{' '}
          <Edited when={edited} />
        </span>
        <span className={styles.powers}>{powers || '—'}</span>
        <span>
          {settings.agent ? agentLabels[settings.agent] : 'Default'}
          {settings.model ? ` · ${settings.model}` : ''}
        </span>
        <span>
          <FromChip layer={from} />
        </span>
        <span className={sections.actions}>
          {!own && row && (
            <ActionButton type="button" className={base.link} onClick={() => onOverride(row)}>
              Override
            </ActionButton>
          )}
          {own && (
            <ActionButton
              type="button"
              className={base.link}
              onClick={() => onOpen(open ? undefined : own)}
            >
              {open ? 'Close' : 'Edit'}
            </ActionButton>
          )}
          {own && (
            <ActionButton type="button" className={base.link} onClick={() => onRemove(own)}>
              {row?.inherited ? 'Reset to inherited' : 'Remove'}
            </ActionButton>
          )}
        </span>
      </div>
      {drift && own && (
        <section className={sections.driftBody} aria-label={`${name} drift`}>
          <p className={sections.driftLine}>
            <span className={sections.warnMark} aria-hidden>
              ▲
            </span>{' '}
            The inherited instructions changed after this override was made. Your copy is based on{' '}
            {drift.basedOn}.
          </p>
          <div className={sections.driftDiff}>
            <DiffLines lines={drift.diff} />
          </div>
          <div className={sections.driftActions}>
            <Button onClick={onKeep}>Keep mine</Button>
            <Button onClick={() => onRemove(own)}>Use inherited</Button>
          </div>
        </section>
      )}
      {open && own && (
        <AgentEditor
          own={own}
          row={row}
          folder={folder}
          problem={problem}
          onChange={(next) => onChange(own, next)}
        />
      )}
    </div>
  )
}

function AgentEditor({
  own,
  row,
  folder,
  problem,
  onChange,
}: {
  own: AgentDraft
  row: AgentFileRow | undefined
  folder: string
  problem: string | undefined
  onChange: (next: AgentDraft) => void
}) {
  const id = useId()
  const settings = own.settings ?? {}
  const set = (fields: AgentSettingsInput, clearAgent = false) => {
    const next: AgentSettingsInput = { ...settings, ...fields }
    if (clearAgent) delete next.agent
    if (!next.model) delete next.model
    onChange({ ...own, settings: next })
  }
  const togglePower = (power: AgentPower, on: boolean) => {
    const current = settings.powers ?? row?.inherited?.settings.powers ?? []
    const powers = agentPowers.filter((p) => (p === power ? on : current.includes(p)))
    set({ powers })
  }
  const powers = settings.powers ?? row?.inherited?.settings.powers ?? []
  const inherited = row?.inherited?.settings
  const resolved = resolvedChoice(settings, inherited)
  const inheritedModel = settings.model === undefined ? resolved.model : undefined
  return (
    <div className={styles.editor}>
      {own.added && (
        <div className={styles.field}>
          <label className={base.label} htmlFor={`${id}-id`}>
            Id
          </label>
          <input
            id={`${id}-id`}
            className={`${base.input} ${base.mono} ${styles.short}`}
            value={own.id}
            spellCheck={false}
            onChange={(event) => onChange({ ...own, id: event.target.value })}
          />
          <p className={styles.hint}>
            Names the Agent’s files: its entry in {folder}agents.yaml and {folder}agents/
            {own.id || '<id>'}.md. Lowercase letters, digits and hyphens.
          </p>
        </div>
      )}
      <div className={styles.field}>
        <label className={base.label} htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          className={`${base.input} ${styles.short}`}
          value={settings.name ?? ''}
          placeholder={row?.inherited?.settings.name}
          onChange={(event) => {
            const name = event.target.value
            const next: AgentDraft = { ...own, settings: { ...settings, name } }
            if (own.added && (own.id === '' || own.id.startsWith('new-agent'))) {
              next.id = agentIdFrom(name) || own.id
            }
            onChange(next)
          }}
        />
        <p className={styles.hint}>Shown in New chat and on the Agent’s Inbox requests.</p>
      </div>
      <div className={styles.twoFields}>
        <div className={styles.field}>
          <label className={base.label} htmlFor={`${id}-provider`}>
            Provider
          </label>
          <Select
            id={`${id}-provider`}
            fullWidth
            value={settings.agent ?? ''}
            onChange={(event) => {
              const agent = agentKinds.find((kind) => kind === event.target.value)
              if (agent === undefined) set({ model: '' }, true)
              else set({ agent, model: '' })
            }}
          >
            <option value="">
              {inherited?.agent ? `Inherited · ${agentLabels[inherited.agent]}` : 'Default'}
            </option>
            <AgentOptions current={settings.agent} />
          </Select>
          <p className={styles.hint}>Which Provider runs this Agent’s chats.</p>
        </div>
        <div className={styles.field}>
          <label className={base.label} htmlFor={`${id}-model`}>
            Model
          </label>
          <ModelSelect
            id={`${id}-model`}
            fullWidth
            defaultLabel={
              inheritedModel === undefined
                ? 'Provider’s default model'
                : `Inherited · ${inheritedModel}`
            }
            disabled={resolved.agent === undefined}
            agent={resolved.agent ?? 'claude'}
            value={settings.model ?? ''}
            onChange={(model) => set({ model })}
          />
          <p className={styles.hint}>
            {resolved.agent === undefined
              ? 'Pick a Provider to choose a model.'
              : 'Leave it on the default unless this Agent needs a particular model.'}
          </p>
        </div>
      </div>
      <fieldset className={styles.powerList}>
        <legend className={base.label}>Powers</legend>
        <p className={styles.hint}>
          Each power is off unless you turn it on. TED checks every action against them.
        </p>
        {agentPowers.map((power) => (
          <label key={power} className={styles.power}>
            <input
              type="checkbox"
              checked={powers.includes(power)}
              onChange={(event) => togglePower(power, event.target.checked)}
            />
            <span>
              <span className={styles.powerName}>{agentPowerNames[power]}</span>
              <span className={styles.hint}>{agentPowerHelp[power]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className={styles.field}>
        <label className={base.label} htmlFor={`${id}-instructions`}>
          Instructions
        </label>
        {own.instructions === null ? (
          <p className={styles.hint}>
            Uses the inherited instructions.{' '}
            <ActionButton
              type="button"
              className={base.link}
              onClick={() => onChange({ ...own, instructions: row?.inherited?.instructions ?? '' })}
            >
              Override instructions
            </ActionButton>
          </p>
        ) : (
          <>
            <textarea
              id={`${id}-instructions`}
              className={`${sections.fileText} ${grow.text}`}
              value={own.instructions}
              spellCheck={false}
              onChange={(event) => onChange({ ...own, instructions: event.target.value })}
            />
            <p className={styles.hint}>
              Saved as {folder}agents/{own.id || '<id>'}.md. TED puts it inside its own
              instructions, which list the commands this Agent’s powers allow.
            </p>
          </>
        )}
      </div>
      {problem !== undefined && (
        <p className={base.fieldError} role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
