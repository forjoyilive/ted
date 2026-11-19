import type { BacklogStarts, BacklogWait, Factory, FactoryLayout, Task } from '@ted/protocol'
import { backlogStartFactories } from '@ted/protocol/backlog-starts'
import { useState } from 'react'
import { arrange } from '../factory-layout.ts'
import { Segmented, Switch } from '../settings/controls.tsx'
import { readableError, ted } from '../ted.ts'
import styles from './BacklogStarts.module.css'
import { Button } from './Button.tsx'
import { FactoryIcon } from './FactoryIcon.tsx'

type Scope = 'all' | 'chosen'

export function backlogStartsSummary(
  starts: BacklogStarts,
  factories: readonly Factory[],
  layout: FactoryLayout,
): string {
  if (!starts.enabled) return 'Off'
  if (starts.all) return 'All Factories'
  const entries = arrange(factories, layout)
  const groupNames = entries.flatMap((entry) =>
    entry.kind === 'group' && starts.groupIds.includes(entry.group.id) ? [entry.group.name] : [],
  )
  const inGroups = new Set(
    entries.flatMap((entry) =>
      entry.kind === 'group' && starts.groupIds.includes(entry.group.id)
        ? entry.factories.map((f) => f.id)
        : [],
    ),
  )
  const factoryNames = factories.flatMap((f) =>
    starts.factoryIds.includes(f.id) && !inGroups.has(f.id) ? [f.name] : [],
  )
  const names = [...groupNames, ...factoryNames]
  if (names.length === 0) return 'No Factories chosen'
  if (names.length <= 3) return names.join(', ')
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return [
    groupNames.length > 0 && count(groupNames.length, 'group', 'groups'),
    factoryNames.length > 0 && count(factoryNames.length, 'Factory', 'Factories'),
  ]
    .filter(Boolean)
    .join(', ')
}

export function startsAutomatically(
  starts: BacklogStarts,
  layout: FactoryLayout,
): (factoryId: string) => boolean {
  const from = backlogStartFactories(starts, layout)
  return (factoryId) => from === 'all' || (from !== 'none' && from.has(factoryId))
}

export interface BacklogStartsSave {
  save: (starts: BacklogStarts) => Promise<void>
  saving: boolean
  error: string | undefined
}

export function useBacklogStartsSave(): BacklogStartsSave {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  async function save(starts: BacklogStarts) {
    setSaving(true)
    setError(undefined)
    try {
      await ted.setBacklogStarts(starts)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setSaving(false)
    }
  }
  return { save, saving, error }
}

