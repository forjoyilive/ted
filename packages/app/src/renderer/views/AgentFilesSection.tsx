import type { LayerKind } from '@ted/protocol'
import {
  type AgentCommand,
  type AgentFileRow,
  type AgentPower,
  type AgentSettingsInput,
  agentPowerHelp,
  agentPowerNames,
  agentPowers,
  maxAgentCommands,
} from '@ted/protocol/agent-files'
import { maxOutsideCommands } from '@ted/protocol/outside-command'
import { agentKinds } from '@ted/protocol/run'
import { type ReactNode, useId, useRef, useState } from 'react'
import {
  type AgentDraft,
  agentFileEdited,
  agentIdFrom,
  agentProblem,
  agentRecipes,
  agentRecipeText,
  newAgentDraft,
  overrideDraft,
  resolvedChoice,
} from '../agent-files.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { Button } from '../components/Button.tsx'
import {
  buttonPosition,
  ContextMenu,
  MenuItems,
  type MenuPosition,
} from '../components/ContextMenu.tsx'
import { ModelSelect } from '../components/ModelSelect.tsx'
import { AllowanceList, useAllowances } from '../components/OutsideCommands.tsx'
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
  factoryId,
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
  factoryId?: string
  rows: readonly AgentFileRow[]
  draft: readonly AgentDraft[]
  loaded: readonly AgentDraft[]
  kept: readonly string[]
  newSetting: SettingId
  onDraft: (change: (agents: AgentDraft[]) => AgentDraft[]) => void
  onKeep: (id: string) => void
}) {
  const [open, setOpen] = useState<AgentDraft>()
  const [recipeMenu, setRecipeMenu] = useState<MenuPosition>()
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
            factoryId={factoryId}
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
          aria-haspopup="menu"
          onClick={(event) => setRecipeMenu(buttonPosition(event.currentTarget))}
        >
          New Agent…
        </Button>
        <span className={styles.caption}>
          Starts from a recipe. Saved as {folder}agents.yaml and {folder}
          agents/&lt;id&gt;.md.
        </span>
        {recipeMenu && (
          <ContextMenu at={recipeMenu} label="Recipes" onClose={() => setRecipeMenu(undefined)}>
            <MenuItems
              items={agentRecipes.map((recipe) => ({
                label: agentRecipeText[recipe].name,
                hint: agentRecipeText[recipe].help,
                action: () => {
                  const own = newAgentDraft([...ids, ...draft.map((a) => a.id)], recipe)
                  onDraft((agents) => [...agents, own])
                  setOpen(own)
                },
              }))}
              choose={(item) => {
                setRecipeMenu(undefined)
                return item.action?.()
              }}
            />
          </ContextMenu>
        )}
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
        ...(row.commands && { commands: row.commands }),
      }
    : {}
}

function AgentLine({
  line,
  layer,
  folder,
  factoryId,
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
  factoryId: string | undefined
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
          factoryId={factoryId}
          problem={problem}
          onChange={(next) => onChange(own, next)}
        />
      )}
    </div>
  )
}

function CommandList({
  legend,
  what,
  active,
  commands,
  max,
  placeholder,
  hint,
  onChange,
}: {
  legend: string
  what: string
  active: boolean
  commands: readonly AgentCommand[]
  max: number
  placeholder: string
  hint: ReactNode
  onChange: (next: AgentCommand[]) => void
}) {
  const rowKeys = useRef<string[]>([])
  const nextKey = useRef(0)
  while (rowKeys.current.length < commands.length) rowKeys.current.push(`row-${nextKey.current++}`)
  rowKeys.current.length = commands.length
  const label = what.charAt(0).toUpperCase() + what.slice(1)
  const setCommand = (index: number, change: Partial<AgentCommand>) =>
    onChange(commands.map((c, i) => (i === index ? { ...c, ...change } : c)))
  return (
    <fieldset className={`${styles.commandList} ${active ? '' : styles.dimmed}`}>
      <legend className={base.label}>{legend}</legend>
      <p className={styles.hint}>{hint}</p>
      {commands.map((command, index) => (
        <div key={rowKeys.current[index]} className={styles.command}>
          <input
            aria-label={`${label} ${index + 1} name`}
            className={`${base.input} ${base.mono}`}
            value={command.name}
            placeholder="test"
            spellCheck={false}
            onChange={(event) => setCommand(index, { name: event.target.value })}
          />
          <input
            aria-label={`${label} ${index + 1}`}
            className={`${base.input} ${base.mono}`}
            value={command.command}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(event) => setCommand(index, { command: event.target.value })}
          />
          <ActionButton
            type="button"
            className={base.link}
            aria-label={`Remove ${what} ${index + 1}`}
            onClick={() => {
              rowKeys.current.splice(index, 1)
              onChange(commands.filter((_, i) => i !== index))
            }}
          >
            Remove
          </ActionButton>
        </div>
      ))}
      <div>
        <Button
          disabled={commands.length >= max}
          onClick={() => onChange([...commands, { name: '', command: '' }])}
        >
          {`Add ${what}`}
        </Button>
      </div>
    </fieldset>
  )
}

