import type { AutomationRunRow, Factory, MachineSettings, Priority } from '@ted/protocol'
import {
  type AutomationRunFilters,
  type AutomationRunGroup,
  type AutomationRunKind,
  type AutomationRunSort,
  type AutomationRunStatus,
  type AutomationRunsView,
  activeRunFilters,
  automationRunGroups,
  automationRunKinds,
  automationRunSorts,
  automationRunStatuses,
  defaultAutomationRunsView,
  filterRuns,
  nextRunsSort,
  runGroup,
  runKind,
  runStatus,
  sortRuns,
} from '@ted/protocol/automation-runs-view'
import { sortDirections } from '@ted/protocol/diagnostics-sort'
import { priorities } from '@ted/protocol/task'
import { type KeyboardEvent, useState } from 'react'
import { runRowStatus } from '../automations.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { ChevronIcon, CloseIcon } from '../components/icons.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { useAutomationRunsState } from '../data.ts'
import { useNow } from '../requests.ts'
import { priorityLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from './AutomationRuns.module.css'
import list from './TaskList.module.css'
import { CheckItem, FilterIcon, MenuButton, RadioItem, Submenu } from './TaskList.tsx'
import views from './views.module.css'

const groupLabels: Record<AutomationRunGroup, string> = {
  running: 'Running',
  queued: 'Queued',
  recent: 'Recent',
}

const sortLabels: Record<AutomationRunSort, string> = {
  start: 'Start order',
  priority: 'Priority',
  automation: 'Automation',
  factory: 'Factory',
  time: 'Time',
}

const statusLabels: Record<AutomationRunStatus, string> = {
  running: 'Running',
  queued: 'Queued',
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  skipped: 'Skipped',
}

const kindLabels: Record<AutomationRunKind, string> = {
  agent: 'Automation Runs',
  check: 'Scheduled checks',
}

const priorityName = (p: Priority) => (p === 'none' ? 'No priority' : priorityLabels[p])

const toggled = <T,>(chosen: readonly T[] | undefined, value: T): T[] =>
  chosen?.includes(value) ? chosen.filter((v) => v !== value) : [...(chosen ?? []), value]

export function AutomationRuns({
  factories,
  settings,
  onOpen,
}: {
  factories: readonly Factory[]
  settings: MachineSettings | undefined
  onOpen: (row: AutomationRunRow) => void
}) {
  const state = useAutomationRunsState()
  const now = useNow()
  const [chosenView, setChosenView] = useState<AutomationRunsView>()
  const view = chosenView ?? settings?.automationRunsView ?? defaultAutomationRunsView
  const [recentOpen, setRecentOpen] = useState(false)
  const [closed, setClosed] = useState<Partial<Record<AutomationRunGroup, boolean>>>({})
  const [error, setError] = useState<string>()
  const rows = state.value ?? []
  const factoryName = (id: string) => factories.find((f) => f.id === id)?.name ?? id

  const act = async (run: () => Promise<void>) => {
    setError(undefined)
    try {
      await run()
    } catch (failure) {
      setError(readableError(failure))
    }
  }
  const change = (next: AutomationRunsView) => {
    setChosenView(next)
    void act(async () => {
      await ted.updateSettings({ automationRunsView: next })
    })
  }
  const changeFilters = (filters: AutomationRunFilters) => change({ ...view, filters })
  const runAction = (call: () => Promise<AutomationRunRow>) =>
    void act(async () => {
      await call()
      await state.retry()
    })

  const shown = sortRuns(filterRuns(rows, view.filters), view.sort, view.direction, factoryName)
  const automations = [...new Map(rows.map((r) => [r.run.automationId, r.automationName]))]
  const count = (keep: (row: AutomationRunRow) => boolean) => rows.filter(keep).length
  const isClosed = (group: AutomationRunGroup) =>
    closed[group] ?? (group === 'recent' && !recentOpen)
  const setGroup = (group: AutomationRunGroup, open: boolean) => {
    if (group === 'recent') setRecentOpen(open)
    setClosed((current) => ({ ...current, [group]: !open }))
  }

  const chips: { key: keyof AutomationRunFilters; label: string }[] = []
  const chip = (key: keyof AutomationRunFilters, name: string, labels: string[]) => {
    if (labels.length > 0) chips.push({ key, label: `${name}: ${labels.join(', ')}` })
  }
  chip('factories', 'Factory', (view.filters.factories ?? []).map(factoryName))
  chip(
    'automations',
    'Automation',
    (view.filters.automations ?? []).map(
      (id) => automations.find(([known]) => known === id)?.[1] ?? 'Removed Automation',
    ),
  )
  chip(
    'statuses',
    'Status',
    (view.filters.statuses ?? []).map((s) => statusLabels[s]),
  )
  chip('priorities', 'Priority', (view.filters.priorities ?? []).map(priorityName))
  chip(
    'kinds',
    'Kind',
    (view.filters.kinds ?? []).map((k) => kindLabels[k]),
  )
  const sorted = view.sort !== 'start' || view.direction !== 'ascending'

  const head = (label: string, sort: AutomationRunSort) => (
    <th className={list.cell} aria-sort={view.sort === sort ? view.direction : undefined}>
      <ActionButton
        type="button"
        className={`${styles.headButton} ${view.sort === sort ? styles.headActive : ''}`}
        onClick={() => change(nextRunsSort(view, sort))}
      >
        {label}
        {view.sort === sort && (
          <span aria-hidden>{view.direction === 'ascending' ? '↑' : '↓'}</span>
        )}
      </ActionButton>
    </th>
  )

  const row = (r: AutomationRunRow) => {
    const status = runRowStatus(r, now)
    const open = () => onOpen(r)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && event.target === event.currentTarget) open()
    }
    return (
      <tr
        key={r.run.id}
        className={list.row}
        tabIndex={0}
        data-nav-item
        data-automation-run={r.run.id}
        onClick={open}
        onKeyDown={onKeyDown}
      >
        <td className={`${list.cell} ${list.title}`}>
          <span className={list.titleCell}>
            <span className={list.titleText}>{r.automationName}</span>
            {r.scheduledCheck && <span className={list.archivedChip}>Scheduled check</span>}
          </span>
        </td>
        <td className={`${list.cell} ${list.meta}`}>{factoryName(r.factoryId)}</td>
        <td className={`${list.cell} ${list.meta}`}>
          <span className={styles.priority}>
            <PriorityIcon priority={r.priority} />
            {priorityName(r.priority)}
          </span>
        </td>
        <td className={`${list.cell} ${styles.status}`}>
          <span className={styles[status.tone]}>{status.text}</span>
          {status.when !== undefined && <span className={styles.when}> · {status.when}</span>}
        </td>
        <td className={`${list.cell} ${styles.actions}`}>
          {r.canStartNow && (
            <Button
              size="small"
              onClick={(event) => {
                event.stopPropagation()
                runAction(() => ted.startAutomationRunNow(r.run.id))
              }}
            >
              Start now
            </Button>
          )}
          {r.state !== 'ended' && (
            <Button
              size="small"
              onClick={(event) => {
                event.stopPropagation()
                runAction(() => ted.stopAutomationRun(r.run.id))
              }}
            >
              Stop
            </Button>
          )}
        </td>
      </tr>
    )
  }

  const body = () => {
    if (state.value === undefined) {
      return state.error === undefined ? null : (
        <EmptyState title="Couldn’t load Automation Runs" line={state.error}>
          <Button onClick={() => state.retry()}>Try again</Button>
        </EmptyState>
      )
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          title="No Automation Runs right now"
          line="Runs show here while they wait or run, and for a day after they end."
        />
      )
    }
    if (shown.length === 0) {
      return (
        <EmptyState title="No Automation Runs match these filters">
          <Button onClick={() => changeFilters({})}>Clear filters</Button>
        </EmptyState>
      )
    }
    return (
      <div className={list.body}>
        <table className={`${list.table} ${styles.table}`} aria-label="Automation Runs">
          <thead>
            <tr className={`${list.row} ${list.heads}`}>
              {head('Automation', 'automation')}
              {head('Factory', 'factory')}
              {head('Priority', 'priority')}
              {head('Status', 'time')}
              <th className={list.cell} aria-label="Actions" />
            </tr>
          </thead>
          {automationRunGroups.map((group) => {
            const inGroup = shown.filter((r) => runGroup(r) === group)
            if (inGroup.length === 0) return null
            const groupClosed = isClosed(group)
            return (
              <tbody key={group} aria-label={groupLabels[group]}>
                <tr className={list.groupRow}>
                  <th>
                    <ActionButton
                      type="button"
                      className={list.groupHead}
                      aria-expanded={!groupClosed}
                      onClick={() => setGroup(group, groupClosed)}
                    >
                      <ChevronIcon open={!groupClosed} />
                      <span className={list.groupLabel}>{groupLabels[group]}</span>
                      <span className={list.groupCount}>{inGroup.length}</span>
                    </ActionButton>
                  </th>
                </tr>
                {!groupClosed && inGroup.map(row)}
              </tbody>
            )
          })}
        </table>
      </div>
    )
  }

  return (
    <section className={`${views.pane} ${list.listPane}`} aria-label="Automation Runs">
      <header className={views.header}>
        <h1 className={views.title}>Automation Runs</h1>
        <span className={views.headerSpacer} />
        <MenuButton label="Filter" icon={<FilterIcon />} badge={activeRunFilters(view.filters)}>
          {() => (
            <>
              {factories.length > 1 && (
                <Submenu label="Factory">
                  {factories.map((f) => (
                    <CheckItem
                      key={f.id}
                      label={f.name}
                      checked={view.filters.factories?.includes(f.id) ?? false}
                      count={count((r) => r.factoryId === f.id)}
                      onChange={() =>
                        changeFilters({
                          ...view.filters,
                          factories: toggled(view.filters.factories, f.id),
                        })
                      }
                    />
                  ))}
                </Submenu>
              )}
              {automations.length > 0 && (
                <Submenu label="Automation">
                  {automations.map(([id, name]) => (
                    <CheckItem
                      key={id}
                      label={name}
                      checked={view.filters.automations?.includes(id) ?? false}
                      count={count((r) => r.run.automationId === id)}
                      onChange={() =>
                        changeFilters({
                          ...view.filters,
                          automations: toggled(view.filters.automations, id),
                        })
                      }
                    />
                  ))}
                </Submenu>
              )}
              <Submenu label="Status">
                {automationRunStatuses.map((status) => (
                  <CheckItem
                    key={status}
                    label={statusLabels[status]}
                    checked={view.filters.statuses?.includes(status) ?? false}
                    count={count((r) => runStatus(r) === status)}
                    onChange={() =>
                      changeFilters({
                        ...view.filters,
                        statuses: toggled(view.filters.statuses, status),
                      })
                    }
                  />
                ))}
              </Submenu>
              <Submenu label="Priority">
                {priorities.map((priority) => (
                  <CheckItem
                    key={priority}
                    label={priorityName(priority)}
                    icon={<PriorityIcon priority={priority} />}
                    checked={view.filters.priorities?.includes(priority) ?? false}
                    count={count((r) => r.priority === priority)}
                    onChange={() =>
                      changeFilters({
                        ...view.filters,
                        priorities: toggled(view.filters.priorities, priority),
                      })
                    }
                  />
                ))}
              </Submenu>
              <Submenu label="Kind">
                {automationRunKinds.map((kind) => (
                  <CheckItem
                    key={kind}
                    label={kindLabels[kind]}
                    checked={view.filters.kinds?.includes(kind) ?? false}
                    count={count((r) => runKind(r) === kind)}
                    onChange={() =>
                      changeFilters({ ...view.filters, kinds: toggled(view.filters.kinds, kind) })
                    }
                  />
                ))}
              </Submenu>
              {activeRunFilters(view.filters) > 0 && (
                <>
                  <div className={list.menuDivider} />
                  <ActionButton
                    type="button"
                    role="menuitem"
                    className={list.menuItem}
                    onClick={() => changeFilters({})}
                  >
                    <span className={list.menuLabel}>Clear filters</span>
                  </ActionButton>
                </>
              )}
            </>
          )}
        </MenuButton>
        <MenuButton
          label={`${sortLabels[view.sort]} ${view.direction === 'ascending' ? '↑' : '↓'}`}
          icon={<SortIcon />}
        >
          {() => (
            <>
              <div className={list.menuHeading}>Sort by</div>
              {automationRunSorts.map((sort) => (
                <RadioItem
                  key={sort}
                  label={sortLabels[sort]}
                  checked={view.sort === sort}
                  onChange={() => change({ ...view, sort })}
                />
              ))}
              <div className={list.menuDivider} />
              <div className={list.menuHeading}>Direction</div>
              <fieldset className={list.segments} aria-label="Direction">
                {sortDirections.map((direction) => (
                  <ActionButton
                    key={direction}
                    type="button"
                    role="menuitemradio"
                    aria-checked={view.direction === direction}
                    className={list.segment}
                    onClick={() => change({ ...view, direction })}
                  >
                    {direction === 'ascending' ? '↑ Ascending' : '↓ Descending'}
                  </ActionButton>
                ))}
              </fieldset>
            </>
          )}
        </MenuButton>
      </header>
      {(chips.length > 0 || sorted || error !== undefined) && (
        <div className={list.toolbar}>
          {chips.map((c) => (
            <span key={c.key} className={list.chip}>
              {c.label}
              <ActionButton
                type="button"
                className={list.chipClear}
                aria-label={`Clear ${c.label}`}
                onClick={() => {
                  const { [c.key]: _, ...rest } = view.filters
                  changeFilters(rest)
                }}
              >
                <CloseIcon size={10} />
              </ActionButton>
            </span>
          ))}
          {sorted && (
            <span className={list.plainChip}>
              Sort: {sortLabels[view.sort]}, {view.direction}
            </span>
          )}
          {error !== undefined && (
            <span className={styles.error} role="alert">
              {error}
            </span>
          )}
        </div>
      )}
      {body()}
    </section>
  )
}

function SortIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
      <path
        d="M5 3v10M2.5 10.5 5 13l2.5-2.5M11 13V3M8.5 5.5 11 3l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