export function BacklogStartsChoice({
  starts,
  factories,
  layout,
  disabled = false,
  onChange,
}: {
  starts: BacklogStarts
  factories: readonly Factory[]
  layout: FactoryLayout
  disabled?: boolean
  onChange: (starts: BacklogStarts) => void
}) {
  const toggle = (list: readonly string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  const factoryRow = (factory: Factory, group?: { chosen: boolean }) => (
    <label
      key={factory.id}
      className={`${styles.row} ${group ? styles.child : ''} ${group?.chosen ? styles.inGroup : ''}`}
    >
      <input
        type="checkbox"
        checked={group?.chosen === true || starts.factoryIds.includes(factory.id)}
        disabled={disabled || group?.chosen === true}
        onChange={() => onChange({ ...starts, factoryIds: toggle(starts.factoryIds, factory.id) })}
      />
      <FactoryIcon factory={factory} size={16} />
      <span className={styles.name}>{factory.name}</span>
      {group?.chosen === true && <span className={styles.note}>In group</span>}
    </label>
  )
  return (
    <div className={`${styles.choice} ${disabled ? styles.disabled : ''}`}>
      <Segmented<Scope>
        label="Start from"
        name="backlog-starts-scope"
        value={starts.all ? 'all' : 'chosen'}
        options={[
          { value: 'all', label: 'All Factories' },
          { value: 'chosen', label: 'Chosen Factories' },
        ]}
        disabled={disabled}
        onChange={(scope) => onChange({ ...starts, all: scope === 'all' })}
      />
      {starts.all ? (
        <p className={styles.caption}>Every Factory, including ones you add later.</p>
      ) : (
        <div className={styles.list}>
          {arrange(factories, layout).map((entry) => {
            if (entry.kind === 'factory') return factoryRow(entry.factory)
            const chosen = starts.groupIds.includes(entry.group.id)
            return (
              <fieldset
                key={entry.group.id}
                className={styles.groupSet}
                aria-label={entry.group.name}
              >
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    checked={chosen}
                    disabled={disabled}
                    onChange={() =>
                      onChange({ ...starts, groupIds: toggle(starts.groupIds, entry.group.id) })
                    }
                  />
                  <span className={styles.groupName}>{entry.group.name}</span>
                  <span className={styles.note}>Includes Factories added later</span>
                </label>
                {entry.factories.map((factory) => factoryRow(factory, { chosen }))}
              </fieldset>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function BacklogStartsDot({ on }: { on: boolean }) {
  return <span className={`${styles.dot} ${on ? styles.on : ''}`} aria-hidden="true" />
}

export function BacklogStartsMenu({
  starts,
  factories,
  layout,
  onOpenSettings,
}: {
  starts: BacklogStarts
  factories: readonly Factory[]
  layout: FactoryLayout
  onOpenSettings?: (() => void) | undefined
}) {
  const { save, saving, error } = useBacklogStartsSave()
  return (
    <div className={styles.menu}>
      <div className={styles.menuTop}>
        <span>Start Backlog Tasks automatically</span>
        <Switch
          label="Start Backlog Tasks automatically"
          checked={starts.enabled}
          disabled={saving}
          onChange={(enabled) => save({ ...starts, enabled })}
        />
      </div>
      <div className={styles.menuOption}>
        <span>{includeLabel}</span>
        <Switch
          label={includeLabel}
          checked={starts.includeAgentFiled}
          disabled={saving || !starts.enabled}
          onChange={(includeAgentFiled) => save({ ...starts, includeAgentFiled })}
        />
      </div>
      <div className={styles.menuOption}>
        <span>{includeIssuesLabel}</span>
        <Switch
          label={includeIssuesLabel}
          checked={starts.includeGitHubIssues}
          disabled={saving || !starts.enabled}
          onChange={(includeGitHubIssues) => save({ ...starts, includeGitHubIssues })}
        />
      </div>
      {error !== undefined && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
      <BacklogStartsChoice
        starts={starts}
        factories={factories}
        layout={layout}
        disabled={saving}
        onChange={save}
      />
      {onOpenSettings !== undefined && (
        <div className={styles.menuFoot}>
          <Button variant="quiet" onClick={onOpenSettings}>
            Open in Settings
          </Button>
        </div>
      )}
    </div>
  )
}

export function startsOnItsOwn(task: Task, startsIn: (factoryId: string) => boolean): boolean {
  return (
    task.stage === 'backlog' &&
    task.archived === undefined &&
    task.setup === undefined &&
    task.snoozedUntil === undefined &&
    task.openBlockers === undefined &&
    !task.statuses.includes('stopped') &&
    !task.statuses.includes('failed') &&
    task.backlogWait === undefined &&
    startsIn(task.factoryId)
  )
}

export function backlogStatus(
  task: Task,
  startsIn: (factoryId: string) => boolean,
): { label: string; hint?: string } | undefined {
  if (task.backlogWait !== undefined) return backlogWaitText[task.backlogWait]
  return startsOnItsOwn(task, startsIn) ? { label: 'Starts automatically' } : undefined
}

const includeLabel = 'Include agent-filed Tasks'
const includeIssuesLabel = 'Include Tasks from GitHub issues'
const includeHint = (label: string) => `Turn on “${label}” or start it yourself.`

const backlogWaitText: Record<BacklogWait, { label: string; hint: string }> = {
  'task-lead': { label: 'Filed by a Task Lead', hint: includeHint(includeLabel) },
  automation: { label: 'From an Automation', hint: includeHint(includeIssuesLabel) },
  'follow-up': {
    label: 'Follow-up of a follow-up',
    hint: 'Agents’ follow-ups of follow-ups always start by hand.',
  },
  'start-failed': { label: 'Auto-start failed', hint: 'Start it yourself to see the error.' },
  repo: { label: 'Waiting for the repo', hint: 'Ted is still cloning this Factory’s repo.' },
}