function AllowedAlways({
  factoryId,
  agentId,
  className,
}: {
  factoryId: string
  agentId: string
  className: string | undefined
}) {
  const { value, refresh } = useAllowances(factoryId)
  if (!value.some((a) => a.agentId === agentId)) return null
  return (
    <div className={className}>
      <span className={base.label}>Allowed always on this Mac</span>
      <p className={styles.hint}>
        These outside commands run without a card. Remove one to be asked again.
      </p>
      <AllowanceList
        factoryId={factoryId}
        agentId={agentId}
        allowances={value}
        onChange={(next) => void refresh(async () => next)}
      />
    </div>
  )
}

function AgentEditor({
  own,
  row,
  folder,
  factoryId,
  problem,
  onChange,
}: {
  own: AgentDraft
  row: AgentFileRow | undefined
  folder: string
  factoryId: string | undefined
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
    const powers = agentPowers.filter((p) => {
      if (p === power) return on
      if (p === 'run_commands' && power === 'read_code' && !on) return false
      return current.includes(p)
    })
    set({ powers })
  }
  const powers = settings.powers ?? row?.inherited?.settings.powers ?? []
  const commands = settings.commands ?? row?.inherited?.settings.commands ?? []
  const outsideCommands = settings.outsideCommands ?? row?.inherited?.settings.outsideCommands ?? []
  const runs = powers.includes('run_commands')
  const outside = powers.includes('run_outside')
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
              disabled={power === 'run_commands' && !powers.includes('read_code')}
              onChange={(event) => togglePower(power, event.target.checked)}
            />
            <span>
              <span className={styles.powerName}>{agentPowerNames[power]}</span>
              <span className={styles.hint}>{agentPowerHelp[power]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <CommandList
        legend="Commands"
        what="command"
        active={runs}
        commands={commands}
        max={maxAgentCommands}
        placeholder="pnpm test"
        hint={
          <>
            A chat runs one with <code className={base.mono}>ted agent run &lt;name&gt;</code>. TED
            runs it in the chat’s copy, after the repo’s setup and in the sandbox, with no arguments
            from the agent.
            {runs ? '' : ' Turn on Run commands in the copy to use them.'}
          </>
        }
        onChange={(next) => set({ commands: next })}
      />
      <CommandList
        legend="Outside commands"
        what="outside command"
        active={outside}
        commands={outsideCommands}
        max={maxOutsideCommands}
        placeholder="pnpm release build <version>"
        hint={
          <>
            A chat asks for one with{' '}
            <code className={base.mono}>ted agent run-outside &lt;name&gt; [argument]</code>. TED
            runs it on this Mac, outside the sandbox, in the repo’s local folder, and only after you
            click Run on its card, unless you allowed it always. Plain words only, no quotes or
            shell characters, and at most one argument slot written{' '}
            <code className={base.mono}>&lt;name&gt;</code>.
            {outside ? '' : ' Turn on Run outside commands to use them.'}
          </>
        }
        onChange={(next) => set({ outsideCommands: next })}
      />
      {factoryId !== undefined && outsideCommands.length > 0 && (
        <AllowedAlways factoryId={factoryId} agentId={own.id} className={styles.commandList} />
      )}
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
